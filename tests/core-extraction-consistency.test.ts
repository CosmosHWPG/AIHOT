// Failure cases: two workers finish the same extraction; a report revises the article while a page
// or X Article is in flight; an obsolete empty response marks new input unconfirmed; an admin
// repeats extraction of unchanged HTML. Neither content nor revision history may go backwards.
import { gate, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { getBoss, shutdownSignal, stopBoss } from "@aihot/backend/jobs/queue";
import { queueProcessing, registerExtractionJobs } from "@aihot/backend/jobs/content";
import { logicalKeyFor } from "@aihot/backend/providers/receipts";

const sourceId = `extract-consistency-${tag()}`;
const body = "This is the original article, with enough substantive text to extract its paragraphs. ".repeat(12);
let hold: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>>; count: number; empty: boolean; failed?: boolean };
const page = http.createServer(async (_req, res) => {
  if (--hold.count === 0) hold.entered.open();
  await hold.release.promise;
  res.writeHead(200, { "content-type": "text/html" });
  res.end(hold.empty ? "<html><body>Empty</body></html>" : `<html><head><title>Original</title></head><body><article><h1>Original</h1><p>${body}</p></article></body></html>`);
});
await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
const socialdata = await stub(async () => {
  hold.entered.open();
  await hold.release.promise;
  if (hold.failed) return new Reply(503, { error: "Temporary extraction failure" });
  return hold.empty ? {} : { article: { title: "Old X Article", content_state: { blocks: [{ text: body }] } } };
});
process.env.SOCIALDATA_API_KEY = "test-key";
process.env.SOCIALDATA_BASE_URL = socialdata.url;
config.allowPrivateNetworkFetch = true;
// The shared suite leaves queued fixture work; these workers must only consume this file's jobs.
let parkedJobs: Array<{ id: string; start_after: Date }> = [];
let savedBudgets: Array<{ service: string; per_minute: number; per_hour: number; per_day: number }> = [];
before(async () => {
  await getBoss();
  parkedJobs = await sql`SELECT id, start_after FROM pgboss.job WHERE state IN ('created', 'retry')`;
  if (parkedJobs.length) await sql`UPDATE pgboss.job SET start_after='2100-01-01' WHERE id = ANY(${parkedJobs.map((j) => j.id)}::uuid[])`;
  savedBudgets = await sql`SELECT service, per_minute, per_hour, per_day FROM budgets WHERE service='socialdata'`;
  await sql`INSERT INTO sources(id,name,kind) VALUES (${sourceId},'Extraction consistency','rss')`;
  await sql`UPDATE budgets SET per_minute=1000,per_hour=1000,per_day=1000 WHERE service='socialdata'`;
});
after(async () => {
  hold?.release.open();
  await stopBoss();
  page.close(); await socialdata.close();
  if (parkedJobs.length) await sql`UPDATE pgboss.job j SET start_after = old.start_after
    FROM jsonb_to_recordset(${sql.json(parkedJobs as never)}) AS old(id uuid, start_after timestamptz) WHERE j.id=old.id`;
  for (const b of savedBudgets) await sql`UPDATE budgets SET per_minute=${b.per_minute}, per_hour=${b.per_hour}, per_day=${b.per_day} WHERE service=${b.service}`;
  await closeDb();
});
const reset = (count = 1, empty = false) => { hold = { entered: gate(), release: gate(), count, empty }; };
const state = async (id: string) => ({ ...(await sql`SELECT title,body_text,body_status,revision,content_hash FROM articles WHERE id=${id}`)[0] });

for (const x of [false, true]) for (const empty of [false, true]) {
  test(`a stale ${x ? "X Article" : "page"} ${empty ? "empty" : "successful"} response cannot change newer material`, async () => {
    reset(1, empty);
    const tweetId = `${Date.now()}${empty ? 2 : 1}`;
    const material = { sourceId, url: `${base}/${tag()}`, title: "Original", via: "fetch" as const,
      ...(x ? { xPost: { tweetId, provider: "socialdata" as const, authorName: "Author", handle: "author", text: "https://x.com/i/article/123" } } : {}) };
    const { articleId } = await upsertMaterial(material);
    const pending = extractArticleBody(articleId, false);
    await hold.entered.promise;
    let expected;
    try {
      await upsertMaterial({ ...material, title: "Corrected report", ...(empty ? {} : { bodyText: "The corrected body supplied by the publisher." }) });
      expected = await state(articleId);
    } finally { hold.release.open(); }
    const result = await pending;
    assert.deepEqual(await state(articleId), expected, "old network results must not touch the new revision or its pending status");
    assert.equal(result, "skipped");
  });
}

