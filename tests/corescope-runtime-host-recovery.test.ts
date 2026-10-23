import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeScript = path.join(projectRoot, "scripts", "corescope-runtime.ps1");
const fixtureScript = path.join(projectRoot, "scripts", "test-fixtures", "corescope-recovery-probe.ps1");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function cleanEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(["systemroot", "windir", "systemdrive", "comspec", "path", "temp", "tmp", "userprofile", "username", "userdomain", "localappdata", "appdata", "homedrive", "homepath"]);
  const environment: NodeJS.ProcessEnv = { COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" };
  for (const [name, value] of Object.entries(process.env)) if (allowed.has(name.toLowerCase())) environment[name] = value;
  return environment;
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "corescope-recovery-test-"));
  const nonce = randomUUID();
  const heartbeat = path.join(directory, "heartbeat.json");
  const stop = path.join(directory, "heartbeat-stop");
  const entry = path.join(directory, "heartbeat.mjs");
  await writeFile(entry, `import fs from 'node:fs';
const [heartbeat,nonce,stop]=process.argv.slice(2); const started=Date.now(); let ticks=0;
function tick(){if(fs.existsSync(stop)||Date.now()-started>45000)process.exit(0);fs.writeFileSync(heartbeat,JSON.stringify({pid:process.pid,nonce,ticks:++ticks}));}
tick();setInterval(tick,75);
`);
  return {
    directory, nonce, entry, heartbeat, stop,
    async run(action: "Probe" | "Intent" | "IntentUpdate" | "IntentGate" | "OfflineStop" | "RecoveryPermit" | "PermitResume" | "PermitExpired" | "PermitNewIntent" | "Repair" | "Adopt" | "Task", fakePid?: number) {
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", fixtureScript,
        "-Action", action, "-RuntimeScript", runtimeScript, "-FixtureRoot", directory, "-NodeExecutable", process.execPath, "-Nonce", nonce];
      if (fakePid !== undefined) args.push("-FakePid", String(fakePid));
      const child = spawn(powershell, args, { cwd: directory, env: cleanEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      assert.equal(exit, 0, `${action} fixture failed: ${stderr}\n${stdout}`);
      return JSON.parse(stdout.trim()) as Record<string, any>;
    },
    async close(child?: ChildProcess) {
      await writeFile(stop, "self exit the owned fake heartbeat");
      if (child && child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), pause(5_000)]);
        if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise<void>((resolve) => child.once("exit", () => resolve())); }
      }
      // Never recurse into a checkout; this directory was just created by mkdtemp.
      for (const name of await readdir(directory)) await unlink(path.join(directory, name));
      await rmdir(directory);
    },
  };
}

