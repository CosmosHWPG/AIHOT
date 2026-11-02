// Late discussion matching keeps the heat window and never pays repeatedly for unchanged negatives.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { groupArticle, rematchRecentSignals } from "@aihot/backend/events/group";
import { settleNonEditorial } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";

const T = tag();
const EDITORIAL = `test-rematch-ed-${T}`;
const SIGNAL = `test-rematch-hs-${T}`;
const topic = (name: string) => `RM${T}_${name}`;
const axes = new Map<string, number>();
let relation = "SAME_OCCURRENCE";
let chatCalls = 0;
const provider = await stub((_hit, req) => {
  const body = JSON.parse(req.body) as { input?: string[]; messages?: Array<{ content: string }> };
  if (body.input) return {
    data: body.input.map((text, index) => {
      const marker = new RegExp(`RM${T}_[a-z]+`).exec(text)?.[0];
      if (marker && !axes.has(marker)) axes.set(marker, 100 + axes.size * 2);
      const axis = marker ? axes.get(marker)! : 1;
      const vector = Array<number>(1024).fill(0);
      vector[axis] = text.includes("DISCUSSION") ? 0.8 : 1;
      if (text.includes("DISCUSSION")) vector[axis + 1] = 0.6;
      return { index, embedding: vector };
    }),
  };
  chatCalls += 1;
  const user = body.messages?.at(-1)?.content ?? "";
  const ids = [...user.matchAll(/【候选 (C\d+)】/g)].map(m => m[1]!);
  return { id: "stub", choices: [{ message: { content: JSON.stringify({
    query: "发布", decisions: ids.map(id => ({ id, relation, confidence: 0.95, note: "" })),
  }) } }] };
});
for (const prefix of ["DASHSCOPE", "DEEPSEEK"]) {
  process.env[`${prefix}_BASE_URL`] = `${provider.url}/v1`;
  process.env[`${prefix}_API_KEY`] = "test-key";
}
process.env.EMBEDDINGS_ENABLED = "true";

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service IN ('dashscope', 'deepseek')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${EDITORIAL}, 'Rematch editorial', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${SIGNAL}, 'Rematch discussion', 'rss', 'T2', 'hot_signal', '2100-01-01')`;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

async function report(name: string, title: string, hours = 0) {
  const publishedAt = new Date(Date.now() - hours * 3_600_000);
  const { articleId } = await upsertMaterial({ sourceId: EDITORIAL,
    url: `https://example.com/rematch-${T}-${name}`, title, bodyText: "Confirmed report body.", bodyStatus: "ok", via: "fetch", publishedAt });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
    VALUES (${articleId}, 1, 'rule', 'pass', 'ai-models', ${title}, '摘要', 80, false, ${sql.json({ fact: { title } })})`;
  await publishArticle(articleId);
  return { articleId, grouped: await groupArticle(articleId) };
}

async function discussion(name: string, marker: string, hours = 0) {
  const at = new Date(Date.now() - hours * 3_600_000);
  const { articleId } = await upsertMaterial({ sourceId: SIGNAL,
    url: `https://example.com/rematch-${T}-discussion-${name}`, title: `DISCUSSION ${marker}`,
    bodyText: `DISCUSSION ${marker} reaction`, bodyStatus: "ok", via: "fetch", publishedAt: at });
  // It was ingested before the delayed report, rather than being an old post collected just now.
  await sql`UPDATE articles SET discovered_at = ${at} WHERE id = ${articleId}`;
  assert.deepEqual(await settleNonEditorial(articleId), { group: true });
  return articleId;
}

async function queued(id: string) {
  return (await sql`SELECT 1 FROM pgboss.job WHERE name = 'events.group' AND singleton_key = ${id}`).length > 0;
}

test("an 18-hour earlier discussion gets the ordinary judge when the delayed report arrives", async () => {
  const post = await discussion("eighteen", topic("eighteen"), 18);
  assert.equal((await groupArticle(post, { signalOnly: true })).verdict, "signal-unmatched");
  const { grouped } = await report("eighteen", topic("eighteen"));
  assert.equal(grouped.rematched, 1);
  assert.ok(await queued(post));
  assert.deepEqual(await groupArticle(post, { signalOnly: true }), { verdict: "signal", storyId: grouped.storyId });
});

test("discussion outside the 48-hour publication window is not queued by a recent report", async () => {
  const post = await discussion("expired", topic("expired"), 49);
  const { grouped } = await report("expired", topic("expired"));
  assert.equal(grouped.rematched, 0);
  assert.equal(await queued(post), false);
});

test("a kept report rematches discussion imported after it first founded its fact", async () => {
  const { articleId, grouped } = await report("kept", topic("kept"));
  const post = await discussion("kept", topic("kept"), 18);
  const kept = await groupArticle(articleId);
  assert.equal(kept.verdict, "kept");
  assert.equal(kept.rematched, 1);
  assert.ok(await queued(post));
  assert.equal((await groupArticle(post, { signalOnly: true })).storyId, grouped.storyId);
});

