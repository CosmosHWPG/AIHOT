// Native Windows supervisor. Only the project-specific named pipe can request a graceful shutdown.
import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
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

function requestControl(command: "status" | "stop"): Promise<unknown> {
  const saved = JSON.parse(readFileSync(stateFile, "utf8")) as State;
  if (saved.root !== root || saved.pipe !== pipe) throw new Error("Runtime state belongs to a different checkout");
  return new Promise((resolve, reject) => {
    const client = net.connect(pipe);
    const timer = setTimeout(() => { client.destroy(); reject(new Error("Runtime control timed out")); }, command === "stop" ? 220_000 : 10_000);
    let body = "";
    client.on("connect", () => client.write(JSON.stringify({ action: command, token: saved.token }) + "\n"));
    client.on("data", (data) => { body += data.toString(); });
    client.on("end", () => { clearTimeout(timer); try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid runtime response")); } });
    client.on("error", (error) => { clearTimeout(timer); reject(error); });
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
    console.log(JSON.stringify(await requestControl(action)));
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
  let stopPromise: Promise<void> | null = null;
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
      cwd: root, execArgv: role === "web" ? [] : [`--env-file=${envFile}`], windowsHide: true,
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
        state.ready = ["api", "web", "worker"].every((name) => state.children[name as Role]?.ready);
        save();
      }
    });
    child.on("error", () => { console.error(JSON.stringify({ role, error: "child process failed" })); });
    child.on("exit", (code, signal) => {
      if (state.children[role]?.pid === child.pid) { state.children[role]!.ready = false; state.ready = false; save(); }
      if (state.stopping) return;
      console.error(JSON.stringify({ role, code, signal, msg: "child exited; checking restart limit" }));
      const recent = (restartTimes.get(role) ?? []).filter((at) => Date.now() - at < 300_000);
      recent.push(Date.now()); restartTimes.set(role, recent);
      if (recent.length <= 5) setTimeout(() => { if (!state.stopping) startChild(role, relativeEntry, args); }, 5_000);
    });
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    state.stopping = true; state.ready = false; save();
    stopPromise = Promise.all([...children.values()].map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill(); resolve(); }, 205_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ action: "shutdown" }); else child.kill();
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
      let message: { action?: string; token?: string };
      try { message = JSON.parse(input); } catch { return socket.destroy(); }
      const supplied = Buffer.from(message.token ?? "");
      const expected = Buffer.from(state.token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return socket.destroy();
      if (message.action === "status") {
        socket.end(JSON.stringify({ running: true, ready: state.ready, stopping: state.stopping, supervisor: state.supervisor, children: state.children }));
      } else if (message.action === "stop") {
        socket.setTimeout(0);
        void stop().then(() => {
          socket.end(JSON.stringify({ stopped: true }));
          control.close(() => process.exit(0));
        });
      } else socket.destroy();
    });
  });
  control.on("error", (error: NodeJS.ErrnoException) => {
    console.error(JSON.stringify({ error: error.code ?? "control failed" }));
    process.exit(1);
  });
  await new Promise<void>((resolve) => control.listen(pipe, resolve));
  save();
  for (const [role, entry, args] of entries) startChild(role, entry, args);
  save();
  console.log(JSON.stringify({ msg: "CoreScope native supervisor started", pid: process.pid }));
  process.on("SIGTERM", () => { void stop().then(() => control.close(() => process.exit(0))); });
  process.on("SIGINT", () => { void stop().then(() => control.close(() => process.exit(0))); });
} else {
  console.error("Use launch-supervisor, launch-postgres, daemon, status or stop");
  process.exitCode = 1;
}
