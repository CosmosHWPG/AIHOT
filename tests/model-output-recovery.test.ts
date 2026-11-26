// Local provider stubs only: a larger output budget must preserve successful independent scores,
// block in-flight/unknown predecessors, and keep malformed content understanding out of publication.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { analyzeArticle, buildScoreInput, loadAnalyzeInput, PROMPT_VERSIONS, runSelectionScores, SCORE_SYSTEM, ScoreSchema } from "@aihot/backend/editorial/analyze";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { completeReceipt, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { ITEM_TYPES } from "@aihot/industry/taxonomy";
import { UNDERSTAND_SYSTEM } from "@aihot/backend/editorial/writing";

const T = tag();
const sourceId = `test-output-recovery-${T}`;
const requests: Array<{ step: string; body: Record<string, any> }> = [];
let truncateLegacy = false;
let understanding: Record<string, unknown> = {};
const validUnderstanding = () => ({ itemType: "industry_event", authorRole: "relayer", tags: ["行业动态"], editorialJudgment: "解释已公开的产业变化。", titleZh: "企业公布基础设施合作计划", summaryZh: "企业公布了基础设施合作计划。双方披露了合作范围。" });
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as Record<string, any>;
  const system = String(body.messages[0]?.content ?? "");
  const step = system.includes("宽召回") ? "prefilter" : system.includes("事件注意力评分器") ? "score"
    : system.includes("内容理解编辑") ? "understand" : system.includes("资料结构化助手") ? "structure" : "other";
  requests.push({ step, body });
  if (step === "score" && body.max_tokens === 1024 && truncateLegacy) {
    return { choices: [{ finish_reason: "length", message: { content: null, reasoning: "test reasoning" } }], usage: { completion_tokens: 1024, completion_tokens_details: { reasoning_tokens: 1024 } } };
  }
  const content = step === "prefilter" ? { label: "PASS", reason: "测试" }
    : step === "score" ? { attentionScore: 80 }
    : step === "understand" ? understanding
    : step === "structure" ? { category: "ai-industry", tags: ["行业动态"], subjects: [], fact: null }
    : {};
  return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }], usage: { completion_tokens: 20 } };
});
Object.assign(process.env, {
  LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "local-stub-only", LLM_MODEL: "deepseek/deepseek-v4.1-flash",
  LLM_EXTRA_JSON: JSON.stringify({ reasoning: { enabled: false } }), MODEL_CALLS_ENABLED: "true",
  PREFILTER_MODEL: "default", SCORE_MODEL: "default", UNDERSTAND_MODEL: "default", STRUCTURE_MODEL: "default", SUMMARIZE_MODEL: "default",
});

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at)
    VALUES (${sourceId}, 'Output recovery test', 'rss', 'T1', 'editorial', '2100-01-01')`;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

async function article(marker: string) {
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.com/${T}/${marker}`, title: `Infrastructure cooperation ${marker} ${T}`,
    bodyText: `A company announced an infrastructure partnership and disclosed its scope. ${marker} ${T} `.repeat(8),
    bodyStatus: "ok", via: "fetch", publishedAt: new Date("2026-10-13T00:00:00Z") } as never);
  return (await loadAnalyzeInput(articleId))!;
}
async function legacyScore(a: Awaited<ReturnType<typeof article>>, number: number, changes: Record<string, unknown> = {}) {
  return chatJson({ model: "default", purpose: "score_article", subject: `article:${a.id}@${a.revision}`, promptVersion: PROMPT_VERSIONS.score,
    system: SCORE_SYSTEM, user: buildScoreInput(a), schema: ScoreSchema, temperature: 0.2, maxTokens: 1024,
    attemptTag: `score-${number}`, ...changes });
}

test("a truncated 1024-token score gets a separate audited 4096-token identity and then reuses it", async () => {
  const a = await article("truncated");
  truncateLegacy = true;
  let oldId: number | null = null;
  await assert.rejects(legacyScore(a, 1), (error: unknown) => {
    assert.ok(error instanceof ModelOutputError); oldId = error.receiptId; return true;
  });
  truncateLegacy = false;
  const before = requests.length;
  const scores = (await runSelectionScores(a))!;
  assert.deepEqual(scores.values, [80, 80]);
  assert.equal(requests.length - before, 2);
  for (const req of requests.slice(before)) {
    assert.equal(req.body.max_tokens, 4096);
    assert.deepEqual(req.body.reasoning, { enabled: false }, "operator's reasoning control is preserved");
    assert.equal(req.body.temperature, 0.2);
  }
  assert.ok(!scores.receiptIds.includes(oldId!));
  const [old] = await sql`SELECT status, attempts FROM receipts WHERE id = ${oldId}`;
  assert.deepEqual({ ...old }, { status: "failed", attempts: 1 }, "failed original stays historical evidence");
  const [replacement] = await sql`SELECT request FROM receipts WHERE id = ${scores.receiptIds[0]!}`;
  assert.equal(replacement!.request.previousReceiptId, oldId);
  assert.equal(replacement!.request.previousMaxTokens, 1024);
  const again = (await runSelectionScores(a))!;
  assert.deepEqual(again.receiptIds, scores.receiptIds);
  assert.equal(again.reused, true);
  assert.equal(requests.length - before, 2, "no repeat payment after the replacement answer is saved");
});