test("repeated UNRELATED matching reuses a decision and never spends or appends another decision", async () => {
  await report("negative", topic("negative"));
  const post = await discussion("negative", topic("negative"));
  relation = "UNRELATED";
  const before = chatCalls;
  assert.equal((await groupArticle(post, { signalOnly: true })).verdict, "signal-unmatched");
  assert.equal(chatCalls, before + 1);
  const [first] = await sql<{ candidates: Array<{ signalInputRevision?: number; signalInputFingerprint?: string }>; receipt_id: number }[]>`
    SELECT candidates, receipt_id FROM grouping_decisions WHERE article_id = ${post}`;
  assert.equal(first?.candidates[0]?.signalInputRevision, 1);
  assert.match(first?.candidates[0]?.signalInputFingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.ok(first?.receipt_id);
  for (let i = 0; i < 3; i++) assert.equal((await groupArticle(post, { signalOnly: true })).verdict, "signal-unmatched");
  assert.equal(chatCalls, before + 1);
  assert.equal((await sql`SELECT 1 FROM grouping_decisions WHERE article_id = ${post}`).length, 1);
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE article_id = ${post}`).length, 0);
  relation = "SAME_OCCURRENCE";
});

test("revision-only changes reuse the receipt; changed model input is judged once", async () => {
  await report("revision", topic("revision"));
  const post = await discussion("revision", topic("revision"));
  relation = "UNRELATED";
  await groupArticle(post, { signalOnly: true });
  const [original] = await sql<{ receipt_id: number }[]>`SELECT receipt_id FROM grouping_decisions WHERE article_id = ${post}`;
  const before = chatCalls;
  await sql`UPDATE articles SET revision = revision + 1 WHERE id = ${post}`;
  await groupArticle(post, { signalOnly: true });
  assert.equal(chatCalls, before, "same prompt/model reuses the settled provider receipt across input revisions");
  const [current] = await sql<{ receipt_id: number; candidates: Array<{ signalInputRevision: number }> }[]>`
    SELECT receipt_id, candidates FROM grouping_decisions WHERE article_id = ${post} ORDER BY id DESC LIMIT 1`;
  assert.equal(current?.receipt_id, original?.receipt_id);
  assert.equal(current?.candidates[0]?.signalInputRevision, 2);
  await groupArticle(post, { signalOnly: true });
  assert.equal(chatCalls, before);
  assert.equal((await sql`SELECT 1 FROM grouping_decisions WHERE article_id = ${post}`).length, 2);
  await sql`UPDATE articles SET revision = revision + 1, title = title || ' new technical evidence' WHERE id = ${post}`;
  await groupArticle(post, { signalOnly: true });
  assert.equal(chatCalls, before + 1, "changed prompt is a new paid judgement");
  await groupArticle(post, { signalOnly: true });
  assert.equal(chatCalls, before + 1);
  assert.equal((await sql`SELECT 1 FROM grouping_decisions WHERE article_id = ${post}`).length, 3);
  relation = "SAME_OCCURRENCE";
});

test("changed candidate facts are judged once, while their unchanged negative is reused", async () => {
  await report("candidatesone", topic("candidates"));
  const post = await discussion("candidates", topic("candidates"));
  relation = "UNRELATED";
  await groupArticle(post, { signalOnly: true });
  await report("candidatestwo", `${topic("candidates")} separate occurrence`);
  const before = chatCalls;
  await groupArticle(post, { signalOnly: true });
  assert.equal(chatCalls, before + 1);
  await groupArticle(post, { signalOnly: true });
  assert.equal(chatCalls, before + 1);
  assert.equal((await sql`SELECT 1 FROM grouping_decisions WHERE article_id = ${post}`).length, 2);
  relation = "SAME_OCCURRENCE";
});

test("bounded catch-up chooses the newest valid report first", async () => {
  await report("boundedolder", topic("boundedolder"), 12);
  const olderPost = await discussion("boundedolder", topic("boundedolder"), 18);
  const newestPost = await discussion("boundednewest", topic("boundednewest"), 18);
  await report("boundednewest", topic("boundednewest"));
  // Founding already queued the newest post; clear only this fixture to observe catch-up itself.
  await sql`DELETE FROM pgboss.job WHERE singleton_key = ${newestPost}`;
  const result = await rematchRecentSignals(1);
  assert.deepEqual(result, { reports: 1, enqueued: 1 });
  assert.equal(await queued(newestPost), true);
  assert.equal(await queued(olderPost), false);
});

test("catch-up rejects unbounded or invalid report counts", async () => {
  for (const limit of [0, 201, -1, NaN, 1.5]) await assert.rejects(rematchRecentSignals(limit), /between 1 and 200/);
});
