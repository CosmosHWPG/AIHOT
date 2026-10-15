import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { launchDetached, loadLaunchEnvironment } from "../scripts/corescope-runtime-launch.ts";

interface Heartbeat { pid: number; nonce: string; ticks: number }
interface ParentReady { parentPid: number; childPid: number; nonce: string }
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return undefined; }
}

async function eventually<T>(probe: () => Promise<T | undefined>, timeout = 6_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await pause(50);
  }
  throw new Error("Timed out waiting for the isolated fake process");
}

async function fakeFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "corescope-detach-test-"));
  const nonce = randomUUID();
  const heartbeat = path.join(directory, "heartbeat.json");
  const stop = path.join(directory, "stop");
  const entry = path.join(directory, "heartbeat.mjs");
  await writeFile(entry, `import fs from "node:fs";
const heartbeat = ${JSON.stringify(heartbeat)};
const stop = ${JSON.stringify(stop)};
const nonce = ${JSON.stringify(nonce)};
const started = Date.now();
let ticks = 0;
function tick() {
  if (fs.existsSync(stop) || Date.now() - started > 12000) process.exit(0);
  fs.writeFileSync(heartbeat, JSON.stringify({ pid: process.pid, nonce, ticks: ++ticks }));
}
tick();
setInterval(tick, 75);
`);
  return { directory, nonce, heartbeat, stop, entry,
    stdout: path.join(directory, "stdout.log"), stderr: path.join(directory, "stderr.log") };
}

async function cleanup(directory: string, stop: string, childPid?: number, parent?: ChildProcess) {
  await writeFile(stop, "self-exit isolated fake child");
  if (parent && parent.exitCode === null && parent.signalCode === null) parent.kill();
  if (childPid !== undefined) await eventually(async () => !alive(childPid) ? true : undefined, 14_000);
  if (parent) await eventually(async () => parent.exitCode !== null || parent.signalCode !== null ? true : undefined);
  // Only unlink files in the fresh temporary fixture; never recurse through a checkout.
  for (const name of await readdir(directory)) await unlink(path.join(directory, name));
  await rmdir(directory);
}

// These exercise parent lifetime and file stdio. Closing a Windows console window
// produces a different control event and still requires a real-window acceptance check.
for (const mode of ["natural-exit", "terminated-parent"] as const) {
  test(`detached background heartbeat survives ${mode}`, { timeout: 25_000 }, async () => {
    const fixture = await fakeFixture();
    const { directory, nonce, heartbeat, stop, entry, stdout, stderr } = fixture;
    const parentEntry = path.join(directory, "parent.mjs");
    const readyFile = path.join(directory, "parent-ready.json");
    const helper = pathToFileURL(path.resolve(import.meta.dirname, "../scripts/corescope-runtime-launch.ts")).href;
    await writeFile(parentEntry, `import fs from "node:fs";
import { launchDetached } from ${JSON.stringify(helper)};
const launched = await launchDetached(process.execPath, [${JSON.stringify(entry)}], {
  cwd: ${JSON.stringify(directory)}, stdout: ${JSON.stringify(stdout)}, stderr: ${JSON.stringify(stderr)},
});
fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ parentPid: process.pid, childPid: launched.pid, nonce: ${JSON.stringify(nonce)} }));
${mode === "terminated-parent" ? "const started = Date.now(); setInterval(() => { if (Date.now() - started > 15000) process.exit(0); }, 100);" : ""}
`);
    const parent = spawn(process.execPath, [parentEntry], {
      cwd: directory, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    let parentErrors = "";
    parent.stderr!.on("data", (chunk) => { parentErrors += chunk.toString(); });
    let childPid: number | undefined;
    const parentExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      parent.once("exit", (code, signal) => resolve({ code, signal }));
      parent.once("error", reject);
    });
    try {
      const ready = await eventually(async () => {
        if (parent.exitCode !== null && parent.exitCode !== 0) throw new Error(`Fake parent exited: ${parentErrors}`);
        return readJson<ParentReady>(readyFile);
      });
      assert.equal(ready.parentPid, parent.pid);
      assert.equal(ready.nonce, nonce);
      childPid = ready.childPid;
      const before = await eventually(async () => {
        const value = await readJson<Heartbeat>(heartbeat);
        return value && value.ticks >= 3 ? value : undefined;
      });
      assert.equal(before.pid, childPid);
      assert.equal(before.nonce, nonce);
      if (mode === "terminated-parent") {
        assert.equal(parent.exitCode, null);
        assert.equal(parent.signalCode, null);
        assert.equal(parent.kill(), true); // This ChildProcess is the fixture's own fake parent.
      }
      const exited = await parentExit;
      if (mode === "natural-exit") assert.equal(exited.code, 0);
      assert.equal(alive(ready.parentPid), false);
      assert.equal(alive(childPid), true);
      const after = await eventually(async () => {
        const value = await readJson<Heartbeat>(heartbeat);
        return value && value.ticks >= before.ticks + 8 ? value : undefined;
      });
      assert.equal(after.pid, childPid);
      assert.equal(after.nonce, nonce);
    } finally {
      await cleanup(directory, stop, childPid, parent);
    }
  });
}

