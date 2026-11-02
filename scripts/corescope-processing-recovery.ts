// Fixed recovery permissions and audited queue handoff only. This process registers no workers.
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { queueProcessing, sweepRecoveryBatches } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { applyRecoveryBatch, parseRecoveryPlan, planRecoveryBatch, recoveryBatchStatus,
  retryRecoveryFailures, stopRecoveryBatch, type RecoveryPlan } from "@aihot/backend/jobs/processing-recovery";

const address = new URL(config.databaseUrl);
if (!["localhost", "127.0.0.1"].includes(address.hostname) || address.port !== "5448" ||
  !(address.pathname === "/corescope" || /^\/corescope_[a-z0-9_]+_(test|ci)$/.test(address.pathname))) {
  throw new Error("Recovery operations require independent CoreScope on local port 5448");
}
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const required = (name: string) => { const value = arg(name); if (!value) throw new Error(`--${name}= is required`); return value; };
const actor = "corescope-processing-recovery";
const kind = () => { const value = required("kind"); if (value !== "bird-pending" && value !== "model-failure") throw new Error("--kind=bird-pending|model-failure"); return value; };
async function writePrivate(file: string, value: unknown) {
  const target = path.resolve(file);
  const data = path.resolve(config.dataDir);
  if (!target.startsWith(data + path.sep)) throw new Error("Recovery output must stay within CoreScope .data");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2) + "\n");
  return target;
}
async function plan() {
  const inputFile = path.resolve(required("input"));
  const raw = await readFile(inputFile, "utf8");
  const input = JSON.parse(raw);
  const batchKind = kind();
  const approved = Array.isArray(input.items) ? input.items.filter((item: { purpose?: string }) =>
    item.purpose === (batchKind === "bird-pending" ? "x-backlog" : "model-repair")) : null;
  const ids: string[] = approved ? approved.map((item: { id: string }) => item.id)
    : batchKind === "bird-pending" && Array.isArray(input.pendingMaterials)
      ? input.pendingMaterials.map((item: { article_id: string }) => item.article_id) : [];
  if (ids.length !== (batchKind === "bird-pending" ? 115 : 3) || new Set(ids).size !== ids.length) {
    throw new Error("The authorized manifest must contain exactly 115 unique X IDs or 3 unique editorial repair IDs");
  }
  const evidence = `${path.basename(inputFile)} sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const value = await sql.begin(async tx => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    const result = await planRecoveryBatch({ id: required("id"), kind: batchKind, articleIds: ids, evidence }, tx);
    if (approved) for (const member of result.members) {
      const frozen = approved.find((item: { id: string }) => item.id === member.articleId);
      if (!frozen || frozen.revision !== member.revision || frozen.source_id !== member.sourceId || frozen.participation_mode !== member.mode || frozen.kind !== member.sourceKind) {
        throw new Error(`Frozen manifest revision/source/mode changed for ${member.articleId}`);
      }
    }
    return result;
  });
  const output = await writePrivate(arg("out") ?? path.join(config.dataDir, "qa/recovery115", `${value.id}-plan.json`), value);
  return { command: "plan", id: value.id, kind: batchKind, members: value.members.length, digest: value.digest, output, readOnly: true };
}
try {
  const command = process.argv[2] ?? "status";
  let result: unknown;
  if (command === "plan") result = await plan();
  else if (command === "status") result = await recoveryBatchStatus(required("id"));
  else if (command === "apply") {
    const value: RecoveryPlan = parseRecoveryPlan(JSON.parse(await readFile(required("plan"), "utf8")));
    const batch = await applyRecoveryBatch(value, actor, required("reason"));
    let repaired: unknown = null;
    if (arg("retry-failed")) repaired = await retryRecoveryFailures(batch.id, required("retry-failed").split(","), actor, required("reason"),
      (articleId, db) => queueProcessing(articleId, { db }));
    const queued = await sweepRecoveryBatches();
    result = { command, id: batch.id, digest: batch.digest, members: batch.members.length, repaired, queued,
      workersRegistered: false, collectionStarted: false, selectionRulesChanged: false };
  } else if (command === "retry-failed") {
    result = await retryRecoveryFailures(required("id"), required("ids").split(","), actor, required("reason"),
      (articleId, db) => queueProcessing(articleId, { db }));
  } else if (command === "revoke" || command === "complete") {
    const batch = await stopRecoveryBatch(required("id"), command === "revoke" ? "revoked" : "complete", actor, required("reason"));
    result = { id: batch.id, status: batch.status, members: batch.members.length };
  } else throw new Error("Use plan --input= --kind= --id=, apply --plan= --reason= [--retry-failed=], status --id=, retry-failed --id= --ids= --reason=, revoke|complete --id= --reason=");
  if (arg("out") && command !== "plan") await writePrivate(required("out"), result);
  console.log(JSON.stringify(result));
} finally { await stopBoss(); await closeDb(); }
