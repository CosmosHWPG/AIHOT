// One pass by default; --watch is the local supervisor's continuously running bridge.
// Export raw material first, then atomically acknowledge only committed batches.
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { REPO_ROOT } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { exportState, importBatch } from "./corescope-v2-core.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const watch = args.includes("--watch");
const bootstrap = args.includes("--bootstrap");
const file = option("--file");
const limit = Number(option("--limit") ?? process.env.CORESCOPE_V2_BATCH_LIMIT ?? 6);
const pollSeconds = Number(process.env.CORESCOPE_V2_POLL_SECONDS ?? 120);
const db = option("--db") ?? process.env.V2_DATABASE;
const dataDir = path.join(REPO_ROOT, ".data/v2-bridge");
if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw new Error("Bridge --limit must be 1..60");
if (!Number.isFinite(pollSeconds) || pollSeconds < 10) throw new Error("CORESCOPE_V2_POLL_SECONDS must be >=10");
if (!file && !db) throw new Error("Set V2_DATABASE to a local SQLite path, or use --file batch.json");
if (watch && (file || bootstrap)) throw new Error("--watch cannot be combined with --file or --bootstrap");
mkdirSync(dataDir, { recursive: true });
let stopping = false;
let wake: (() => void) | null = null;
for (const name of ["SIGINT", "SIGTERM"] as const) process.on(name, () => { stopping = true; wake?.(); });
if (watch) process.send?.({ ready: true, pid: process.pid });

async function python(argv: string[]) {
  const executable = process.env.PYTHON_EXE || "python";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [path.join(REPO_ROOT, "scripts/corescope-v2-export.py"), ...argv],
      { cwd: REPO_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" } });
    let error = "";
    child.stdout.on("data", (part: Buffer) => process.stdout.write(part));
    child.stderr.on("data", (part: Buffer) => { error += part.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`V2 read-only export failed (${code}): ${error.slice(-2000)}`)));
  });
}

async function run() {
  let batchFile = file;
  if (!batchFile) {
    const state = await exportState();
    if (bootstrap && state.cursor) throw new Error("Bootstrap is only valid before bridge progress exists; use ordinary sync for subsequent batches");
    const stateFile = path.join(dataDir, "export-state.json");
    writeFileSync(stateFile, JSON.stringify(state), "utf8");
    batchFile = path.join(dataDir, "batch.json");
    const argv = ["--db", db!, "--out", batchFile, "--state", stateFile, "--limit", String(limit)];
    if (bootstrap) argv.push("--bootstrap");
    if (option("--since")) argv.push("--since", option("--since")!);
    if (option("--article-ids")) argv.push("--article-ids", option("--article-ids")!);
    if (process.env.SITE_URL) argv.push("--self-url", process.env.SITE_URL);
    await python(argv);
  }
  const batch = JSON.parse(readFileSync(batchFile, "utf8"));
  const receipt = await importBatch(batch);
  console.log(JSON.stringify({ bridge: "corescope-v2", ...receipt, cursorAfter: batch.cursorAfter, dataLatest: batch.dataLatest }));
}

try {
  do {
    try { await run(); }
    catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 2000);
      await sql`INSERT INTO corescope_bridge_state (client,last_error,last_error_at) VALUES ('corescope-v2',${message},now())
        ON CONFLICT (client) DO UPDATE SET last_error=excluded.last_error,last_error_at=now(),updated_at=now()`;
      console.error(`[corescope-v2] ${message}`);
      if (!watch) throw error;
    }
    if (watch && !stopping) await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { wake = null; resolve(); }, pollSeconds * 1000);
      wake = () => { clearTimeout(timer); wake = null; resolve(); };
    });
  } while (watch && !stopping);
} finally {
  await stopBoss();
  await closeDb();
}
