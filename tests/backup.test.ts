import { pollFor } from "./poll.ts";
// Backups restore: a real database dump and file archive (uploads and feedback screenshots) are
// unpacked and read back; the object store is a stand-in inside this process. A missing uploads directory
// needs no file archive, an unreadable one is not; a file archive that fails still ships the database and
// reports tar's own words, not the command line in front of them.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import childProcess, { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import fs, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { submitFeedback } from "@aihot/backend/operations/feedback";

const run = promisify(execFile);
const originalExecFile = execFile;
const commandName = (file: string) => path.basename(file, ".exe");
type BackupCommand = (file: string, args: string[], options?: childProcess.ExecFileOptions) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
let runBackupCommand: BackupCommand = run;
// Capture a real executor with a controllable subprocess boundary, without shell scripts on PATH.
childProcess.execFile = Object.assign(originalExecFile.bind(childProcess), {
  [promisify.custom]: (file: string, args: string[], options?: childProcess.ExecFileOptions) => runBackupCommand(file, args, options),
});
syncBuiltinESMExports();
const { runBackup, backupConfigured } = await import("@aihot/backend/operations/backup").finally(() => {
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
});
const T = tag();
const originalDataDir = config.dataDir;
const originalFetch = globalThis.fetch;
const env = {
  DB_BACKUP_STORE_SECRET_ID: "test-backup-id", DB_BACKUP_STORE_SECRET_KEY: "test-backup-key",
  DB_BACKUP_STORE_BUCKET: "test-bucket", DB_BACKUP_STORE_REGION: "test-region", DB_BACKUP_STORE_DOMAIN: "backup.invalid",
  FEISHU_INTERNAL_ENABLED: "false",
};
const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const roots: string[] = [];
const databases = new Set<string>();
const objects = new Map<string, Buffer>();
const PNG = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#808080" } }).png().toBuffer();
const NOW = new Date("2026-11-01T04:00:00Z");
// Backups are named after the database ("news_db" → news-db-…).
const stem = sql.options.database.toLowerCase().replace(/[^a-z0-9]+/g, "-");

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, "https://backup.invalid", "the backup fixture must not contact any real service");
  const chunks: Buffer[] = [];
  for await (const chunk of init!.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  objects.set(url.pathname.slice(1), Buffer.concat(chunks));
  return new Response(null, { status: 200 });
}) as typeof fetch;

