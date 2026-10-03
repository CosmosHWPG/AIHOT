import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

test("native IPC shutdown waits for the application's graceful handler and forwards CLI arguments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "corescope-runtime-test-"));
  const entry = path.join(directory, "app.mjs");
  const marker = path.join(directory, "closed.json");
  await writeFile(entry, `import { writeFile } from "node:fs/promises";
process.on("SIGTERM", async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await writeFile(process.argv[2], JSON.stringify({ stopped: true, argument: process.argv[3] }));
  process.exit(0);
});
setInterval(() => {}, 1000);
`);
  const child = fork(path.resolve(import.meta.dirname, "../scripts/corescope-runtime-child.ts"), [entry, marker, "--watch"], {
    execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" },
  });
  try {
    const [message] = await once(child, "message");
    assert.equal(message.ready, true);
    assert.equal(message.pid, child.pid);
    const exited = once(child, "exit");
    child.send({ action: "shutdown" });
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { stopped: true, argument: "--watch" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await unlink(marker).catch(() => {});
    await unlink(entry);
    await rmdir(directory);
  }
});

test("a drained watch entry exits naturally after closing resources, without an explicit process.exit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "corescope-runtime-test-"));
  const entry = path.join(directory, "watch.mjs");
  const marker = path.join(directory, "drained.json");
  await writeFile(entry, `import { writeFile } from "node:fs/promises";
await new Promise((resolve) => {
  process.on("SIGTERM", resolve);
  process.send({ ready: true, pid: process.pid });
});
await writeFile(process.argv[2], JSON.stringify({ drained: true }));
`);
  const child = fork(path.resolve(import.meta.dirname, "../scripts/corescope-runtime-child.ts"), [entry, marker], {
    execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" },
  });
  try {
    const [message] = await once(child, "message");
    assert.equal(message.ready, true);
    const exited = once(child, "exit");
    child.send({ action: "shutdown" });
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { drained: true });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await unlink(marker).catch(() => {});
    await unlink(entry);
    await rmdir(directory);
  }
});