test("the attached referenced control keeps its fake parent alive until the child exits", { timeout: 25_000 }, async () => {
  const fixture = await fakeFixture();
  const { directory, nonce, heartbeat, stop, entry, stdout, stderr } = fixture;
  const parentEntry = path.join(directory, "referenced-parent.mjs");
  const readyFile = path.join(directory, "parent-ready.json");
  await writeFile(parentEntry, `import fs from "node:fs";
import { spawn } from "node:child_process";
const out = fs.openSync(${JSON.stringify(stdout)}, 'a');
const err = fs.openSync(${JSON.stringify(stderr)}, 'a');
const child = spawn(process.execPath, [${JSON.stringify(entry)}], {
  cwd: ${JSON.stringify(directory)}, detached: false, windowsHide: true, stdio: ['ignore', out, err],
});
fs.closeSync(out);
fs.closeSync(err);
fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ parentPid: process.pid, childPid: child.pid, nonce: ${JSON.stringify(nonce)} }));
// No timer or child.unref(): only the referenced child handle holds this parent open.
`);
  const parent = spawn(process.execPath, [parentEntry], {
    cwd: directory, windowsHide: true, stdio: ["ignore", "ignore", "ignore"],
  });
  const parentExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    parent.once("exit", (code, signal) => resolve({ code, signal }));
    parent.once("error", reject);
  });
  let childPid: number | undefined;
  try {
    const ready = await eventually(async () => readJson<ParentReady>(readyFile));
    assert.equal(ready.parentPid, parent.pid);
    assert.equal(ready.nonce, nonce);
    childPid = ready.childPid;
    const progress = await eventually(async () => {
      const value = await readJson<Heartbeat>(heartbeat);
      return value && value.ticks >= 11 ? value : undefined;
    });
    assert.equal(progress.pid, childPid);
    assert.equal(progress.nonce, nonce);
    assert.equal(parent.exitCode, null);
    assert.equal(parent.signalCode, null);
    assert.equal(alive(ready.parentPid), true);
    await writeFile(stop, "let the referenced control child exit naturally");
    await eventually(async () => parent.exitCode !== null ? true : undefined);
    assert.deepEqual(await parentExit, { code: 0, signal: null });
    assert.equal(alive(childPid), false);
  } finally {
    await cleanup(directory, stop, childPid, parent);
  }
});

