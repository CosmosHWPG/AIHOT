// Native Windows supervisor. Only the project-specific named pipe can request a graceful shutdown.
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { launchDetached, loadLaunchEnvironment } from "./corescope-runtime-launch.ts";

const root = path.resolve(import.meta.dirname, "..");
const runtime = path.join(root, ".data/runtime");
const logs = path.join(root, ".data/logs");
const stateFile = path.join(runtime, "processes.json");
const pipeName = `corescope-${createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 20)}`;
const pipe = process.platform === "win32" ? `\\\\.\\pipe\\${pipeName}` : path.join(runtime, `${pipeName}.sock`);
const action = process.argv[2] ?? "status";
const envFile = path.join(root, ".env");

type Role = "api" | "web" | "worker" | "bridge";
type ChildRecord = { pid: number; startedAt: string; entry: string; ready: boolean; restarts: number };
type State = { supervisor: { pid: number; startedAt: string; entry: string }; root: string; pipe: string; token: string; ready: boolean; stopping: boolean; children: Partial<Record<Role, ChildRecord>> };
type StopReason = "explicit_stop" | "failure_cleanup" | "recovery";
type DeclaredCaller = { pid: number | null; parentPid: number | null; identityAssurance: "declared_unverified" };
type StopRequest = { reason: StopReason; requestId: string; callerDeclared: DeclaredCaller };
const stopReasons = new Set<StopReason>(["explicit_stop", "failure_cleanup", "recovery"]);
const requestIdPattern = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i;
const positivePid = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
function lifecycle(event: string, targetPid: number | null, request?: StopRequest, extra: Record<string, unknown> = {}) {
  mkdirSync(logs, { recursive: true });
  appendFileSync(path.join(logs, "lifecycle-control.jsonl"), JSON.stringify({
    schemaVersion: 1, at: new Date().toISOString(), root, event, recordPid: process.pid,
    recordParentPid: process.ppid, targetPid, ...(request ?? {}), ...extra,
  }) + "\n", { mode: 0o600 });
}
function stopOptions(): StopRequest {
  let reason: StopReason = "explicit_stop";
  let requestId: string = randomUUID();
  const args = process.argv.slice(3);
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (seen.has(key) || !value) throw new Error("Invalid stop options");
    seen.add(key);
    if (key === "--reason" && stopReasons.has(value as StopReason)) reason = value as StopReason;
    else if (key === "--request-id" && requestIdPattern.test(value)) requestId = value;
    else throw new Error("Invalid stop options");
  }
  return { reason, requestId, callerDeclared: { pid: process.pid, parentPid: process.ppid, identityAssurance: "declared_unverified" } };
}

function requestControl(command: "status" | "stop"): Promise<unknown> {
  const saved = JSON.parse(readFileSync(stateFile, "utf8")) as State;
  if (saved.root !== root || saved.pipe !== pipe) throw new Error("Runtime state belongs to a different checkout");
  const stopRequest = command === "stop" ? stopOptions() : undefined;
  if (stopRequest) {
    try { lifecycle("stop_requested", positivePid(saved.supervisor.pid), stopRequest); }
    catch { console.error("Lifecycle request audit could not be written; graceful stop is still requested"); }
  }
  return new Promise((resolve, reject) => {
    const client = net.connect(pipe);
    const timer = setTimeout(() => { client.destroy(); reject(new Error("Runtime control timed out")); }, command === "stop" ? 220_000 : 10_000);
    let body = "";
    client.on("connect", () => client.write(JSON.stringify({ action: command, token: saved.token, ...(stopRequest ?? {}) }) + "\n"));
    client.on("data", (data) => { body += data.toString(); });
    client.on("end", () => { clearTimeout(timer); try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid runtime response")); } });
    client.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (stopRequest) {
        try { lifecycle("stop_failed", positivePid(saved.supervisor.pid), stopRequest, { errorCode: error.code ?? "control_failed" }); }
        catch { /* The CLI still reports the control failure. */ }
      }
      reject(error);
    });
  });
}

