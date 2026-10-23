import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { childShutdownController } from "../scripts/corescope-runtime-child.ts";

const scripts = path.resolve(import.meta.dirname, "../scripts");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually<T>(read: () => Promise<T | undefined>, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(25);
  } while (Date.now() < deadline);
  throw new Error("Isolated runtime fixture did not settle in time");
}
async function json<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return undefined; }
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
async function waitExit(child: ChildProcess) {
  if (!exited(child)) await once(child, "exit");
}
const safeEnvironment = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|TEMP|TMP|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key))),
  COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", CORESCOPE_BRIDGE_ENABLED: "false",
});
async function removeFixture(directory: string) {
  assert.equal(path.dirname(directory).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(directory).startsWith("corescope-recovery-test-"));
  await rm(directory, { recursive: true, force: true });
}

test("child shutdown reaches a top-level watch handler and delivers only once", async () => {
  let handled = false, signals = 0, exit: number | undefined;
  const control = childShutdownController({ hasHandler: () => handled, signal: () => { signals++; }, exit: code => { exit = code; }, timeoutMs: 500 });
  try {
    control.request();
    control.request();
    handled = true;
    await eventually(async () => signals === 1 ? true : undefined);
    control.loaded();
    assert.equal(signals, 1);
    assert.equal(exit, undefined);
  } finally { control.dispose(); }
});

test("a child that does not drain reaches its bounded shutdown deadline", async () => {
  let signals = 0, code: number | undefined;
  const control = childShutdownController({ hasHandler: () => true, signal: () => { signals++; }, exit: value => { code = value; }, timeoutMs: 15 });
  try {
    control.request();
    await eventually(async () => code === 1 ? true : undefined);
    assert.equal(signals, 1);
  } finally { control.dispose(); }
});

test("IPC disconnect drains a child's actual listening port before its natural exit", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "corescope-recovery-test-"));
  const entry = path.join(directory, "port.mjs");
  const marker = path.join(directory, "closed.json");
  await writeFile(entry, `import net from 'node:net'; import fs from 'node:fs/promises';
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
process.on('SIGTERM',()=>server.close(async()=>{await fs.writeFile(process.argv[2],JSON.stringify({drained:true}));}));
process.send({ready:true,port:server.address().port});
`);
  const child = fork(path.join(scripts, "corescope-runtime-child.ts"), [entry, marker], { execArgv: [], env: safeEnvironment(), windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const [message] = await once(child, "message");
    const ending = waitExit(child);
    child.disconnect();
    await ending;
    assert.equal(child.exitCode, 0);
    assert.equal((await json<{ drained: boolean }>(marker))?.drained, true);
    await assertPortClosed(message.port);
  } finally {
    if (!exited(child)) { child.kill("SIGKILL"); await waitExit(child); }
    await removeFixture(directory);
  }
});