beforeEach(async () => {
  config.dataDir = await mkdtemp(path.join(tmpdir(), "aihot-backup-files-"));
  roots.push(config.dataDir);
  objects.clear();
});
after(async () => {
  globalThis.fetch = originalFetch;
  config.dataDir = originalDataDir;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const name of databases) await sql.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await closeDb();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function extractSavedFiles() {
  const destination = await mkdtemp(path.join(tmpdir(), "aihot-backup-restored-"));
  roots.push(destination);
  const archive = objects.get(`monthly/${stem}-files-202611010400.tar.gz`);
  assert.ok(archive, "backup must supply the real file archive");
  const archivePath = path.join(destination, "files.tar.gz");
  await writeFile(archivePath, archive);
  const data = path.join(destination, "data");
  await mkdir(data);
  await run("tar", ["-xzf", path.basename(archivePath), "-C", path.basename(data)], { cwd: destination });
  return { destination, data };
}

test("a real paired restore opens a feedback screenshot when forwarding is disabled and uploads are absent", async () => {
  const content = `Fictional backup feedback ${T}`;
  const { id } = await submitFeedback({ content, screenshot: { mime: "image/png", data: PNG }, ip: "203.0.113.220", userAgent: `test-${T}` });
  const [before] = await sql`SELECT screenshot_key, forward_error FROM feedback WHERE id = ${id}`;
  assert.match(before!.screenshot_key, /^local:/);
  assert.equal(before!.forward_error, "pending");
  const externalKey = `feishu:synthetic-${T}`;
  const [external] = await sql<{ id: number }[]>`INSERT INTO feedback (content, source_hash, screenshot_key) VALUES ('Fictional external reference', ${`external:${T}`}, ${externalKey}) RETURNING id`;
  const summary = await runBackup(NOW);
  assert.equal(summary.uploaded, true);
  const { destination, data } = await extractSavedFiles();
  const dump = objects.get(`monthly/${stem}-202611010400.dump`);
  assert.ok(dump, "backup must supply the real database dump");
  const dumpPath = path.join(destination, "database.dump");
  await writeFile(dumpPath, dump);
  // Next to this file's own database, and dropped with it.
  const name = `${new URL(config.databaseUrl).pathname.slice(1)}_restore_test`;
  assert.match(name, /^[a-z0-9_]+_test$/);
  await sql.unsafe(`CREATE DATABASE "${name}"`);
  databases.add(name);
  const restoredUrl = new URL(config.databaseUrl);
  restoredUrl.pathname = `/${name}`;
  await run("pg_restore", ["--exit-on-error", "--no-owner", "--dbname", restoredUrl.href, dumpPath], { maxBuffer: 16 * 1024 * 1024 });
  // A new process sees only the restored database and folder, never the original screenshot.
  await run(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { existsSync } from "node:fs";
    import { readFile } from "node:fs/promises";
    import { feedbackScreenshot } from "@aihot/backend/admin/feedback";
    import { closeDb, sql } from "@aihot/backend/db";
    try {
      const [row] = await sql\`SELECT content, screenshot_key FROM feedback WHERE id = \${Number(process.env.RESTORED_ID)}\`;
      assert.equal(row.content, process.env.RESTORED_CONTENT);
      assert.equal(row.screenshot_key, process.env.RESTORED_KEY);
      const [external] = await sql\`SELECT screenshot_key FROM feedback WHERE id = \${Number(process.env.RESTORED_EXTERNAL_ID)}\`;
      assert.equal(external.screenshot_key, process.env.RESTORED_EXTERNAL_KEY);
      assert.equal(await feedbackScreenshot(Number(process.env.RESTORED_EXTERNAL_ID)), null);
      const file = await feedbackScreenshot(Number(process.env.RESTORED_ID));
      assert.ok(file && existsSync(file), "restored local feedback screenshot must exist");
      assert.deepEqual(await readFile(file), Buffer.from(process.env.RESTORED_BYTES, "base64"));
    } finally { await closeDb(); }
  `], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DATABASE_URL: restoredUrl.href, AIHOT_DATA_DIR: data, RESTORED_ID: String(id), RESTORED_CONTENT: content, RESTORED_KEY: before!.screenshot_key, RESTORED_BYTES: PNG.toString("base64"), RESTORED_EXTERNAL_ID: String(external!.id), RESTORED_EXTERNAL_KEY: externalKey } });
});


