// Paid body answers settle with the material decision. Capacity waits and failed persistence
// must retain pending/reusable evidence rather than buy another answer or confirm an empty body.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { markdownBody } from "@aihot/backend/content/markdown";
import { stripTags } from "@aihot/backend/lib/text";
import { queueProcessing, registerExtractionJobs } from "@aihot/backend/jobs/content";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { ReceiptUnknownError } from "@aihot/backend/providers/receipts";

const sourceId = `jina-body-${tag()}`;
const markdown = "# Original article\n\n" + "The publisher provides substantive article text for the authenticated rendering response. ".repeat(12);
let reply = markdown;
let drop = false;
let hits = 0;
let hold: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const page = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body><div id='app'></div></body></html>"); // A public client-rendered shell.
});
const jina = http.createServer(async (req, res) => {
  hits += 1;
  const answer = reply;
  const waiting = hold;
  if (waiting) { waiting.entered.open(); await waiting.release.promise; }
  if (drop) { req.socket.destroy(); return; }
  res.writeHead(200, { "content-type": "text/plain", "x-usage-tokens": "12" });
  res.end(`Title: Original article\nURL Source: ${req.url?.slice(1)}\n\nMarkdown Content:\n${answer}`);
});
await Promise.all([page, jina].map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
const base = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
process.env.JINA_BASE_URL = `http://127.0.0.1:${(jina.address() as { port: number }).port}`;
process.env.JINA_API_KEY = "test-jina-body-key";
process.env.JINA_BODY_FALLBACK = "true";
config.allowPrivateNetworkFetch = true;

let parkedJobs: Array<{ id: string; start_after: Date }> = [];
let savedBudget: { enabled: boolean; per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  await getBoss();
  parkedJobs = await sql`SELECT id,start_after FROM pgboss.job WHERE state IN ('created','retry')`;
  if (parkedJobs.length) await sql`UPDATE pgboss.job SET start_after='2100-01-01' WHERE id=ANY(${parkedJobs.map(j => j.id)}::uuid[])`;
  [savedBudget] = await sql`SELECT enabled,per_minute,per_hour,per_day FROM budgets WHERE service='jina'`;
  assert.ok(savedBudget, "Jina has a configured paid-service budget");
  await sql`UPDATE budgets SET enabled=true,per_minute=1000000,per_hour=1000000,per_day=1000000 WHERE service='jina'`;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES (${sourceId},'Jina body fallback','rss',${sql.json({ fetchPublicContent: true })})`;
});
after(async () => {
  hold?.release.open();
  await stopBoss();
  await Promise.all([page, jina].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  if (parkedJobs.length) await sql`UPDATE pgboss.job j SET start_after=old.start_after
    FROM jsonb_to_recordset(${sql.json(parkedJobs as never)}) AS old(id uuid,start_after timestamptz) WHERE j.id=old.id`;
  if (savedBudget) await sql`UPDATE budgets SET enabled=${savedBudget.enabled},per_minute=${savedBudget.per_minute},
    per_hour=${savedBudget.per_hour},per_day=${savedBudget.per_day} WHERE service='jina'`;
  await closeDb();
});

function reset(answer = markdown) { reply = answer; drop = false; hold = null; }
async function material(extra: { bodyText?: string; bodyStatus?: "pending" } = {}) {
  const input = { sourceId, url: `${base}/${tag()}`, title: "Original article", publishedAt: new Date(), via: "fetch" as const, ...extra };
  const { articleId } = await upsertMaterial(input);
  return { articleId, input };
}
const state = async (id: string) => ({ ...(await sql`SELECT title,body_text,body_html,body_status,revision,content_hash,
  processing_state,processing_attempts,processing_retry_at FROM articles WHERE id=${id}`)[0] });
const receipts = (id: string) => sql<{ id: number; status: string; attempts: number }[]>`
  SELECT id,status,attempts FROM receipts WHERE service='jina' AND purpose='body_fallback' AND subject=${`article:${id}`} ORDER BY id`;

test("three Jina budget waits retain the pending body and prior extraction attempts", async () => {
  reset();
  const { articleId } = await material();
  await sql`UPDATE articles SET processing_attempts=2 WHERE id=${articleId}`;
  const beforeHits = hits;
  await registerExtractionJobs(await getBoss());
  await sql`UPDATE budgets SET per_minute=0 WHERE service='jina'`;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const job = await queueProcessing(articleId, { step: "extract" });
      assert.ok(job);
      const deadline = Date.now() + 12_000;
      let output: { state?: string } | null = null;
      for (;;) {
        const [row] = await sql`SELECT state,output FROM pgboss.job WHERE id=${job}`;
        if (row?.state === "completed") { output = row.output; break; }
        assert.ok(Date.now() < deadline, "Jina capacity wait did not finish");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(output?.state, "waiting");
      const saved = await state(articleId);
      assert.equal(saved.body_status, "pending");
      assert.equal(saved.processing_state, "new");
      assert.equal(saved.processing_attempts, 2);
      assert.ok(saved.processing_retry_at.getTime() > Date.now() + 3_597_000);
    }
    assert.equal(hits, beforeHits, "the local budget must block before a paid stub request");
    assert.equal((await receipts(articleId)).length, 0);
  } finally { await sql`UPDATE budgets SET per_minute=1000000 WHERE service='jina'`; }
});

test("a Jina body commits one revision and completes its paid receipt", async () => {
  reset();
  const { articleId } = await material();
  const beforeHits = hits;
  assert.equal(await extractArticleBody(articleId, true), "ok");
  const saved = await state(articleId);
  assert.equal(saved.body_status, "ok");
  assert.equal(saved.revision, 2);
  assert.ok(saved.body_text.length > 200);
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
  assert.equal(await extractArticleBody(articleId, true), "skipped");
  assert.equal(hits, beforeHits + 1);
  assert.equal((await sql`SELECT 1 FROM article_revisions WHERE article_id=${articleId}`).length, 2);
});

for (const answer of ["", "A short rendering without a usable article body."]) test(`a ${answer ? "short" : "empty"} Jina answer settles unconfirmed with one completed receipt`, async () => {
  reset(answer);
  const { articleId } = await material();
  const beforeHits = hits;
  assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
  const saved = await state(articleId);
  assert.equal(saved.body_status, "unconfirmed");
  assert.equal(saved.revision, 1);
  assert.equal(saved.body_text, null);
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
  assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
  assert.equal(hits, beforeHits + 1, "the empty result is reused without paying for it again");
});

for (const empty of [false, true]) test(`an obsolete ${empty ? "empty" : "successful"} Jina answer completes without overwriting a newer revision`, async () => {
  reset(empty ? "" : markdown);
  hold = { entered: gate(), release: gate() };
  const held = hold;
  const { articleId, input } = await material();
  const pending = extractArticleBody(articleId, true);
  await held.entered.promise;
  let expected;
  try {
    await upsertMaterial({ ...input, title: "Corrected publisher revision", ...(empty ? {} : { bodyText: "The newer publisher body." }) });
    expected = await state(articleId);
  } finally { held.release.open(); }
  assert.equal(await pending, "skipped");
  assert.deepEqual(await state(articleId), expected);
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
});

test("a matching Jina body hash settles its receipt without another revision", async () => {
  reset();
  const body = stripTags(markdownBody(markdown, base));
  const { articleId } = await material({ bodyText: body, bodyStatus: "pending" });
  assert.equal(await extractArticleBody(articleId, true), "ok");
  const saved = await state(articleId);
  assert.equal(saved.body_status, "ok");
  assert.equal(saved.revision, 1);
  assert.equal((await sql`SELECT 1 FROM article_revisions WHERE article_id=${articleId}`).length, 1);
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
});

test("a failed material transaction retains the received Jina answer for a free persistence retry", async () => {
  reset();
  const { articleId } = await material();
  const beforeHits = hits;
  assert.match(articleId, /^[a-zA-Z0-9_-]+$/);
  const functionName = `fail_jina_body_${tag()}`;
  await sql.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id = '${articleId}' AND NEW.body_status = 'ok' THEN RAISE EXCEPTION 'injected Jina body storage failure'; END IF;
    RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${functionName} BEFORE UPDATE ON articles FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  try {
    await assert.rejects(extractArticleBody(articleId, true), /injected Jina body storage failure/);
    assert.equal((await state(articleId)).body_status, "pending");
    assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["received", 1]]);
  } finally {
    await sql.unsafe(`DROP TRIGGER ${functionName} ON articles`);
    await sql.unsafe(`DROP FUNCTION ${functionName}()`);
  }
  assert.equal(await extractArticleBody(articleId, true), "ok");
  assert.equal(hits, beforeHits + 1);
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
});

test("an unknown Jina response cannot be silently purchased again", async () => {
  reset(); drop = true;
  const { articleId } = await material();
  const beforeHits = hits;
  await assert.rejects(extractArticleBody(articleId, true));
  assert.equal((await state(articleId)).body_status, "pending");
  assert.equal((await receipts(articleId))[0]?.status, "unknown");
  await assert.rejects(extractArticleBody(articleId, true), ReceiptUnknownError);
  assert.equal(hits, beforeHits + 1);
});