test("native owned-process monitoring survives WMI failure and keeps unknown distinct from exit", {
  skip: process.platform !== "win32", timeout: 50_000,
}, async () => {
  const sandbox = await fixture();
  const child = spawn(process.execPath, [sandbox.entry, sandbox.heartbeat, sandbox.nonce, sandbox.stop], {
    cwd: sandbox.directory, env: cleanEnvironment(), windowsHide: true, stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 10_000;
    let ready: { pid: number; nonce: string; ticks: number } | undefined;
    while (!ready && Date.now() < deadline) {
      try { ready = JSON.parse(await readFile(sandbox.heartbeat, "utf8")); } catch { await pause(50); }
    }
    assert.equal(ready?.pid, child.pid);
    assert.equal(ready?.nonce, sandbox.nonce);
    const result = await sandbox.run("Probe", child.pid);
    assert.equal(result.alive.status, "alive");
    assert.equal(result.wmiUnavailable.status, "alive");
    assert.equal(result.wmiCalls, 0, "the liveness hot loop must not query WMI");
    assert.equal(result.creationMismatch.status, "mismatch", "PID reuse must not validate an unrelated process");
    assert.equal(result.executableMismatch.status, "mismatch");
    assert.equal(result.healthy.status, "healthy");
    assert.equal(result.unknown.status, "unknown", "an unobservable process must never be treated as missing");
    assert.equal(result.unknown.resource, "postgres");
    assert.equal(result.missing.status, "missing");
    assert.equal(result.missing.resource, "supervisor");
  } finally { await sandbox.close(child); }
});

test("durable stopped intent survives offline and later Start advances its generation without losing other mode", {
  skip: process.platform !== "win32", timeout: 30_000,
}, async () => {
  const sandbox = await fixture();
  try {
    const result = await sandbox.run("Intent");
    assert.equal(result.stopped.state, "stopped");
    assert.equal(result.running.state, "running");
    assert.notEqual(result.running.generation, result.stopped.generation);
    assert.notEqual(result.running.requestId, result.stopped.requestId);
    assert.equal(result.database.state, "stopped");
    assert.equal(result.rootRejected, true);
    assert.equal(result.userRejected, true);
    assert.equal(result.rootWriteRejected, true);
    assert.equal(result.userWriteRejected, true);
    assert.equal(result.running.actorPid > 0, true);
    assert.equal(result.running.actorParentPid > 0, true);
    assert.ok(Number.isFinite(Date.parse(result.running.at)));
    const updates = await Promise.all(Array.from({ length: 4 }, () => sandbox.run("IntentUpdate")));
    assert.ok(updates.every((update) => update.generation === result.running.generation), "concurrent repeated Start must preserve the existing running generation");
    assert.ok(updates.every((update) => update.requestId === result.running.requestId));
  } finally { await sandbox.close(); }
});

test("the scheduler upgrades only the exact owned legacy task to bounded restart and current-user logon recovery", {
  skip: process.platform !== "win32", timeout: 30_000,
}, async () => {
  const sandbox = await fixture();
  try {
    const result = await sandbox.run("Task");
    assert.equal(result.legacy.triggerCount, 0, "ordinary fake specs must retain demand-only behavior");
    assert.equal(result.recovery.triggerCount, 1);
    assert.equal(result.recovery.restartCount, 3);
    assert.equal(result.recovery.restartInterval, "PT1M");
    assert.equal(result.recovery.executionTimeLimit, "PT0S");
    assert.equal(result.recovery.logonSid, result.userSid);
    assert.equal(result.database.triggerCount, 0, "a database-only host must not become an extra login-started instance");
    assert.equal(result.database.restartCount, 3);
    assert.equal(result.changedActionRejected, true);
    assert.equal(result.changedActionPreserved, true, "a mismatched task definition must never be overwritten");
    assert.equal(result.taskDeleted, true);
  } finally { await sandbox.close(); }
});

test("a durable Stop cancels fresh hosts while a newer Start invalidates only the older generation", {
  skip: process.platform !== "win32", timeout: 15_000,
}, async () => {
  const sandbox = await fixture();
  try {
    const result = await sandbox.run("IntentGate");
    assert.equal(result.currentAllowed, true);
    assert.equal(result.freshHostCancelled, true);
    assert.equal(result.oldGenerationCancelled, true);
    assert.equal(result.newGenerationAllowed, true);
    assert.equal(result.unreadableIntentDoesNotStop, true, "a failed state probe must not manufacture a Stop request");
    assert.equal(result.currentStartAllowed, true);
    assert.equal(result.oldGenerationCannotStart, true);
    assert.equal(result.unreadableIntentCannotStart, true, "unknown intent may preserve a process but cannot authorize a replacement");
    assert.equal(result.missingIntentCannotStart, true);
    assert.notEqual(result.firstGeneration, result.nextGeneration);
  } finally { await sandbox.close(); }
});

test("offline Stop records both durable stopped intents without calling a native runtime or PostgreSQL", {
  skip: process.platform !== "win32", timeout: 15_000,
}, async () => {
  const sandbox = await fixture();
  try {
    const result = await sandbox.run("OfflineStop");
    assert.equal(result.system.state, "stopped");
    assert.equal(result.database.state, "stopped");
    assert.equal(result.externalRuntimeCalls, 0);
    assert.equal(result.stopRequests, 1);
  } finally { await sandbox.close(); }
});

test("a host recovery budget survives a new caller, expires after ten minutes and resets for a new running generation", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async () => {
  const sandbox = await fixture();
  try {
    const initial = await sandbox.run("RecoveryPermit");
    assert.deepEqual(initial.permits.map((p: { allowed: boolean }) => p.allowed), [true, true, true, false]);
    assert.deepEqual(initial.permits.slice(0, 3).map((p: { delaySeconds: number }) => p.delaySeconds), [5, 15, 45]);
    assert.equal(initial.attempts, 3);
    const resumed = await sandbox.run("PermitResume");
    assert.equal(resumed.permit.allowed, false, "a replacement host must inherit the persisted retry limit");
    assert.equal(resumed.attempts, 3);
    const expired = await sandbox.run("PermitExpired");
    assert.equal(expired.permit.allowed, true);
    assert.equal(expired.permit.delaySeconds, 5);
    assert.equal(expired.attempts, 1);
    const next = await sandbox.run("PermitNewIntent");
    assert.equal(next.permit.allowed, true);
    assert.equal(next.permit.delaySeconds, 5);
    assert.equal(next.attempts, 1);
    assert.notEqual(next.generation, initial.generation);
  } finally { await sandbox.close(); }
});

test("real repair control flow starts resources only after confirmed loss and honors Stop before restart", {
  skip: process.platform !== "win32", timeout: 15_000,
}, async () => {
  const sandbox = await fixture();
  try {
    const result = await sandbox.run("Repair");
    for (const status of ["healthy", "unknown", "mismatch"]) assert.deepEqual(result[status].external, [], `${status} must preserve every running resource`);
    for (const scenario of ["alreadyStopped", "cancelledBackoff", "cooldown"]) assert.deepEqual(result[scenario].external, []);
    assert.deepEqual(result.postgresMissing.external, ["stop", "start-system"]);
    assert.deepEqual(result.supervisorMissing.external, ["start-system"]);
    assert.deepEqual(result.stoppedAfterDrain.external, ["stop"], "Stop during drain must prevent restart");
    assert.deepEqual(result.databaseMissing.external, ["start-database"]);
  } finally { await sandbox.close(); }
});

test("a replacement host adopts only matching native, command, PID-file and supervisor receipt identities", {
  skip: process.platform !== "win32", timeout: 15_000,
}, async () => {
  const sandbox = await fixture();
  try {
    const result = await sandbox.run("Adopt");
    for (const scenario of ["hostAlive", "hostUnknown", "resourceUnknown", "supervisorUnknown", "commandMismatch", "pidFileMismatch", "supervisorReceiptMismatch"]) {
      assert.equal(result[scenario].rejected, true, `${scenario} must not authorize adoption`);
      assert.equal(result[scenario].saved, false, `${scenario} must not persist an accepted resource receipt`);
      assert.equal(result[scenario].pgPid, null, `${scenario} must not partially adopt PostgreSQL`);
      assert.equal(result[scenario].supervisorPid, null, `${scenario} must not partially adopt a supervisor`);
    }
    assert.equal(result.matching.rejected, false);
    assert.equal(result.matching.pgPid, 200);
    assert.equal(result.matching.supervisorPid, 300);
    assert.deepEqual(result.matching.adopted.sort((a: number, b: number) => a - b), [200, 300]);
    assert.equal(result.matching.saved, true);
  } finally { await sandbox.close(); }
});