if (action === "launch-supervisor" || action === "launch-postgres") {
  mkdirSync(logs, { recursive: true });
  try {
    const isPostgres = action === "launch-postgres";
    // Keep the launcher's contract: the private file overrides inherited shell settings.
    const environment = loadLaunchEnvironment(envFile);
    const result = await launchDetached(
      isPostgres ? path.join(runtime, "pgsql/bin/pg_ctl.exe") : process.execPath,
      isPostgres
        ? ["start", "-D", path.join(runtime, "postgres-data"), "-o", "-h 127.0.0.1 -p 5448", "-l", path.join(logs, "postgres.log"), "-w", "-t", "60"]
        : [`--env-file=${envFile}`, path.resolve(import.meta.filename), "daemon"],
      {
        cwd: root,
        stdout: path.join(logs, isPostgres ? "pg-control.log" : "supervisor.log"),
        stderr: path.join(logs, isPostgres ? "pg-control.error.log" : "supervisor.error.log"),
        env: environment,
        waitForExit: isPostgres,
        timeoutMs: 70_000,
      },
    );
    console.log(JSON.stringify({ role: isPostgres ? "postgres-control" : "supervisor", ...result }));
    if (isPostgres && result.exitCode !== 0) {
      console.error("PostgreSQL control failed; inspect .data/logs/pg-control.error.log and postgres.log.");
      process.exitCode = typeof result.exitCode === "number" && result.exitCode > 0 && result.exitCode <= 255 ? result.exitCode : 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : "Background launch failed" }));
    process.exitCode = 1;
  }
} else if (action === "status" || action === "stop") {
  try {
    const result = await requestControl(action);
    console.log(JSON.stringify(result));
    if (action === "stop" && (!result || typeof result !== "object" || !("stopped" in result) || result.stopped !== true)) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ running: false, error: error instanceof Error ? error.message : "runtime unavailable" }));
    process.exitCode = 1;
  }
} else if (action === "daemon") {
  mkdirSync(runtime, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const state: State = {
    supervisor: { pid: process.pid, startedAt: new Date().toISOString(), entry: path.resolve(import.meta.filename) },
    root, pipe, token: randomBytes(32).toString("hex"), ready: false, stopping: false, children: {},
  };
  const children = new Map<Role, ChildProcess>();
  const restartTimes = new Map<Role, number[]>();
  const restartTimers = new Set<ReturnType<typeof setTimeout>>();
  let stopPromise: Promise<void> | null = null;
  let finishing = false;
  let exitCode = 0;
  const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  const entries: Array<[Role, string, string[]]> = [
    ["api", "apps/api/src/main.ts", []],
    ["web", "apps/web/server.ts", []],
    ["worker", "apps/worker/src/main.ts", []],
  ];
  const bridgeEntry = process.env.CORESCOPE_BRIDGE_ENTRY || "scripts/corescope-v2-bridge.ts";
  if (process.env.CORESCOPE_BRIDGE_ENABLED !== "false" && process.env.V2_DATABASE) {
    if (!existsSync(path.resolve(root, bridgeEntry))) throw new Error("Configured V2 bridge entry is missing");
    entries.push(["bridge", bridgeEntry, ["--watch"]]);
  }

  function startChild(role: Role, relativeEntry: string, args: string[]) {
    const entry = path.resolve(root, relativeEntry);
    const out = openSync(path.join(logs, `${role}.log`), "a");
    const err = openSync(path.join(logs, `${role}.error.log`), "a");
    const webKeys = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "TEMP", "TMP", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
      "SITE_URL", "API_BASE_URL", "WEB_PORT", "PORT", "TRUST_PROXY", "AIHOT_RELEASE", "LANG", "TZ"]);
    const environment = role === "web" ? Object.fromEntries(Object.entries(process.env).filter(([key]) => webKeys.has(key.toUpperCase()))) : { ...process.env };
    if (role !== "web") {
      const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
      environment[pathKey] = `${path.join(runtime, "pgsql/bin")}${path.delimiter}${environment[pathKey] ?? ""}`;
    }
    const child = fork(path.join(root, "scripts/corescope-runtime-child.ts"), [entry, ...args], {
      // Preserve IPC and our ChildProcess reference, but let the wrapper drain on parent death
      // instead of Windows terminating the attached child before its disconnect handler runs.
      cwd: root, execArgv: role === "web" ? [] : [`--env-file=${envFile}`], windowsHide: true, detached: true,
      env: { ...environment, NODE_ENV: "production", API_HOST: "127.0.0.1", WEB_HOST: "127.0.0.1" },
      stdio: ["ignore", out, err, "ipc"],
    });
    closeSync(out); closeSync(err);
    children.set(role, child);
    state.children[role] = { pid: child.pid!, startedAt: new Date().toISOString(), entry, ready: false, restarts: restartTimes.get(role)?.length ?? 0 };
    save();
    child.on("message", (message: unknown) => {
      if (!state.stopping && message && typeof message === "object" && "ready" in message && message.ready && state.children[role]?.pid === child.pid) {
        state.children[role]!.ready = true;
        state.ready = entries.every(([name]) => state.children[name]?.ready);
        save();
      }
    });
    child.on("error", () => {
      console.error(JSON.stringify({ role, error: "child process failed" }));
      if (!state.stopping) failSupervisor("child_process_failed", role);
    });
    child.on("exit", (code, signal) => {
      if (state.children[role]?.pid === child.pid) { state.children[role]!.ready = false; state.ready = false; save(); }
      if (state.stopping) return;
      console.error(JSON.stringify({ role, code, signal, msg: "child exited; checking restart limit" }));
      const recent = (restartTimes.get(role) ?? []).filter((at) => Date.now() - at < 300_000);
      recent.push(Date.now()); restartTimes.set(role, recent);
      if (recent.length <= 5) {
        const timer = setTimeout(() => {
          restartTimers.delete(timer);
          if (!state.stopping) {
            try { startChild(role, relativeEntry, args); }
            catch { failSupervisor("child_restart_failed", role); }
          }
        }, 5_000);
        restartTimers.add(timer);
      } else {
        failSupervisor("role_restart_exhausted", role);
      }
    });
  }

  function failSupervisor(event: string, role?: Role) {
    // An exhausted role cannot leave a live but permanently incomplete supervisor behind.
    exitCode = 1;
    try { lifecycle(event, process.pid, undefined, { serverPid: process.pid, ...(role ? { role } : {}) }); }
    catch { console.error("Lifecycle audit could not be written during supervisor failure"); }
    void finish(1);
  }

  async function finish(code: number) {
    exitCode = Math.max(exitCode, code);
    if (finishing) return;
    finishing = true;
    await stop();
    control.close(() => process.exit(exitCode));
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    state.stopping = true; state.ready = false; save();
    for (const timer of restartTimers) clearTimeout(timer);
    restartTimers.clear();
    stopPromise = Promise.all([...children.values()].map((child) => new Promise<void>((resolve) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 205_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ action: "shutdown" }, () => { /* A lost IPC peer handles disconnect itself. */ });
      // With IPC already lost, the child wrapper drains itself; preserve its graceful deadline.
    }))).then(() => { save(); });
    return stopPromise;
  }

  const control = net.createServer((socket) => {
    let input = "";
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("data", (data) => {
      input += data.toString();
      if (input.length > 2048) return socket.destroy();
      if (!input.includes("\n")) return;
      socket.removeAllListeners("data");
      let message: { action?: string; token?: string; reason?: unknown; requestId?: unknown; callerDeclared?: { pid?: unknown; parentPid?: unknown } };
      try { message = JSON.parse(input); } catch { return socket.destroy(); }
      if (!message || typeof message !== "object" || typeof message.token !== "string") return socket.destroy();
      const supplied = Buffer.from(message.token ?? "");
      const expected = Buffer.from(state.token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return socket.destroy();
      if (message.action === "status") {
        socket.end(JSON.stringify({ running: true, ready: state.ready, stopping: state.stopping, supervisor: state.supervisor, children: state.children }));
      } else if (message.action === "stop") {
        const request: StopRequest = {
          reason: stopReasons.has(message.reason as StopReason) ? message.reason as StopReason : "explicit_stop",
          requestId: typeof message.requestId === "string" && requestIdPattern.test(message.requestId) ? message.requestId : randomUUID(),
          callerDeclared: { pid: positivePid(message.callerDeclared?.pid), parentPid: positivePid(message.callerDeclared?.parentPid), identityAssurance: "declared_unverified" },
        };
        try { lifecycle("stop_accepted", process.pid, request, { serverPid: process.pid }); }
        catch { console.error("Lifecycle acceptance audit could not be written; graceful stop continues"); }
        socket.setTimeout(0);
        void stop().then(() => {
          try { lifecycle("stop_completed", process.pid, request, { serverPid: process.pid }); }
          catch { exitCode = 1; console.error("Lifecycle completion audit could not be written"); }
          socket.end(JSON.stringify({ stopped: true, requestId: request.requestId }));
          void finish(exitCode);
        });
      } else socket.destroy();
    });
  });
  control.on("error", (error: NodeJS.ErrnoException) => {
    console.error(JSON.stringify({ error: error.code ?? "control failed" }));
    failSupervisor("control_failed");
  });
  await new Promise<void>((resolve) => control.listen(pipe, resolve));
  save();
  for (const [role, entry, args] of entries) startChild(role, entry, args);
  save();
  console.log(JSON.stringify({ msg: "CoreScope native supervisor started", pid: process.pid }));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
    try { lifecycle("supervisor_signal", process.pid, undefined, { serverPid: process.pid, signal }); }
    catch { console.error("Lifecycle signal audit could not be written; graceful stop continues"); }
    void finish(0);
  });
} else {
  console.error("Use launch-supervisor, launch-postgres, daemon, status or stop");
  process.exitCode = 1;
}
