// Run invariant tests only against the independent disposable database. Real keys never enter tests.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";
import postgres from "postgres";

const root = path.resolve(import.meta.dirname, "..");
const deployment = parseEnv(readFileSync(path.join(root, ".env"), "utf8"));
const database = new URL(deployment.DATABASE_URL!);
if (!["localhost", "127.0.0.1"].includes(database.hostname) || database.port !== "5448" || database.pathname !== "/corescope") {
  throw new Error("Tests require the independent local CoreScope deployment on port 5448.");
}
database.pathname = "/corescope_test";
const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: database.href, NODE_ENV: "test", COLLECT_ENABLED: "false",
  FEISHU_CONTENT_PUSH_ENABLED: "false", FEISHU_INTERNAL_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false" };
for (const key of Object.keys(env)) {
  if (/API_KEY|TOKEN|SECRET|PASSWORD|BASE_URL|_MODEL$|^LLM_|^EMBEDDING_|^DEV_AUTH_|^AIHOT_CREDENTIALS_DIR$/.test(key) && key !== "DATABASE_URL") delete env[key];
}
// Tests explicitly enable model calls against their HTTP stubs; no real provider is configured.
env.MODEL_CALLS_ENABLED = "true";
const portableBin = path.join(root, ".data/runtime/pgsql/bin");
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
env[pathKey] = portableBin + path.delimiter + (env[pathKey] ?? "");
// The upstream invariant suite requires an empty database. Repeated runs otherwise retain
// fixed identities and future-dated fixtures, changing which item a queue test consumes.
const adminUrl = new URL(database.href);
adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.href, { max: 1 });
try {
  const [active] = await admin`SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname='corescope_test'`;
  if (active!.connections > 0) throw new Error("corescope_test is in use; finish the other test run first.");
  await admin.unsafe("DROP DATABASE IF EXISTS corescope_test");
  await admin.unsafe("CREATE DATABASE corescope_test");
} finally { await admin.end(); }
for (const args of [["scripts/migrate.ts"], ["--test", "--test-concurrency=1", "--test-timeout=120000", "tests/*.test.ts"]]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
