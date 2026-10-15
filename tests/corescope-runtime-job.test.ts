import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

interface Heartbeat { pid: number; nonce: string; ticks: number }
interface Identity { pid: number; creationTimeUtc: string; executable: string; commandLine: string }
interface TaskInstance { instanceId: string; enginePid: number; state: number }
interface InstanceProbe {
  taskInstancesFlags0: { count: number; collectionType: string };
  taskInstancesFlags1: { count: number; collectionType: string; item1: TaskInstance };
  serviceRunningFlags0: { matching: TaskInstance[] };
  serviceRunningFlags1: { matching: TaskInstance[] };
}
interface JobProcess { pid: number; alive: boolean; inJob: boolean | null; creationTimeUtc: string | null }
interface JobReceipt {
  state: string; error?: string; jobHostPid: number; jobFlags: number; handleInheritable: boolean;
  caller: JobProcess; negative: JobProcess; callerBefore: JobProcess; negativeBefore: JobProcess;
  callerAfter: JobProcess; negativeAfter: JobProcess; probesBefore: JobProcess[]; probesAfter: JobProcess[];
}
interface SchedulerReceipt {
  state: string; error?: string; callerPid: number; inspectorPid?: number; heartbeat: Heartbeat; identity: Identity;
  taskPath: string; principal: string; principalSid: string; logonType: number; runLevel: number; triggerCount: number;
  actionCount: number; executionTimeLimit: string; multipleInstances: number; hidden: boolean;
  instanceCount: number; instanceId: string; enginePid: number; engineAncestry: boolean;
  scheduleAncestry: boolean; callerEngineAncestry: boolean; rawInstanceProbe: InstanceProbe;
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const projectRoot = path.resolve(import.meta.dirname, "..");
const runtimeScript = path.join(projectRoot, "scripts", "corescope-runtime.ps1");
const jobFixture = path.join(projectRoot, "scripts", "test-fixtures", "corescope-private-job.ps1");
const schedulerFixture = path.join(projectRoot, "scripts", "test-fixtures", "corescope-scheduler-probe.ps1");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function cleanEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set(["systemroot", "windir", "systemdrive", "comspec", "path", "temp", "tmp", "userprofile", "username", "userdomain", "localappdata", "appdata", "homedrive", "homepath"]);
  const environment: NodeJS.ProcessEnv = { COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" };
  for (const [name, value] of Object.entries(process.env)) if (allowed.has(name.toLowerCase())) environment[name] = value;
  return environment;
}
function startPowerShell(args: string[], cwd: string) {
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", ...args], {
    cwd, env: cleanEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout!.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
  const finished = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, finished, errors: () => stderr };
}
async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return undefined; }
}
async function eventually<T>(probe: () => Promise<T | undefined>, timeout = 45_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await pause(75);
  }
  throw new Error("Timed out waiting for an isolated Windows Job/Scheduler fixture");
}
async function writeJson(file: string, value: unknown) { await writeFile(file, JSON.stringify(value)); }
function quotedArgument(value: string) {
  // The fixed Scheduler action receives only fixture paths and UUIDs.
  assert.equal(value.includes('"'), false);
  return `"${value}"`;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("Windows Scheduler heartbeat outlives last private kill-on-close Job handle; its same-Job controls die", {
  skip: process.platform !== "win32" ? "Requires real Windows JobObject and current-user Task Scheduler" : false,
  timeout: 120_000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "corescope-job-test 空格-"));
  const nonce = randomUUID();
  const taskName = `CoreScope-JobTest-${nonce}`;
  const heartbeat = path.join(directory, "managed-heartbeat.json");
  const negativeHeartbeat = path.join(directory, "negative-heartbeat.json");
  const stop = path.join(directory, "managed-stop");
  const negativeStop = path.join(directory, "negative-stop");
  const close = path.join(directory, "close-private-job");
  const entry = path.join(directory, "nonce-heartbeat.mjs");
  const specFile = path.join(directory, "scheduler-spec.json");
  const commandFile = path.join(directory, "caller-command.json");
  const negativeCommandFile = path.join(directory, "negative-command.json");
  const jobReceiptFile = path.join(directory, "job-receipt.json");
  const callerReceiptFile = path.join(directory, "caller-receipt.json");
  const inspectReceiptFile = path.join(directory, "independent-inspection.json");
  const cleanupReceiptFile = path.join(directory, "cleanup-receipt.json");
  const probes = path.join(directory, "probe-pids.json");
  await writeFile(entry, `import fs from "node:fs";
const [heartbeat, nonce, stop] = process.argv.slice(2);
const started = Date.now(); let ticks = 0;
function tick() {
  if (fs.existsSync(stop) || Date.now() - started > 100000) process.exit(0);
  fs.writeFileSync(heartbeat, JSON.stringify({pid:process.pid,nonce,ticks:++ticks}));
}
tick(); setInterval(tick, 75);
`);
  const sidCommand = startPowerShell(["-Command", "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], directory);
  const sidResult = await sidCommand.finished;
  assert.equal(sidResult.code, 0, sidResult.stderr);
  const sid = sidResult.stdout.trim();
  assert.match(sid, /^S-1-/);
  await writeJson(specFile, {
    TaskName: taskName, UserSid: sid, Root: directory, Executable: process.execPath,
    Arguments: [entry, heartbeat, nonce, stop].map(quotedArgument).join(" "),
    WorkingDirectory: directory, Description: `CoreScope isolated private Job lifecycle fixture ${nonce}`,
  });
  const schedulerArgs = (action: "Start" | "Inspect" | "Cleanup", receipt: string) => [
    "-File", schedulerFixture, "-Action", action, "-RuntimeScript", runtimeScript,
    "-SpecFile", specFile, "-HeartbeatFile", heartbeat, "-ReceiptFile", receipt,
  ];
  await writeJson(commandFile, { executable: powershell, workingDirectory: directory, args: [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    ...schedulerArgs("Start", callerReceiptFile), "-ProbePidFile", probes,
  ] });
  await writeJson(negativeCommandFile, { executable: process.execPath, workingDirectory: directory,
    args: [entry, negativeHeartbeat, `${nonce}-negative`, negativeStop] });
  let job: ReturnType<typeof startPowerShell> | undefined;
  let managedPid: number | undefined;
  let negativePid: number | undefined;
  try {
    job = startPowerShell(["-File", jobFixture, "-CommandFile", commandFile, "-ReceiptFile", jobReceiptFile,
      "-CloseFile", close, "-NegativeCommandFile", negativeCommandFile, "-ProbePidFile", probes,
      "-TimeoutSeconds", "75"], directory);
    const running = await eventually(async () => {
      const receipt = await readJson<JobReceipt>(jobReceiptFile);
      if (receipt?.state === "failed") throw new Error(receipt.error);
      if (job!.child.exitCode !== null) throw new Error(`Private Job fixture exited: ${job!.errors()}`);
      return receipt?.state === "running" ? receipt : undefined;
    });
    assert.equal(running.jobFlags, 0x2000);
    assert.equal(running.handleInheritable, false);
    assert.equal(running.caller.alive, true);
    assert.equal(running.caller.inJob, true);
    assert.equal(running.negative.alive, true);
    assert.equal(running.negative.inJob, true);
    negativePid = running.negative.pid;
    const negativeBefore = await eventually(async () => {
      const value = await readJson<Heartbeat>(negativeHeartbeat);
      return value && value.ticks >= 3 ? value : undefined;
    });
    assert.equal(negativeBefore.pid, negativePid);
    assert.equal(negativeBefore.nonce, `${nonce}-negative`);
    const ready = await eventually(async () => {
      const value = await readJson<SchedulerReceipt>(callerReceiptFile);
      if (value?.state === "failed") throw new Error(`${value.error} | raw instance probe: ${JSON.stringify(value.rawInstanceProbe)}`);
      return value?.state === "ready" ? value : undefined;
    });
    managedPid = ready.heartbeat.pid;
    assert.equal(ready.callerPid, running.caller.pid);
    assert.equal(ready.heartbeat.nonce, nonce);
    assert.equal(ready.principalSid, sid);
    assert.equal(ready.logonType, 3); // InteractiveToken, no password.
    assert.equal(ready.runLevel, 0); // Limited current-user identity.
    assert.equal(ready.triggerCount, 0);
    assert.equal(ready.actionCount, 1);
    assert.equal(ready.executionTimeLimit, "PT0S");
    assert.equal(ready.multipleInstances, 2);
    assert.equal(ready.hidden, true);
    assert.equal(ready.taskPath, `\\${taskName}`);
    assert.equal(ready.instanceCount, 1);
    assert.match(ready.instanceId, /^\{?[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\}?$/i);
    assert.ok(Number.isInteger(ready.enginePid) && ready.enginePid >= 0);
    assert.equal(ready.engineAncestry, true);
    assert.equal(ready.scheduleAncestry, true);
    assert.equal(ready.callerEngineAncestry, false);
    // Hidden production tasks require TASK_ENUM_HIDDEN. Compare the production
    // adapter's exact GUID/PID with both real COM APIs, not a fabricated fixture.
    assert.equal(ready.rawInstanceProbe.taskInstancesFlags0.count, 0);
    assert.equal(ready.rawInstanceProbe.taskInstancesFlags1.count, 1);
    assert.equal(ready.rawInstanceProbe.taskInstancesFlags1.item1.instanceId, ready.instanceId);
    assert.equal(ready.rawInstanceProbe.taskInstancesFlags1.item1.enginePid, ready.enginePid);
    assert.equal(ready.rawInstanceProbe.serviceRunningFlags0.matching.length, 0);
    assert.equal(ready.rawInstanceProbe.serviceRunningFlags1.matching.length, 1);
    assert.equal(ready.rawInstanceProbe.serviceRunningFlags1.matching[0].instanceId, ready.instanceId);
    assert.equal(ready.rawInstanceProbe.serviceRunningFlags1.matching[0].enginePid, ready.enginePid);
    t.diagnostic(`Live Scheduler instance APIs: ${JSON.stringify(ready.rawInstanceProbe)}`);
    await writeFile(close, "close only the last handle to our private Job");
    const completed = await job.finished;
    assert.equal(completed.code, 0, completed.stderr);
    const closed = (await readJson<JobReceipt>(jobReceiptFile))!;
    assert.equal(closed.state, "closed", closed.error ?? "No private Job close receipt");
    assert.equal(closed.callerBefore.inJob, true);
    assert.equal(closed.negativeBefore.inJob, true);
    assert.equal(closed.callerAfter.alive, false);
    assert.equal(closed.negativeAfter.alive, false);
    assert.equal(alive(negativePid), false);
    assert.equal(closed.probesBefore.length, 1);
    assert.equal(closed.probesBefore[0].pid, managedPid);
    assert.equal(closed.probesBefore[0].alive, true);
    assert.equal(closed.probesBefore[0].inJob, false); // THIS Job, not membership of any Job.
    assert.equal(closed.probesBefore[0].creationTimeUtc, ready.identity.creationTimeUtc);
    assert.equal(closed.probesAfter[0].pid, managedPid);
    assert.equal(closed.probesAfter[0].alive, true);
    assert.equal(closed.probesAfter[0].creationTimeUtc, ready.identity.creationTimeUtc);
    const negativeStopped = (await readJson<Heartbeat>(negativeHeartbeat))!;
    const afterClose = await eventually(async () => {
      const value = await readJson<Heartbeat>(heartbeat);
      return value && value.ticks >= ready.heartbeat.ticks + 12 ? value : undefined;
    });
    assert.equal(afterClose.pid, managedPid);
    assert.equal(afterClose.nonce, nonce);
    const independent = startPowerShell(schedulerArgs("Inspect", inspectReceiptFile), directory);
    const inspectionResult = await independent.finished;
    assert.equal(inspectionResult.code, 0, inspectionResult.stderr);
    const inspection = (await readJson<SchedulerReceipt>(inspectReceiptFile))!;
    assert.equal(inspection.state, "inspected", inspection.error ?? "No independent process inspection receipt");
    assert.equal(inspection.inspectorPid, independent.child.pid);
    assert.notEqual(inspection.inspectorPid, running.caller.pid);
    assert.notEqual(inspection.inspectorPid, running.jobHostPid);
    assert.equal(inspection.identity.pid, managedPid);
    assert.equal(inspection.identity.creationTimeUtc, ready.identity.creationTimeUtc);
    assert.equal(inspection.identity.executable.toLowerCase(), process.execPath.toLowerCase());
    assert.equal(inspection.heartbeat.pid, managedPid);
    assert.equal(inspection.heartbeat.nonce, nonce);
    assert.ok(inspection.heartbeat.ticks > afterClose.ticks);
    assert.equal(inspection.instanceCount, 1);
    assert.equal(inspection.instanceId, ready.instanceId);
    assert.equal(inspection.enginePid, ready.enginePid);
    assert.equal(inspection.engineAncestry, true);
    assert.equal(inspection.scheduleAncestry, true);
    assert.deepEqual(await readJson(negativeHeartbeat), negativeStopped);
    t.diagnostic(JSON.stringify({ privateJobCallerPid: running.caller.pid, negativePid, managedPid,
      managedCreationTimeUtc: ready.identity.creationTimeUtc, privateJobFlags: closed.jobFlags,
      managedInPrivateJob: closed.probesBefore[0].inJob, callerAfterCloseAlive: closed.callerAfter.alive,
      negativeAfterCloseAlive: closed.negativeAfter.alive, independentInspectorPid: inspection.inspectorPid,
      ticksBeforeClose: ready.heartbeat.ticks, ticksAfterIndependentInspection: inspection.heartbeat.ticks }));
  } finally {
    // First close only our Job. Do not kill any external PID or inherited Codex Job.
    await writeFile(close, "fixture cleanup");
    if (job) await job.finished;
    if (!managedPid) {
      const ownedHeartbeat = await readJson<Heartbeat>(heartbeat);
      if (ownedHeartbeat?.nonce === nonce) managedPid = ownedHeartbeat.pid;
    }
    await writeFile(stop, "owned managed fixture self-exit");
    await writeFile(negativeStop, "owned negative fixture self-exit");
    const cleanup = startPowerShell(schedulerArgs("Cleanup", cleanupReceiptFile), directory);
    const cleanupResult = await cleanup.finished;
    assert.equal(cleanupResult.code, 0, cleanupResult.stderr);
    if (managedPid) await eventually(async () => !alive(managedPid!) ? true : undefined, 10_000);
    if (negativePid) await eventually(async () => !alive(negativePid!) ? true : undefined, 10_000);
    // Nonrecursive deletion in our fresh temp directory only. Verify its resolved
    // location before unlinking; no task receipt can select another directory.
    assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.match(path.basename(directory), /^corescope-job-test /);
    for (const name of await readdir(directory)) await unlink(path.join(directory, name));
    await rmdir(directory);
  }
});