test("both valid old scores keep their original receipt IDs while strict understanding is repaired", async () => {
  const a = await article("understanding");
  const first = await legacyScore(a, 1);
  const second = await legacyScore(a, 2);
  // Cover both received and completed predecessor states.
  await completeReceipt(sql, second.receiptId);
  const before = requests.length;
  for (const invalid of [undefined, null, "industry_news", ["industry_event"], { value: "industry_event" }]) {
    understanding = { ...validUnderstanding(), itemType: invalid };
    await assert.rejects(analyzeArticle(a.id), ModelOutputError);
  }
  assert.equal(requests.slice(before).filter(r => r.step === "score").length, 0, "successful scoring is never bought again");
  const [count] = await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id = ${a.id}`;
  assert.equal(count!.n, 0, "missing or illegal enums do not create a business judgement");
  understanding = validUnderstanding();
  const repaired = await analyzeArticle(a.id);
  assert.equal(repaired!.output!.selected, true);
  assert.ok(repaired!.receiptIds.includes(first.receiptId));
  assert.ok(repaired!.receiptIds.includes(second.receiptId));
  assert.equal(requests.slice(before).filter(r => r.step === "score").length, 0);
  assert.equal(requests.slice(before).filter(r => r.step === "prefilter").length, 1, "prefilter also reuses its saved answer");
  assert.equal(requests.slice(before).filter(r => r.step === "structure").length, 1, "structure also reuses its saved answer");
  const [detail] = await sql`SELECT output FROM analyses WHERE article_id = ${a.id}`;
  assert.equal(detail!.output.itemType, "industry_event");
  assert.ok(UNDERSTAND_SYSTEM.includes(JSON.stringify(ITEM_TYPES)), "prompt enum comes from the same vocabulary as validation");
});

test("an old pending or unknown score cannot be bypassed by changing output budget", async () => {
  for (const status of ["pending", "unknown"]) {
    const a = await article(status);
    const prior = await legacyScore(a, 1);
    await sql`UPDATE receipts SET status = ${status} WHERE id = ${prior.receiptId}`;
    const before = requests.length;
    await assert.rejects(runSelectionScores(a), status === "pending" ? ReceiptBusyError : ReceiptUnknownError);
    assert.equal(requests.length, before);
    const rows = await sql`SELECT id FROM receipts WHERE subject = ${`article:${a.id}@${a.revision}`} AND purpose = 'score_article'`;
    assert.equal(rows.length, 1, "no replacement receipt or attempt is claimed");
  }
});

test("a completed legacy score cannot hide a pending or unknown current generation", async () => {
  for (const status of ["pending", "unknown"]) {
    const a = await article(`current-${status}`);
    const prior = await legacyScore(a, 1);
    await completeReceipt(sql, prior.receiptId);
    const current = await legacyScore(a, 1, { maxTokens: 4096 });
    await sql`UPDATE receipts SET status = ${status} WHERE id = ${current.receiptId}`;
    const before = requests.length;
    await assert.rejects(runSelectionScores(a), (error: unknown) => {
      assert.ok(status === "pending" ? error instanceof ReceiptBusyError : error instanceof ReceiptUnknownError);
      if (error instanceof ReceiptUnknownError) assert.equal(error.receiptId, current.receiptId);
      return true;
    });
    assert.equal(requests.length, before, "no request is sent and the old success is not returned");
    const rows = await sql`SELECT id, status, attempts FROM receipts WHERE subject = ${`article:${a.id}@${a.revision}`} AND purpose = 'score_article' ORDER BY id`;
    assert.deepEqual(rows.map(r => ({ ...r })), [
      { id: prior.receiptId, status: "completed", attempts: 1 },
      { id: current.receiptId, status, attempts: 1 },
    ], "both formal identities and their attempt histories remain untouched");
  }
});

test("compatibility reuse strictly validates schema and matches the complete request identity", async () => {
  const invalid = await article("invalid-saved");
  const saved = await legacyScore(invalid, 1);
  await sql`UPDATE receipts SET response = ${sql.json({ choices: [{ message: { content: '{"attentionScore":999}' } }] })} WHERE id = ${saved.receiptId}`;
  const before = requests.length;
  const fresh = (await runSelectionScores(invalid))!;
  assert.equal(requests.length - before, 2);
  assert.ok(!fresh.receiptIds.includes(saved.receiptId), "an out-of-range old score is not accepted");
  for (const changes of [{ promptVersion: "old-prompt" }, { system: `${SCORE_SYSTEM}\nold system` }, { user: "different input" }, { temperature: 0.5 }, { attemptTag: "explicit-rerun:score-1" }]) {
    const a = await article(`identity-${tag()}`);
    const prior = await legacyScore(a, 1, changes);
    const start = requests.length;
    const scores = (await runSelectionScores(a))!;
    assert.equal(requests.length - start, 2, "prompt/input/temperature/independent call tag mismatch never reuses a score");
    assert.ok(!scores.receiptIds.includes(prior.receiptId));
  }
  for (const [key, different] of [["LLM_MODEL", "different-model"], ["LLM_EXTRA_JSON", JSON.stringify({ reasoning: { enabled: true } })]]) {
    const a = await article(`model-config-${tag()}`);
    const original = process.env[key!];
    let prior;
    try { process.env[key!] = different; prior = await legacyScore(a, 1); }
    finally { process.env[key!] = original; }
    const start = requests.length;
    const scores = (await runSelectionScores(a))!;
    assert.equal(requests.length - start, 2, "model/extra configuration mismatch never reuses a score");
    assert.ok(!scores.receiptIds.includes(prior!.receiptId));
  }
});
