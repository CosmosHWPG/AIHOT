// Deployment checks use the same receipts and budget gates as the production worker.
// Never print deployment environment values, provider responses, or credentials.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { chatJson } from "@aihot/backend/providers/llm";
import { ensureEmbeddings } from "@aihot/backend/providers/embeddings";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { publishArticle } from "@aihot/backend/publication/publish";
import { audit } from "@aihot/backend/audit";
import { stopBoss } from "@aihot/backend/jobs/queue";

async function configure() {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('corescope:initial-settings'))`;
    const [existing] = await tx`SELECT key FROM settings WHERE key = 'corescope.initial_settings'`;
    if (existing) return;
    // Configuration is written transactionally. Operator changes are kept on subsequent starts.
    for (const [service, minute, hour, day] of [["llm", 20, 180, 800], ["embedding", 30, 240, 1000]] as const) {
      await tx`UPDATE budgets SET per_minute = ${minute}, per_hour = ${hour}, per_day = ${day},
        note = 'CoreScope 本机初始请求熔断；可在后台设置中调整', updated_at = now() WHERE service = ${service}`;
    }
    await tx`INSERT INTO settings (key, value, updated_by) VALUES ('corescope.initial_settings',
      ${tx.json({ version: 1, initializedAt: new Date().toISOString() })}, 'corescope-launcher')`;
  });
  console.log(JSON.stringify({ configured: true, budgetsPreserveOperatorChanges: true }));
}

async function verify() {
  if (!config.modelCallsEnabled) throw new Error("Enable MODEL_CALLS_ENABLED for an explicitly authorized live check.");
  const reply = await chatJson({ model: "default", purpose: "corescope.model-check", subject: "corescope-local-v1",
    promptVersion: "corescope-model-check-v1", system: "Return one JSON object with ok=true and language=zh. No other fields.",
    user: "验证连接。", schema: z.object({ ok: z.literal(true), language: z.literal("zh") }), maxTokens: 512 });
  await sql.begin((tx) => completeReceipt(tx, reply.receiptId));
  const vectors = await ensureEmbeddings("article", [{ id: "corescope-model-check-v1", text: "5G core network and AI agent architecture" }]);
  const result = { checkedAt: new Date().toISOString(), chat: { ok: true, receiptId: reply.receiptId, reused: reply.reused },
    embeddings: { ok: vectors.has("corescope-model-check-v1"), dimensions: vectors.get("corescope-model-check-v1")?.length ?? 0 } };
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(path.join(config.dataDir, "model-verification.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

async function status() {
  const [counts] = await sql`SELECT
    (SELECT count(*)::int FROM sources) AS sources,
    (SELECT count(*)::int FROM sources WHERE enabled) AS enabled_sources,
    (SELECT count(*)::int FROM articles) AS articles,
    (SELECT count(*)::int FROM publications WHERE visibility = 'public' AND eligible) AS public_articles,
    (SELECT count(*)::int FROM publications WHERE visibility = 'public' AND selected AND visible_after <= now()) AS selected,
    (SELECT count(*)::int FROM facts) AS facts,
    (SELECT count(*)::int FROM stories) AS stories,
    (SELECT count(*)::int FROM reports) AS reports,
    (SELECT count(*)::int FROM receipts WHERE status = 'completed') AS completed_receipts,
    (SELECT count(*)::int FROM receipts WHERE status = 'unknown') AS unknown_receipts`;
  const processing = await sql`SELECT processing_state AS state, count(*)::int AS count FROM articles GROUP BY processing_state ORDER BY processing_state`;
  const budgets = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service IN ('llm', 'embedding') ORDER BY service`;
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), counts, processing, budgets }));
}

async function reprojectDomains() {
  const articles = await sql`SELECT article_id,tags FROM publications WHERE visibility='public'`;
  let changed = 0;
  for (const before of articles) {
    const result = await publishArticle(before.article_id);
    if (result?.changed) {
      changed++;
      const [after] = await sql`SELECT tags FROM publications WHERE article_id=${before.article_id}`;
      await audit("corescope-launcher", "publication.domain_tags", `article:${before.article_id}`,
        "Apply industry domain vocabulary to stored native results; no model call or score change", { tags: before.tags }, { tags: after?.tags });
    }
  }
  console.log(JSON.stringify({ reprojected: articles.length, changed, modelCalls: 0 }));
}

try {
  const command = process.argv[2] ?? "status";
  if (command === "configure") await configure();
  else if (command === "verify-models") await verify();
  else if (command === "status") await status();
  else if (command === "reproject-domains") await reprojectDomains();
  else throw new Error("Use configure, verify-models, status, or reproject-domains.");
} catch (error) {
  // A service rejection can contain a provider's response; keep diagnostics in the private log.
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(path.join(config.dataDir, "operations-error.log"), `${new Date().toISOString()} ${String(error)}\n`, { flag: "a" });
  console.error("CoreScope check failed; see private .data/operations-error.log and admin receipts.");
  process.exitCode = 1;
} finally { await stopBoss(); await closeDb(); }