test("detached control invocation preserves its real exit code and file logs", { timeout: 10_000 }, async () => {
  const fixture = await fakeFixture();
  try {
    const result = await launchDetached(process.execPath, ["-e", "console.log(process.argv[1]); console.error('fake stderr'); process.exit(7)", "forwarded argument"], {
      cwd: fixture.directory, stdout: fixture.stdout, stderr: fixture.stderr, waitForExit: true, timeoutMs: 5_000,
    });
    assert.equal(result.exitCode, 7);
    assert.equal(result.signal, null);
    assert.equal(alive(result.pid), false);
    assert.match(await readFile(fixture.stdout, "utf8"), /forwarded argument/);
    assert.match(await readFile(fixture.stderr, "utf8"), /fake stderr/);
  } finally {
    await cleanup(fixture.directory, fixture.stop);
  }
});

test("a missing background executable rejects instead of reporting readiness", { timeout: 10_000 }, async () => {
  const fixture = await fakeFixture();
  try {
    await assert.rejects(launchDetached(path.join(fixture.directory, "missing-executable"), [], {
      cwd: fixture.directory, stdout: fixture.stdout, stderr: fixture.stderr,
    }), { code: "ENOENT" });
  } finally {
    await cleanup(fixture.directory, fixture.stop);
  }
});

test("a timed-out control invocation reports failure and leaves the owned child observable", { timeout: 25_000 }, async () => {
  const fixture = await fakeFixture();
  let childPid: number | undefined;
  try {
    const launched = launchDetached(process.execPath, [fixture.entry], {
      cwd: fixture.directory, stdout: fixture.stdout, stderr: fixture.stderr, waitForExit: true, timeoutMs: 700,
    });
    const rejected = assert.rejects(launched, /Background control timed out after 700 ms/);
    const heartbeat = await eventually(async () => readJson<Heartbeat>(fixture.heartbeat));
    assert.equal(heartbeat.nonce, fixture.nonce);
    childPid = heartbeat.pid;
    await rejected;
    assert.equal(alive(childPid), true);
  } finally {
    await cleanup(fixture.directory, fixture.stop, childPid);
  }
});

test("the private launch environment overrides ambient values without exposing credentials in file logs", { timeout: 10_000 }, async () => {
  const fixture = await fakeFixture();
  const configuredDatabase = "postgres://fake-user:fake-password@127.0.0.1:59999/fake_launch_test";
  const configuredKey = "fake-private-api-key";
  try {
    const envFile = path.join(fixture.directory, "fake.env");
    await writeFile(envFile, `DATABASE_URL=${configuredDatabase}\nAPI_PORT=59998\nMODEL_API_KEY=${configuredKey}\nNODE_ENV=development\n`);
    const inherited: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: "postgres://ambient-invalid/fake", API_PORT: "59997", MODEL_API_KEY: "ambient-key", NODE_ENV: "test" };
    if (process.platform === "win32") {
      delete inherited.DATABASE_URL;
      delete inherited.API_PORT;
      inherited.database_url = "postgres://ambient-invalid/fake";
      inherited.api_port = "59997";
    }
    const receipt = path.join(fixture.directory, "env-check.json");
    const code = `const fs = require('node:fs');
const expected = ${JSON.stringify({ database: configuredDatabase, key: configuredKey })};
const valid = process.env.DATABASE_URL === expected.database && process.env.API_PORT === '59998' && process.env.MODEL_API_KEY === expected.key && process.env.NODE_ENV === 'production';
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ valid, port: process.env.API_PORT, mode: process.env.NODE_ENV }));
console.log(valid ? 'fake environment verified' : 'fake environment failed');
process.exit(valid ? 0 : 9);`;
    const result = await launchDetached(process.execPath, ["-e", code], {
      cwd: fixture.directory, stdout: fixture.stdout, stderr: fixture.stderr,
      env: loadLaunchEnvironment(envFile, inherited), waitForExit: true, timeoutMs: 5_000,
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(await readJson(receipt), { valid: true, port: "59998", mode: "production" });
    const logs = await readFile(fixture.stdout, "utf8") + await readFile(fixture.stderr, "utf8");
    assert.match(logs, /fake environment verified/);
    assert.equal(logs.includes("fake-password"), false);
    assert.equal(logs.includes(configuredKey), false);
  } finally {
    await cleanup(fixture.directory, fixture.stop);
  }
});