async function save(relative: string, data = PNG) {
  const file = path.join(config.dataDir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

test("raw analytics events stay out of the dump, every other table's rows go in", async () => {
  // The privacy notice keeps raw analytics events 30 days; a backup lives up to 100.
  await runBackup(NOW);
  const dump = objects.get(`monthly/${stem}-202611010400.dump`);
  assert.ok(dump, "backup must supply the real database dump");
  const dumpPath = path.join(config.dataDir, "listed.dump");
  await writeFile(dumpPath, dump);
  const { stdout } = await run("pg_restore", ["--list", dumpPath], { maxBuffer: 64 * 1024 * 1024 });
  // Both analytics tables come from this edition's own migrations; an edition without them has neither to check.
  const [{ events, visitors }] = await sql<{ events: string | null; visitors: string | null }[]>`
    SELECT to_regclass('public.analytics_events')::text AS events, to_regclass('public.visitor_states')::text AS visitors`;
  if (events) assert.match(stdout, / TABLE public analytics_events /);
  assert.doesNotMatch(stdout, / TABLE DATA public analytics_events /);
  assert.match(stdout, / TABLE DATA public feedback /);
  if (visitors) assert.match(stdout, / TABLE DATA public visitor_states /);
});

test("an explicitly configured local backup restores real data and attachments without a cloud request", async () => {
  const local = await mkdtemp(path.join(tmpdir(), "corescope-local-backup-"));
  roots.push(local);
  const saved = process.env.DB_BACKUP_LOCAL_DIR;
  const cloud = Object.fromEntries(Object.keys(env).filter(key => key.startsWith("DB_BACKUP_STORE_")).map(key => [key, process.env[key]]));
  for (const key of Object.keys(cloud)) delete process.env[key];
  process.env.DB_BACKUP_LOCAL_DIR = local;
  try {
    assert.equal(backupConfigured(), true);
    const marker = `local-backup-${T}`;
    await sql`INSERT INTO settings(key,value) VALUES (${marker},'{"restored":true}')`;
    await save("uploads/nested/local.txt", Buffer.from("local restore fixture"));
    const summary = await runBackup(NOW);
    assert.equal(summary.uploaded, false);
    assert.equal(summary.destination, "local");
    assert.equal(summary.verified, true);
    assert.equal(objects.size, 0);
    const manifest = JSON.parse(await readFile(path.join(local, `${stem}-manifest-202611010400.json`), "utf8"));
    assert.deepEqual(manifest, summary);
    for (const object of summary.objects) {
      const file = path.join(local, object.key.replace(/^local-only:/, ""));
      assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), object.sha256);
    }
    const destination = await mkdtemp(path.join(tmpdir(), "corescope-local-restored-"));
    roots.push(destination);
    const restoreTar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    await run(restoreTar, ["-xzf", `${stem}-files-202611010400.tar.gz`, "-C", destination], { cwd: local });
    assert.equal(await readFile(path.join(destination, "uploads/nested/local.txt"), "utf8"), "local restore fixture");
    const name = `${new URL(config.databaseUrl).pathname.slice(1)}_local_restore_test`;
    assert.match(name, /^[a-z0-9_]+_test$/);
    await sql.unsafe(`CREATE DATABASE "${name}"`);
    databases.add(name);
    const restoredUrl = new URL(config.databaseUrl);
    restoredUrl.pathname = `/${name}`;
    await run("pg_restore", ["--exit-on-error", "--no-owner", "--dbname", restoredUrl.href, path.join(local, `${stem}-202611010400.dump`)], { maxBuffer: 16 * 1024 * 1024 });
    await run(process.execPath, ["--input-type=module", "--eval", `
      import { sql, closeDb } from "@aihot/backend/db";
      import assert from "node:assert/strict";
      try { assert.equal((await sql\`SELECT value->>'restored' AS restored FROM settings WHERE key=\${process.env.RESTORE_MARKER}\`)[0].restored, 'true'); }
      finally { await closeDb(); }
    `], { env: { ...process.env, DATABASE_URL: restoredUrl.href, RESTORE_MARKER: marker } });
  } finally {
    if (saved === undefined) delete process.env.DB_BACKUP_LOCAL_DIR; else process.env.DB_BACKUP_LOCAL_DIR = saved;
    for (const [key, value] of Object.entries(cloud)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("a local backup cannot write inside the files it archives", async () => {
  const saved = process.env.DB_BACKUP_LOCAL_DIR;
  try {
    process.env.DB_BACKUP_LOCAL_DIR = path.join(config.dataDir, "uploads", "backups");
    await assert.rejects(runBackup(NOW), /cannot be inside an attachment directory/);
    process.env.DB_BACKUP_LOCAL_DIR = "relative-backups";
    await assert.rejects(runBackup(NOW), /absolute directory/);
  } finally { if (saved === undefined) delete process.env.DB_BACKUP_LOCAL_DIR; else process.env.DB_BACKUP_LOCAL_DIR = saved; }
});

test("Windows scheduled backups use the project's portable PostgreSQL tools without a global installation", { skip: process.platform !== "win32" }, async () => {
  const directory = path.join(config.dataDir, "runtime", "pgsql", "bin");
  await mkdir(directory, { recursive: true });
  for (const name of ["pg_dump", "pg_restore"]) await writeFile(path.join(directory, `${name}.exe`), "fixture tool boundary");
  const commands: string[] = [];
  runBackupCommand = (file, args, options) => {
    if (["pg_dump", "pg_restore"].includes(commandName(file))) {
      assert.equal(path.dirname(file), directory);
      commands.push(commandName(file));
      return run(commandName(file), args, options);
    }
    return run(file, args, options);
  };
  try {
    assert.equal((await runBackup(NOW)).verified, true);
    assert.deepEqual(commands, ["pg_dump", "pg_restore"]);
  } finally { runBackupCommand = run; }
});

test("failed local generations cannot evict an older complete database and attachment pair", async () => {
  const local = await mkdtemp(path.join(tmpdir(), "corescope-local-retention-"));
  roots.push(local);
  const saved = process.env.DB_BACKUP_LOCAL_DIR;
  process.env.DB_BACKUP_LOCAL_DIR = local;
  try {
    await save("uploads/retained.txt", Buffer.from("retained pair"));
    await runBackup(NOW);
    for (const day of [2, 3]) {
      runBackupCommand = (file, args, options) => {
        if (commandName(file) === "tar" && args.includes("-czf")) return Promise.reject(new Error("fictional local packing failure"));
        return run(file, args, options);
      };
      try { await assert.rejects(runBackup(new Date(`2026-11-0${day}T04:00:00Z`)), /fictional local packing failure/); }
      finally { runBackupCommand = run; }
    }
    const legacy = `${stem}-202610010400.dump`;
    await writeFile(path.join(local, legacy), "preexisting unmanaged restore point");
    await runBackup(new Date("2026-11-04T04:00:00Z"));
    let files = await readdir(local);
    assert.ok(files.includes(`${stem}-202611010400.dump`));
    assert.ok(files.includes(`${stem}-files-202611010400.tar.gz`));
    assert.ok(!files.includes(`${stem}-202611020400.dump`));
    assert.ok(!files.includes(`${stem}-202611030400.dump`));
    assert.equal(await readFile(path.join(local, legacy), "utf8"), "preexisting unmanaged restore point");
    for (const day of [5, 6]) await runBackup(new Date(`2026-11-0${day}T04:00:00Z`));
    files = await readdir(local);
    assert.ok(!files.some(file => file.includes("202611010400")));
    for (const day of [4, 5, 6]) for (const suffix of [`${stem}-2026110${day}0400.dump`, `${stem}-files-2026110${day}0400.tar.gz`, `${stem}-manifest-2026110${day}0400.json`]) assert.ok(files.includes(suffix));
  } finally { if (saved === undefined) delete process.env.DB_BACKUP_LOCAL_DIR; else process.env.DB_BACKUP_LOCAL_DIR = saved; }
});

test("both attachment roots restore nested paths and bytes, without caches or previous backups", async () => {
  const upload = Buffer.from("fictional uploaded file");
  await save("uploads/nested/user-file.bin", upload);
  await save("feedback-screenshots/local.png");
  for (const dir of ["imgcache", "ogcache", "backups"]) await save(`${dir}/excluded.bin`, Buffer.from("not an attachment"));
  const summary = await runBackup(NOW);
  assert.equal(summary.uploaded, true);
  const { data } = await extractSavedFiles();
  assert.deepEqual((await readdir(data)).sort(), ["feedback-screenshots", "uploads"]);
  assert.deepEqual(await readFile(path.join(data, "uploads/nested/user-file.bin")), upload);
  assert.deepEqual(await readFile(path.join(data, "feedback-screenshots/local.png")), PNG);
  assert.deepEqual([...objects.keys()].sort(), ["monthly"].flatMap(prefix => [`${prefix}/${stem}-202611010400.dump`, `${prefix}/${stem}-files-202611010400.tar.gz`]).sort());
  for (const object of summary.objects) assert.equal(object.sha256, createHash("sha256").update(objects.get(object.key)!).digest("hex"));
});


// One root present and the other absent is the first test (screenshots kept, uploads absent).
for (const dirs of [[], ["uploads", "feedback-screenshots"], ["uploads/empty/nested"]]) {
  test(`missing/empty roots produce only the database backup: ${dirs.join("+") || "neither"}`, async () => {
    for (const dir of dirs) await mkdir(path.join(config.dataDir, dir), { recursive: true });
    const summary = await runBackup(NOW);
    assert.equal(summary.uploaded, true);
    assert.equal(summary.objects.length, 1);
    assert.ok(summary.objects[0]!.key.endsWith(".dump"));
    assert.equal((await readdir(path.join(config.dataDir, "backups"))).length, 1);
  });
}

test("an invalid upload root cannot become a successful empty backup", async () => {
  assert.equal((await runBackup(NOW)).uploaded, true);
  const shipped = objects.size;
  await save("uploads");
  await assert.rejects(runBackup(new Date("2026-11-01T04:01:00Z")), /uploads path is not a directory/);
  assert.equal(objects.size, shipped + 1, "ship the new database without an empty replacement for the attachments");
  const [after] = await sql`SELECT value FROM settings WHERE key = 'backup.last'`;
  assert.equal(after!.value.uploaded, false, "an invalid attachment path cannot count as a successful backup");
  assert.match(after!.value.filesError, /uploads path is not a directory/);
});

test("unreadable nested directories still ship the database and fail the attachment backup", async (t) => {
  await save("uploads/restricted/file.txt", Buffer.from("fixture"));
  const uploads = path.join(config.dataDir, "uploads");
  const read = fs.readdir;
  // Windows chmod cannot make the directory unreadable, and CI can run as root.
  const mock = t.mock.method(fs, "readdir", async (dir: string, options?: { recursive?: boolean }) => {
    if (dir === uploads && options?.recursive) throw new Error("EACCES: permission denied reading uploads/restricted");
    return read(dir, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(runBackup(NOW), /database backed up, but the file archive failed:.*EACCES/);
    assert.equal(objects.size, 1);
    assert.ok([...objects.keys()][0]!.endsWith(".dump"));
    const [row] = await sql`SELECT value FROM settings WHERE key = 'backup.last'`;
    assert.equal(row!.value.uploaded, false);
    assert.match(row!.value.filesError, /EACCES/);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

async function withPackingFailures(failures: number, action: (count: () => number) => Promise<void>) {
  let count = 0;
  runBackupCommand = (file, args, options) => {
    if (commandName(file) === "tar" && ++count <= failures) {
      return run(process.execPath, ["--eval", "console.error('fictional packing failure'); process.exit(2)"], options);
    }
    return run(file, args, options);
  };
  try { await action(() => count); }
  finally { runBackupCommand = run; }
}

test("packing retries once and a successful retry preserves the screenshot", async () => {
  await save("feedback-screenshots/retry.png");
  await withPackingFailures(1, async count => {
    assert.equal((await runBackup(NOW)).uploaded, true);
    assert.equal(count(), 2);
  });
  const { data } = await extractSavedFiles();
  assert.deepEqual(await readFile(path.join(data, "feedback-screenshots/retry.png")), PNG);
});

test("persistent packing failure still sends the database and reports incomplete backup", async () => {
  await save("feedback-screenshots/failure.png");
  await withPackingFailures(2, async count => {
    await assert.rejects(runBackup(NOW), /database backed up, but the file archive failed: fictional packing failure/);
    assert.equal(count(), 2);
  });
  assert.equal(objects.size, 1);
  assert.ok([...objects.keys()].every(key => key.endsWith(".dump")));
  const [row] = await sql`SELECT value FROM settings WHERE key = 'backup.last'`;
  assert.equal(row!.value.uploaded, false);
  assert.match(row!.value.filesError, /^fictional packing failure/);
  assert.doesNotMatch(row!.value.filesError, /Command failed|-czf/, "the command line would crowd out the reason");
  assert.equal(row!.value.objects.length, 1);
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots/failure.png")), PNG);
});

test("local retention keeps three dump/archive pairs without deleting source attachments", async () => {
  await save("feedback-screenshots/retained.png");
  for (const day of [1, 2, 3, 4]) await runBackup(new Date(`2026-11-0${day}T04:00:00Z`));
  assert.deepEqual((await readdir(path.join(config.dataDir, "backups"))).sort(), [2, 3, 4].flatMap(day => [`${stem}-2026110${day}0400.dump`, `${stem}-files-2026110${day}0400.tar.gz`]).sort());
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots/retained.png")), PNG);
});

test("a failed database dump keeps connection credentials out of argv and the reported error", async () => {
  const originalUrl = config.databaseUrl;
  const connection = new URL(originalUrl);
  connection.username = "fictional-backup-user";
  connection.password = "fictional-p@ss:word";
  config.databaseUrl = connection.href;
  let invocations = 0;
  runBackupCommand = (file, args, options) => {
    if (commandName(file) !== "pg_dump") return run(file, args, options);
    invocations += 1;
    assert.doesNotMatch(JSON.stringify(args), /fictional-backup-user|fictional-p|p%40ss|word@/);
    assert.equal(options?.env?.PGUSER, "fictional-backup-user");
    assert.equal(options?.env?.PGPASSWORD, "fictional-p@ss:word");
    return run(process.execPath, ["--eval", "console.error('fictional dump refusal'); process.exit(2)", "--", ...args], options);
  };
  try {
    for (const queryCredentials of [false, true]) {
      if (queryCredentials) {
        connection.username = connection.password = "";
        connection.searchParams.set("user", "fictional-backup-user");
        connection.searchParams.set("password", "fictional-p@ss:word");
        config.databaseUrl = connection.href;
      }
      await assert.rejects(runBackup(NOW), (error: Error) => {
        assert.match(error.message, /fictional dump refusal/);
        assert.doesNotMatch(error.message, /fictional-backup-user|fictional-p|p%40ss|word@/);
        return true;
      });
    }
    assert.equal(invocations, 2);
    assert.equal(objects.size, 0);
  } finally {
    config.databaseUrl = originalUrl;
    runBackupCommand = run;
  }
});


// A release must let the real dump/archive finish and record its uploaded pair before the worker exits.
// Killing every process with SIGTERM used to interrupt pg_dump (and make tar need a second attempt).
for (const phase of ["pg_dump", "tar"] as const) {
  test(`worker stop drains a real ${phase} without terminating or restarting it`, { timeout: 30_000 }, async () => {
    if (phase === "pg_dump") await sql`CREATE TABLE IF NOT EXISTS backup_shutdown_probe (id integer)`;
    else await save("uploads/synthetic.bin", randomBytes(16 * 1024 * 1024));
    const windows = process.platform === "win32";
    const messages: Array<{ cmd?: string; pid?: number; ready?: boolean; stopping?: boolean; completed?: boolean; error?: string }> = [];
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import cp from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      import path from "node:path";
      const exec = cp.execFile;
      const tarRelease = Promise.withResolvers();
      cp.execFile = (file, args, options, callback) => {
        if (typeof options === "function") { callback = options; options = undefined; }
        const cmd = path.basename(file, ".exe");
        const child = exec(file, args, options, (...result) => {
          if (process.platform === "win32" && cmd === "tar") {
            // Windows has no SIGSTOP. Run the real archive and hold its result at the worker boundary.
            void tarRelease.promise.then(() => callback(...result));
          } else callback(...result);
        });
        process.send({ cmd, pid: child.pid });
        return child;
      };
      syncBuiltinESMExports();
      const { runBackup } = await import("@aihot/backend/operations/backup");
      const { getBoss, stopBoss } = await import("@aihot/backend/jobs/queue");
      const { closeDb } = await import("@aihot/backend/db");
      globalThis.fetch = async (input, init) => {
        assert.equal(new URL(input).origin, "https://backup.invalid");
        for await (const chunk of init.body) {} // consume the real dump/archive, never send it outside
        return new Response(null, { status: 200 });
      };
      const boss = await getBoss();
      const name = process.env.BACKUP_TEST_QUEUE;
      await boss.createQueue(name, { retryLimit: 0 });
      await boss.work(name, { pollingIntervalSeconds: 0.5 }, async () => {
        try { await runBackup(); process.send({ completed: true }); }
        catch (error) { process.send({ error: error.message }); throw error; }
      });
      process.once("SIGTERM", async () => {
        process.send({ stopping: true });
        await stopBoss();
        await closeDb();
        process.exit(0);
      });
      if (process.platform === "win32") {
        const { childShutdownController } = await import("./scripts/corescope-runtime-child.ts");
        const shutdown = childShutdownController({
          hasHandler: () => process.listenerCount("SIGTERM") > 0,
          signal: () => process.emit("SIGTERM", "SIGTERM"),
          exit: (code) => process.exit(code),
        });
        shutdown.loaded();
        process.on("message", (message) => {
          if (message?.action === "shutdown") shutdown.request();
          if (message?.action === "release-tar") tarRelease.resolve();
        });
      }
      process.once("message", async () => { await boss.send(name, {}); });
      process.send({ ready: true });
    `], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, AIHOT_DATA_DIR: config.dataDir, BACKUP_TEST_QUEUE: `test.backup.shutdown.${phase}` }, detached: true, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    child.on("message", message => messages.push(message as typeof messages[number]));
    const exited = once(child, "exit");
    const wait = async (condition: () => boolean | Promise<boolean>) => {
      await pollFor(async () => {
        assert.ok(child.exitCode === null && child.signalCode === null, `backup phase not reached: ${stderr} ${JSON.stringify(messages)}`);
        return condition();
      }, "backup phase", 15_000);
    };
    let held: number | undefined;
    let locked: Awaited<ReturnType<typeof sql.reserve>> | undefined;
    try {
      if (phase === "pg_dump") {
        locked = await sql.reserve();
        await locked`BEGIN`;
        await locked`LOCK TABLE backup_shutdown_probe IN ACCESS EXCLUSIVE MODE`;
      }
      await wait(() => messages.some(message => message.ready));
      child.send({ action: "backup" });
      await wait(() => messages.some(message => message.cmd === phase));
      if (phase === "pg_dump") {
        await wait(async () => (await sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'pg_dump' AND wait_event_type = 'Lock'`).length > 0);
      } else if (!windows) {
        held = messages.find(message => message.cmd === phase)!.pid!;
        process.kill(held, "SIGSTOP");
      }
      // The supervisor sends the graceful signal to the worker, which owns its child lifetimes.
      if (windows) child.send({ action: "shutdown" });
      else process.kill(child.pid!, "SIGTERM");
      await wait(() => messages.some(message => message.stopping));
      assert.ok(!messages.some(message => message.completed), "stop must wait for the active backup");
      if (locked) await locked`ROLLBACK`;
      if (held) { process.kill(held, "SIGCONT"); held = undefined; }
      if (windows && phase === "tar") child.send({ action: "release-tar" });
      await pollFor(() => child.exitCode !== null || child.signalCode !== null, "backup worker exit", 8000);
      const [code, signal] = await exited;
      assert.equal(signal, null, stderr);
      assert.equal(code, 0, stderr);
      assert.ok(messages.some(message => message.completed), JSON.stringify(messages));
      assert.equal(messages.filter(message => message.cmd === phase).length, 1, "shutdown must not restart a killed backup subprocess");
    } finally {
      try {
        if (locked) await locked`ROLLBACK`;
      } finally {
        locked?.release();
        if (held) process.kill(held, "SIGCONT");
        if (child.exitCode === null && child.signalCode === null) {
          process.kill(windows ? child.pid! : -child.pid!, "SIGKILL");
          await exited;
        }
      }
    }
  });
}

test("a real dump preserves libpq query parameter escaping", async () => {
  const originalUrl = config.databaseUrl;
  config.databaseUrl = `${originalUrl}${originalUrl.includes("?") ? "&" : "?"}options=-c%20statement_timeout%3D0&application_name=fictional%2Bbackup`;
  try { assert.equal((await runBackup(NOW)).uploaded, true); }
  finally { config.databaseUrl = originalUrl; }
});
