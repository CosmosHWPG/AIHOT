// Public body transports use local MockAgent only; the worker fixture uses a disposable *_test DB.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { extractNativeBody, extractRoutineNativeBody } from "@aihot/backend/content/native-body";
import { extractFeedBody, sanitizeFeedBody } from "@aihot/backend/content/feed-body";
import { extractRoutineBody } from "@aihot/backend/content/routine-body";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { registerExtractionJobs } from "@aihot/backend/jobs/content";
import { RECENT_CONTENT_POLICY_KEY, invalidateRecentContentCache, setRecentContentPolicy } from "@aihot/backend/jobs/recent-content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";

const prefix = `routine-transport-${tag()}`, sourceId = `${prefix}-source`;
const oldDispatcher = getGlobalDispatcher(), oldProxy = config.egressProxyUrl, oldPrivate = config.allowPrivateNetworkFetch;
const mock = new MockAgent(); let paidHits = 0, nextId = 801000;
const body = `<p>${"Public research describes the architecture, measured evidence and limitations of acoustic models. ".repeat(8)}</p><p>The final experiment concludes the engineering evaluation.</p>`;
const title = "Public acoustic architecture research";
const ids: string[] = []; let oldPolicy: any[] = [];
function input() {
  const id = ++nextId;
  return { adapter: "mittrchina" as const, originalUrl: `https://www.mittrchina.com/news/detail/${id}`, title,
    endpoint: `https://apii.web.mittrchina.com/information/details?id=${id}`, id };
}
function response(id: number, extra: Record<string, unknown> = {}) {
  return { code: 10000, data: { id, name: title, status: 1, is_vip: 2, content: body, ...extra } };
}
function proof(url: string) {
  const text = sanitizeFeedBody(body, url).text;
  return { bodySha256: sha256(text), tailSha256: sha256(text.slice(-200)), requiredTerms: ["acoustic", "engineering"] };
}
function intercept(endpoint: string) {
  const url = new URL(endpoint);
  return mock.get(url.origin).intercept({ path: url.pathname + url.search, method: "GET" });
}
before(async () => {
  mock.disableNetConnect(); config.egressProxyUrl = null; config.allowPrivateNetworkFetch = true; setGlobalDispatcher(mock);
  mock.get("https://r.jina.ai").intercept({ path: /.*/ }).reply(() => { paidHits++; return { statusCode: 200, data: "Forbidden paid fallback" }; }).persist();
  oldPolicy = await sql`SELECT value,updated_by,updated_at FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  await setRecentContentPolicy(true, "offline-test", "Retain normal recent-news admission");
  await sql`INSERT INTO sources(id,name,kind,enabled,tier,participation_mode,site_fulltext,syndicate_fulltext,config)
    VALUES(${sourceId},'Public body transport fixture','rss',true,'T2','editorial',false,false,'{}')`;
});
after(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`DELETE FROM articles WHERE source_id=${sourceId}`;
  await sql`DELETE FROM sources WHERE id=${sourceId}`;
  await sql`DELETE FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  for (const row of oldPolicy) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${RECENT_CONTENT_POLICY_KEY},${sql.json(row.value)},${row.updated_by},${row.updated_at})`;
  invalidateRecentContentCache(); await stopBoss(); await closeDb();
  setGlobalDispatcher(oldDispatcher); config.egressProxyUrl = oldProxy; config.allowPrivateNetworkFetch = oldPrivate; await mock.close();
  assert.equal(paidHits, 0);
});

for (const status of [408, 429, 500, 503]) test(`routine native HTTP ${status} is retryable while fixed recovery keeps its previous null outcome`, async () => {
  const i = input(); intercept(i.endpoint).reply(status, response(i.id), { headers: { "content-type": "application/json" } }).times(2);
  await assert.rejects(extractRoutineNativeBody(i), new RegExp(`HTTP ${status}`));
  assert.equal(await extractNativeBody({ ...i, bodyProof: proof(i.originalUrl) }), null);
  assert.equal(paidHits, 0);
});
test("routine native network failure escapes for the normal worker; fixed recovery does not change semantics", async () => {
  const i = input(); intercept(i.endpoint).replyWithError(new Error("offline transport reset")).times(2);
  await assert.rejects(extractRoutineNativeBody(i), /fetch failed|offline transport reset/i);
  assert.equal(await extractNativeBody({ ...i, bodyProof: proof(i.originalUrl) }), null);
});
for (const status of [401, 403, 404]) test(`native HTTP ${status} is not bypassed, retried in the adapter or sent to Jina`, async () => {
  const i = input(); let hits = 0;
  intercept(i.endpoint).reply(options => {
    hits++; assert.doesNotMatch(JSON.stringify(options.headers ?? {}), /authorization|cookie/i);
    return { statusCode: status, data: JSON.stringify(response(i.id)), responseOptions: { headers: { "content-type": "application/json" } } };
  });
  assert.equal(await extractRoutineNativeBody(i), null); assert.equal(hits, 1); assert.equal(paidHits, 0);
});
test("native permission, validation and non-JSON shells remain unconfirmed without purchasing another rendering", async () => {
  for (const fixture of [
    { extra: { is_vip: 1 }, type: "application/json" },
    { extra: { content: "<p>Verify you are human</p>" + body }, type: "application/json" },
    { extra: { content: "<p>登录后阅读全文</p>" + body }, type: "application/json" },
    { extra: { id: -1 }, type: "application/json" },
    { extra: {}, type: "text/html" },
  ]) {
    const i = input(); intercept(i.endpoint).reply(200, response(i.id, fixture.extra), { headers: { "content-type": fixture.type } });
    assert.equal(await extractRoutineNativeBody(i), null);
  }
  assert.equal(paidHits, 0);
});
test("routine RSS transport has a separate failure cache and throws temporary failures; fixed RSS still returns null", async () => {
  const feedUrl = `https://doublepulsar.com/feed?fixture=${prefix}`, originalUrl = "https://doublepulsar.com/research-abcd1234abcd";
  let hits = 0; intercept(feedUrl).reply(() => { hits++; return { statusCode: 503, data: "Temporarily unavailable" }; }).times(2);
  assert.equal(await extractFeedBody({ feedUrl, originalUrl, title }), null);
  await assert.rejects(extractFeedBody({ feedUrl, originalUrl, title, retryTransient: true }), /HTTP 503/);
  assert.equal(await extractFeedBody({ feedUrl, originalUrl, title }), null);
  assert.equal(hits, 2, "routine mode cannot reuse the fixed-mode terminal-null cache");
});
test("the daily DoublePulsar route propagates HTTP 429 without using direct Readability or Jina", async () => {
  intercept("https://doublepulsar.com/feed").reply(429, "Upstream throttled");
  await assert.rejects(extractRoutineBody({ originalUrl: "https://doublepulsar.com/research-abcd1234abcd", title }), /HTTP 429/);
  assert.equal(paidHits, 0);
});
test("the existing extraction handler gives transient native failures its normal three attempts, then settles unconfirmed", async () => {
  const i = input(); let hits = 0;
  intercept(i.endpoint).reply(() => { hits++; return { statusCode: 503, data: "Upstream temporarily unavailable" }; }).persist();
  const created = await upsertMaterial({ sourceId, url: i.originalUrl, title, publishedAt: new Date(), bodyStatus: "pending", via: "fetch" });
  ids.push(created.articleId); invalidateRecentContentCache();
  let handle: ((jobs: any[]) => Promise<any>) | undefined;
  const fakeBoss = { work: async (_name: string, _options: unknown, handler: (jobs: any[]) => Promise<any>) => { handle = handler; return "offline-handler"; } };
  await registerExtractionJobs(fakeBoss as unknown as PgBoss); assert.ok(handle);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result: { state: string } = await handle!([{ id: randomUUID(), data: { articleId: created.articleId } }]);
    const [row] = await sql`SELECT body_status,revision,processing_attempts,processing_retry_at FROM articles WHERE id=${created.articleId}`;
    assert.equal(row!.revision, 1);
    assert.equal(result.state, attempt < 3 ? "retrying" : "unconfirmed");
    assert.equal(row!.body_status, attempt < 3 ? "pending" : "unconfirmed");
    assert.equal(row!.processing_attempts, attempt < 3 ? attempt : 0);
    assert.equal(!!row!.processing_retry_at, attempt < 3);
  }
  assert.equal(hits, 3, "there are no hidden transport retries or paid fallbacks");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE subject=${"article:" + created.articleId}`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM analyses WHERE article_id=${created.articleId}`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name='content.analyze' AND data->>'articleId'=${created.articleId}`)[0]!.n, 1);
  assert.equal(paidHits, 0);
});