interface FixtureState { ready: boolean; stopping: boolean; token: string; pipe: string; supervisor: { pid: number }; children: Record<string, { pid: number; ready: boolean }> }
async function sandbox(crashingWorker = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "corescope-recovery-test-"));
  await mkdir(path.join(directory, "scripts"));
  await mkdir(path.join(directory, ".data/runtime"), { recursive: true });
  for (const file of ["corescope-runtime.ts", "corescope-runtime-child.ts", "corescope-runtime-launch.ts"]) await copyFile(path.join(scripts, file), path.join(directory, "scripts", file));
  await writeFile(path.join(directory, ".env"), "COLLECT_ENABLED=false\nMODEL_CALLS_ENABLED=false\nCORESCOPE_BRIDGE_ENABLED=false\nLLM_API_KEY=fixture-secret-never-log\n");
  for (const [role, relative] of [["api", "apps/api/src/main.ts"], ["web", "apps/web/server.ts"], ["worker", "apps/worker/src/main.ts"]]) {
    const file = path.join(directory, relative!);
    await mkdir(path.dirname(file), { recursive: true });
    const body = role === "worker" && crashingWorker
      ? `import fs from 'node:fs';fs.appendFileSync('.data/runtime/worker-exits.jsonl',JSON.stringify({pid:process.pid})+'\\n');process.exit(17);`
      : `import net from 'node:net';import fs from 'node:fs/promises';const role=${JSON.stringify(role)};
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
await fs.writeFile('.data/runtime/'+role+'.json',JSON.stringify({pid:process.pid,port:server.address().port}));
process.on('SIGTERM',()=>server.close(async()=>{await new Promise(r=>setTimeout(r,40));await fs.writeFile('.data/runtime/'+role+'-closed.json',JSON.stringify({drained:true,pid:process.pid}));}));`;
    await writeFile(file, body);
  }
  const runtime = path.join(directory, "scripts/corescope-runtime.ts");
  const supervisor = spawn(process.execPath, [runtime, "daemon"], { cwd: directory, env: safeEnvironment(), windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  supervisor.stderr!.on("data", part => { errors += part.toString(); });
  const stateFile = path.join(directory, ".data/runtime/processes.json");
  return { directory, runtime, supervisor, stateFile, errors: () => errors,
    async state() { return json<FixtureState>(stateFile); },
    async close() {
      if (!exited(supervisor)) { supervisor.kill("SIGKILL"); await waitExit(supervisor); }
      // Killing only this fixture's supervisor disconnects only its own fixture children.
      for (const role of ["api", "web", ...(crashingWorker ? [] : ["worker"])]) {
        const child = await json<{ pid: number }>(path.join(directory, `.data/runtime/${role}.json`));
        let alive = false;
        if (child) { try { process.kill(child.pid, 0); alive = true; } catch {} }
        if (alive) await eventually(async () => await json(path.join(directory, `.data/runtime/${role}-closed.json`)));
      }
      await removeFixture(directory);
    },
  };
}
async function assertPortClosed(port: number) {
  await new Promise<void>((resolve, reject) => {
    const client = net.connect({ host: "127.0.0.1", port });
    client.once("connect", () => { client.destroy(); reject(new Error("Isolated child left its listening port open")); });
    client.once("error", () => resolve());
  });
}
async function audit(directory: string) {
  return (await readFile(path.join(directory, ".data/logs/lifecycle-control.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

for (const reason of [undefined, "failure_cleanup", "recovery"] as const) {
  test(`isolated supervisor audits ${reason ?? "default explicit_stop"} and drains owned children`, { timeout: 20_000 }, async () => {
    const fixture = await sandbox();
    try {
      const state = await eventually(async () => { const s = await fixture.state(); return s?.ready ? s : undefined; });
      const suppliedId = "0123456789abcdef0123456789abcdef";
      if (!reason) {
        // Invalid IPC is not authority to stop the runtime, and its token must not enter the audit.
        await new Promise<void>(resolve => {
          const client = net.connect(state.pipe);
          client.on("connect", () => client.end(JSON.stringify({ action: "stop", token: "unauthorized-fixture-token" }) + "\n"));
          client.on("error", () => {});
          client.on("close", () => resolve());
        });
      }
      const args = [fixture.runtime, "stop", ...(reason ? ["--reason", reason] : []), ...(reason === "recovery" ? ["--request-id", suppliedId] : [])];
      const caller = spawn(process.execPath, args, { cwd: fixture.directory, env: safeEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const callerPid = caller.pid;
      await waitExit(caller);
      await waitExit(fixture.supervisor);
      assert.equal(caller.exitCode, 0);
      assert.equal(fixture.supervisor.exitCode, 0);
      const rows = await audit(fixture.directory);
      const accepted = rows.find(row => row.event === "stop_accepted");
      assert.equal(accepted.reason, reason ?? "explicit_stop");
      assert.equal(accepted.serverPid, state.supervisor.pid);
      assert.equal(accepted.targetPid, state.supervisor.pid);
      assert.equal(accepted.callerDeclared.pid, callerPid);
      assert.equal(accepted.callerDeclared.identityAssurance, "declared_unverified");
      assert.equal(rows.find(row => row.event === "stop_requested").requestId, accepted.requestId);
      assert.equal(rows.find(row => row.event === "stop_completed").requestId, accepted.requestId);
      if (reason === "recovery") assert.equal(accepted.requestId, suppliedId);
      const raw = JSON.stringify(rows);
      assert.ok(!raw.includes(state.token));
      assert.ok(!raw.includes("fixture-secret-never-log"));
      assert.ok(!raw.includes("unauthorized-fixture-token"));
      assert.ok(!raw.includes('"env"') && !raw.includes('"commandLine"'));
      for (const role of ["api", "web", "worker"]) {
        const marker = await json<{ drained: boolean }>(path.join(fixture.directory, `.data/runtime/${role}-closed.json`));
        assert.equal(marker?.drained, true);
        await assertPortClosed((await json<{ port: number }>(path.join(fixture.directory, `.data/runtime/${role}.json`)))!.port);
      }
    } finally { await fixture.close(); }
  });
}

test("supervisor death disconnects and drains all isolated children without orphan ports", { timeout: 20_000 }, async () => {
  const fixture = await sandbox();
  try {
    await eventually(async () => { const s = await fixture.state(); return s?.ready ? true : undefined; });
    assert.equal(fixture.supervisor.kill("SIGKILL"), true);
    await waitExit(fixture.supervisor);
    for (const role of ["api", "web", "worker"]) {
      await eventually(async () => await json(path.join(fixture.directory, `.data/runtime/${role}-closed.json`)));
      await assertPortClosed((await json<{ port: number }>(path.join(fixture.directory, `.data/runtime/${role}.json`)))!.port);
    }
  } finally { await fixture.close(); }
});

test("unavailable lifecycle audit does not prevent an authenticated graceful stop", { timeout: 20_000 }, async () => {
  const fixture = await sandbox();
  try {
    await eventually(async () => { const state = await fixture.state(); return state?.ready ? true : undefined; });
    await mkdir(path.join(fixture.directory, ".data/logs/lifecycle-control.jsonl"));
    const caller = spawn(process.execPath, [fixture.runtime, "stop"], { cwd: fixture.directory, env: safeEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let warning = "";
    caller.stderr!.on("data", value => { warning += value.toString(); });
    await waitExit(caller);
    await waitExit(fixture.supervisor);
    assert.equal(caller.exitCode, 0);
    assert.equal(fixture.supervisor.exitCode, 1);
    assert.match(warning, /audit could not be written/);
    assert.ok(!warning.includes("fixture-secret-never-log"));
    for (const role of ["api", "web", "worker"]) assert.equal((await json<{ drained: boolean }>(path.join(fixture.directory, `.data/runtime/${role}-closed.json`)))?.drained, true);
  } finally { await fixture.close(); }
});

test("six role failures exhaust the real restart budget, drain peers and fail the supervisor", { timeout: 55_000 }, async () => {
  const fixture = await sandbox(true);
  try {
    await eventually(async () => exited(fixture.supervisor) ? true : undefined, 45_000);
    assert.equal(fixture.supervisor.exitCode, 1);
    const attempts = (await readFile(path.join(fixture.directory, ".data/runtime/worker-exits.jsonl"), "utf8")).trim().split("\n");
    assert.equal(attempts.length, 6);
    assert.equal((await fixture.state())?.stopping, true);
    const rows = await audit(fixture.directory);
    assert.equal(rows.filter(row => row.event === "role_restart_exhausted").length, 1);
    assert.equal(rows.find(row => row.event === "role_restart_exhausted").role, "worker");
    for (const role of ["api", "web"]) {
      assert.equal((await json<{ drained: boolean }>(path.join(fixture.directory, `.data/runtime/${role}-closed.json`)))?.drained, true);
      await assertPortClosed((await json<{ port: number }>(path.join(fixture.directory, `.data/runtime/${role}.json`)))!.port);
    }
  } finally { await fixture.close(); }
});