test("overlapping page extractions and an unchanged admin retry create only one body revision", async () => {
  reset(2);
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/${tag()}`, title: "Original", via: "fetch" });
  const pending = [extractArticleBody(articleId, false), extractArticleBody(articleId, false)];
  await hold.entered.promise;
  hold.release.open();
  await Promise.all(pending);
  const saved = await state(articleId);
  assert.equal(saved.revision, 2, "concurrent workers must not revise identical content twice");
  reset();
  hold.release.open();
  await sql`UPDATE articles SET body_status='pending' WHERE id=${articleId}`;
  assert.equal(await extractArticleBody(articleId, false), "ok");
  assert.deepEqual(await state(articleId), saved);
  assert.equal((await sql`SELECT 1 FROM article_revisions WHERE article_id=${articleId}`).length, 2);
});

// The worker's error path is also a write: a late provider error must not add retry state to a
// newer, complete report. Exercise pg-boss's actual callback rather than only the extractor.
test("an obsolete extraction failure cannot penalize a newer complete report", async () => {
  reset();
  hold.failed = true;
  const source = `${sourceId}-worker`;
  await sql`INSERT INTO sources(id,name,kind) VALUES (${source},'Extraction worker','x_search')`;
  const material = { sourceId: source, url: `https://x.com/author/status/${Date.now()}`, title: "Original", via: "fetch" as const,
    xPost: { tweetId: `${Date.now()}9`, provider: "socialdata" as const, authorName: "Author", handle: "author", text: "https://x.com/i/article/123" } };
  const { articleId } = await upsertMaterial(material);
  const job = await queueProcessing(articleId);
  await registerExtractionJobs(await getBoss());
  await hold.entered.promise;
  try { await upsertMaterial({ ...material, title: "Corrected", bodyText: "Complete corrected body" }); }
  finally { hold.release.open(); }
  const deadline = Date.now() + 12_000;
  while ((await sql`SELECT state FROM pgboss.job WHERE id=${job!}`)[0]?.state !== "completed") {
    assert.ok(Date.now() < deadline, "extraction worker did not finish");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const [row] = await sql`SELECT body_status,processing_attempts,processing_error,processing_retry_at FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...row }, { body_status: "ok", processing_attempts: 0, processing_error: null, processing_retry_at: null });
});

async function pendingXArticle(name: string) {
  const source = `${sourceId}-${name}`;
  const tweetId = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  await sql`INSERT INTO sources(id,name,kind) VALUES (${source},${name},'x_search')`;
  const { articleId } = await upsertMaterial({ sourceId: source, url: `https://x.com/author/status/${tweetId}`, title: name, via: "fetch",
    xPost: { tweetId, provider: "socialdata", authorName: "Author", handle: "author", text: "https://x.com/i/article/123" } });
  return { articleId, tweetId };
}

async function extractionRound(articleId: string) {
  const job = await queueProcessing(articleId, { step: "extract" });
  assert.ok(job);
  const deadline = Date.now() + 12_000;
  while ((await sql`SELECT state FROM pgboss.job WHERE id=${job}`)[0]?.state !== "completed") {
    assert.ok(Date.now() < deadline, "extraction worker did not finish");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return (await sql`SELECT output FROM pgboss.job WHERE id=${job}`)[0]!.output;
}

for (const capacity of ["budget", "busy"] as const) test(`three ${capacity} waits preserve the pending body and prior extraction attempts`, async () => {
  const { articleId, tweetId } = await pendingXArticle(capacity);
  await sql`UPDATE articles SET processing_attempts=2 WHERE id=${articleId}`;
  const hits = socialdata.hits();
  if (capacity === "budget") await sql`UPDATE budgets SET per_minute=0 WHERE service='socialdata'`;
  else {
    const key = logicalKeyFor({ service: "socialdata", purpose: "x_article", identity: { article: tweetId } });
    await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status)
      VALUES (${key},'socialdata','x_article',${`article:${articleId}`},'pending')`;
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal((await extractionRound(articleId)).state, "waiting");
      const [row] = await sql`SELECT processing_state,body_status,processing_attempts,processing_retry_at,processing_queued_at
        FROM articles WHERE id=${articleId}`;
      assert.equal(row!.processing_state, "new");
      assert.equal(row!.body_status, "pending");
      assert.equal(row!.processing_attempts, 2);
      assert.equal(row!.processing_queued_at, null);
      const seconds = capacity === "budget" ? 3600 : 60;
      assert.ok(row!.processing_retry_at.getTime() >= Date.now() + (seconds - 3) * 1000, "honor the provider's retry window");
    }
    assert.equal(socialdata.hits(), hits, "capacity waits must not send another provider request");
  } finally {
    if (capacity === "budget") await sql`UPDATE budgets SET per_minute=1000 WHERE service='socialdata'`;
  }
});

test("three real extraction failures still settle as an unconfirmed body", async () => {
  reset(); hold.failed = true; hold.release.open();
  const { articleId } = await pendingXArticle("real-failure");
  const hits = socialdata.hits();
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal((await extractionRound(articleId)).state, attempt === 3 ? "unconfirmed" : "retrying");
    const [row] = await sql`SELECT body_status,processing_attempts FROM articles WHERE id=${articleId}`;
    assert.equal(row!.body_status, attempt === 3 ? "unconfirmed" : "pending");
    assert.equal(row!.processing_attempts, attempt === 3 ? 0 : attempt);
  }
  assert.equal(socialdata.hits() - hits, 3);
});

// Abort is process-wide, so this is deliberately last. A request already in flight can still fail
// during a graceful stop; pg-boss owns its retry, without recording an article extraction failure.
test("shutdown during a failed extraction preserves pending evidence and the previous failure count", async () => {
  reset(); hold.failed = true;
  const { articleId } = await pendingXArticle("shutdown");
  await sql`UPDATE articles SET processing_attempts=2,processing_error='previous failure' WHERE id=${articleId}`;
  const job = await queueProcessing(articleId, { step: "extract" });
  await hold.entered.promise;
  shutdownSignal.abort(); hold.release.open();
  const deadline = Date.now() + 12_000;
  while ((await sql`SELECT state FROM pgboss.job WHERE id=${job!}`)[0]?.state !== "retry") {
    assert.ok(Date.now() < deadline, "interrupted extraction did not remain retryable");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const [row] = await sql`SELECT body_status,processing_attempts,processing_error,processing_retry_at FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...row }, { body_status: "pending", processing_attempts: 2, processing_error: "previous failure", processing_retry_at: null });
});
