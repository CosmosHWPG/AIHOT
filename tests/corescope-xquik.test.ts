// Local-only HTTP and throwaway PostgreSQL: provider attribution, continuation and cost guards.
import { Reply, gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { paidRequest, BudgetExceededError } from "@aihot/backend/providers/receipts";
import { normalizeXquikTweet, searchXquikTweets } from "@aihot/backend/providers/xquik";
import { planXBootstrap, planXShards, readXSearch, xArticleText } from "@aihot/backend/sources/x";
import { collectSource, collectXShard, scheduleDueSources } from "@aihot/backend/sources/collect";
import { extractArticleBody } from "@aihot/backend/content/extract";

const T = tag().slice(-7);
const handles = [0, 1, 2].map(i => `xq${T}${i}`);
const sources = handles.map(h => `test-xquik-${h}`);
const baseId = (BigInt(Date.now() - 1288834974657) << 22n) + 1000n;
const rawTweet = (id: bigint, handle = handles[0]!, text = `Original post ${T}`) => ({
  id: String(id), text, createdAt: new Date().toISOString(), author: { username: handle, name: handle },
  likeCount: 1, retweetCount: 2, viewCount: 30,
});
let balance = 10_000;
let emptyFirst = false;
let failPage2 = false;
let rows: Record<string, any>[] = [];
let accountReads = 0;
let searches = 0;
let holdSearch: ReturnType<typeof gate<void>> | null = null;
let searchEntered: ReturnType<typeof gate<void>> | null = null;
const articleReads: string[] = [];
const server = await stub(async (_hit, req) => {
  const url = new URL(req.url, "http://stub");
  if (url.pathname === "/account") { accountReads += 1; return { creditInfo: { balance: String(balance) } }; }
  const article = /^\/x\/articles\/(\d+)$/.exec(url.pathname)?.[1];
  if (article) {
    articleReads.push(article);
    return { article: { title: "Confirmed Xquik Article", bodyText: "Full original article body", contents: [] } };
  }
  if (url.pathname !== "/x/tweets/search") return new Reply(404, {});
  searches += 1;
  if (holdSearch) { searchEntered?.open(); await holdSearch.promise; }
  assert.equal(url.searchParams.get("queryType"), "Latest");
  const query = url.searchParams.get("q") ?? "";
  const watermark = BigInt(/since_id:(\d+)/.exec(query)?.[1] ?? "0");
  const page = Number(url.searchParams.get("cursor") ?? 0);
  if (page === 1 && failPage2) return new Reply(503, { error: "local simulated failure" });
  const candidates = rows.filter(row => BigInt(row.id) > watermark);
  const limit = Number(url.searchParams.get("limit"));
  const result = emptyFirst && page === 0 ? [] : candidates.slice(page * limit, page * limit + limit);
  const next = emptyFirst && page === 0 ? "1" : (page + 1) * limit < candidates.length ? String(page + 1) : "";
  return { tweets: result, has_next_page: !!next, next_cursor: next };
});
process.env.XQUIK_BASE_URL = server.url;
process.env.X_TWITTER_SCRAPER_API_KEY = "test-xquik-key";
process.env.XQUIK_PAGE_LIMIT = "2";
process.env.XQUIK_DAILY_CREDIT_LIMIT = "1000";
process.env.XQUIK_CREDIT_RESERVE = "100";
process.env.XQUIK_MAX_PAGES = "2";
delete process.env.SOCIALDATA_API_KEY;
config.allowPrivateNetworkFetch = true;
const setting = async (id: string) => (await sql<{ cursor: Record<string, any> | null }[]>`SELECT cursor FROM sources WHERE id = ${id}`)[0]!.cursor;
let savedBudget: Array<{ per_minute: number; per_hour: number; per_day: number; note: string | null }> = [];

before(async () => {
  savedBudget = await sql`SELECT per_minute, per_hour, per_day, note FROM budgets WHERE service = 'xquik'`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('xquik', 1000, 10000, 100000)
    ON CONFLICT (service) DO UPDATE SET per_minute = 1000, per_hour = 10000, per_day = 100000`;
  for (const [i, source] of sources.entries()) await sql`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, enabled, next_fetch_at)
    VALUES (${source}, ${handles[i]!}, 'x_search', ${sql.json({ provider: "xquik", query: `from:${handles[i]} -filter:replies`, searchType: "Latest" })},
      'T1', 'editorial', true, '2100-01-01')`;
});
beforeEach(async () => {
  balance = 10_000; emptyFirst = false; failPage2 = false; rows = []; searches = 0; accountReads = 0;
  holdSearch = null; searchEntered = null;
  process.env.XQUIK_DAILY_CREDIT_LIMIT = "1000";
  await sql`DELETE FROM receipts WHERE service = 'xquik' AND subject LIKE ${`%${T}%`}`;
  await sql`UPDATE sources SET cursor = NULL, next_fetch_at = '2100-01-01' WHERE id IN ${sql(sources)}`;
});
after(async () => {
  const saved = savedBudget[0];
  if (saved) await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day, note)
    VALUES ('xquik', ${saved.per_minute}, ${saved.per_hour}, ${saved.per_day}, ${saved.note})
    ON CONFLICT (service) DO UPDATE SET per_minute = EXCLUDED.per_minute, per_hour = EXCLUDED.per_hour, per_day = EXCLUDED.per_day, note = EXCLUDED.note`;
  else await sql`DELETE FROM budgets WHERE service = 'xquik'`;
  await sql`DELETE FROM budgets WHERE service = ${`xquik-credits-${T}`}`;
  await sql`UPDATE sources SET enabled = false WHERE id IN ${sql(sources)}`;
  await server.close(); await stopBoss(); await closeDb();
});

test("Xquik retains full Note Tweet, exact actor, quoted context and Article marker", () => {
  const raw = rawTweet(baseId);
  const normalized = normalizeXquikTweet({ ...raw, text: "truncated", noteTweet: { text: "Complete original long text" },
    article: { id: "777" }, quoted_tweet: rawTweet(baseId - 1n, handles[1]!, "Quoted evidence") });
  assert.match(normalized.full_text!, /^Complete original long text\nhttps:\/\/x.com\/i\/article\/777$/);
  assert.equal(normalized.quoted_status?.user.screen_name, handles[1]);
  assert.throws(() => normalizeXquikTweet({ ...raw, author: {} }), /actor/);
  assert.throws(() => normalizeXquikTweet({ ...raw, createdAt: "" }), /original date/);
});

test("shards isolate providers and bootstrap only accounts without a real watermark", () => {
  const members = sources.map((id, i) => ({ id, kind: "x_search" as const, participation_mode: "editorial" as const,
    config: { provider: "xquik", query: `from:${handles[i]} -filter:replies` }, cursor: { lastTweetId: "1" } }));
  const shards = planXShards([...members, { ...members[0]!, id: `sd-${T}`, config: { query: `from:legacy${T} -filter:replies` } }]);
  assert.equal(shards.length, 2);
  assert.deepEqual(new Set(shards.map(s => s.provider)), new Set(["socialdata", "xquik"]));
  assert.equal(planXBootstrap(members).length, 0);
  assert.deepEqual(planXBootstrap(members.map(m => ({ ...m, cursor: null })))[0]!.sourceIds, sources);
});

test("saved search response reuses credits and does not even repeat the free account request", async () => {
  rows = [rawTweet(baseId)];
  const options = { purpose: "test", subject: T, window: T };
  const first = await searchXquikTweets(`from:${handles[0]} ${T}`, options);
  const again = await searchXquikTweets(`from:${handles[0]} ${T}`, options);
  assert.equal(again.receiptId, first.receiptId); assert.equal(again.reused, true);
  assert.equal(searches, 1); assert.equal(accountReads, 1);
  const [attempt] = await sql`SELECT reserved_credits, usage FROM receipt_attempts WHERE receipt_id = ${first.receiptId}`;
  assert.equal(attempt!.reserved_credits, 2); assert.equal(attempt!.usage.credits, 1);
});

test("missing finite request budget and insufficient credit reserve prevent network payment", async () => {
  await sql`DELETE FROM budgets WHERE service = 'xquik'`;
  await assert.rejects(searchXquikTweets(`budget-${T}`, { purpose: "test", subject: T, window: T }), /unconfigured/);
  assert.equal(searches, 0); assert.equal(accountReads, 0);
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('xquik', 1000, 10000, 100000)`;
  balance = 101;
  await assert.rejects(searchXquikTweets(`reserve-${T}`, { purpose: "test", subject: T, window: T }), /credits-reserve/);
  assert.equal(searches, 0);
});

test("parallel claims respect conservative daily credit reservations including unknown outcomes", async () => {
  let calls = 0;
  const service = `xquik-credits-${T}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 1000, 10000, 100000)`;
  const creditBudget = { maximum: 2, dailyLimit: 2, reserve: 100, availableCredits: async () => 1000 };
  const attempt = (identity: string) => paidRequest({ service, purpose: "test", subject: T, identity, requireBudget: true, creditBudget },
    async () => { calls += 1; throw new Error("simulated unknown outcome"); });
  const results = await Promise.allSettled([attempt(`one-${T}`), attempt(`two-${T}`)]);
  assert.equal(calls, 1);
  assert.equal(results.filter(r => r.status === "rejected" && r.reason instanceof BudgetExceededError).length, 1);
  const [usage] = await sql`SELECT sum(reserved_credits)::int AS credits, count(*)::int AS attempts FROM receipt_attempts
    WHERE receipt_id IN (SELECT id FROM receipts WHERE service = ${service} AND subject = ${T})`;
  assert.equal(usage!.credits, 2); assert.equal(usage!.attempts, 1);
});

test("concurrent in-flight reservations protect the provider balance reserve", async () => {
  const service = `xquik-credits-${T}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 1000, 10000, 100000)
    ON CONFLICT (service) DO NOTHING`;
  await sql`DELETE FROM receipts WHERE service = ${service}`;
  const sent = gate(); const finish = gate(); let calls = 0;
  const creditBudget = { maximum: 2, dailyLimit: 20, reserve: 100, availableCredits: async () => 103 };
  const first = paidRequest({ service, purpose: "test", subject: T, identity: `inflight-${T}`, requireBudget: true, creditBudget }, async () => {
    calls += 1; sent.open(); await finish.promise; return { response: {}, usage: { credits: 2 } };
  });
  await sent.promise;
  try {
    await assert.rejects(paidRequest({ service, purpose: "test", subject: T, identity: `second-${T}`, requireBudget: true, creditBudget },
      async () => { calls += 1; return { response: {} }; }), /credits-reserve/);
    assert.equal(calls, 1);
  } finally { finish.open(); await first; }
});

test("empty filtered pages continue, and a failed later page preserves successful posts and backlog", async () => {
  rows = [rawTweet(baseId + 4n), rawTweet(baseId + 3n), rawTweet(baseId + 2n), rawTweet(baseId + 1n)];
  emptyFirst = true;
  const empty = await readXSearch(`from:${handles[0]} empty-${T}`, { lastId: String(baseId), backlog: [], subject: T, provider: "xquik" });
  assert.equal(empty.tweets.length, 2); assert.equal(empty.pages, 2);
  emptyFirst = false; failPage2 = true;
  const first = await readXSearch(`from:${handles[0]} fail-${T}`, { lastId: String(baseId), backlog: [], subject: T, provider: "xquik" });
  assert.equal(first.tweets.length, 2); assert.equal(first.backlog.length, 1); assert.equal(first.truncated, true);
  failPage2 = false;
  const resumed = await readXSearch(`from:${handles[0]} fail-${T}`, { lastId: first.lastId, backlog: first.backlog, subject: T, provider: "xquik" });
  assert.deepEqual(resumed.tweets.map(t => t.id_str), [String(baseId + 2n), String(baseId + 1n)]);
  assert.equal(resumed.backlog.length, 0);
});

test("bootstrap stores each author's material without initializing accounts absent from the answer", async () => {
  rows = [rawTweet(baseId + 10n, handles[0]!)];
  const result = await collectXShard(`editorial:xquik-bootstrap:${T}`, sources);
  assert.equal(result.status, "ok"); assert.equal(result.created, 1); assert.equal(searches, 1);
  assert.equal((await setting(sources[0]!))!.lastTweetId, String(baseId + 10n));
  for (const id of sources.slice(1)) {
    const cursor = (await setting(id))!;
    assert.equal(cursor.lastTweetId, undefined); assert.equal(cursor.initializedAt, undefined);
  }
  const [material] = await sql`SELECT x_post, identity_key, source_id, backfill FROM articles WHERE identity_key = ${`x:${baseId + 10n}`}`;
  assert.equal(material!.source_id, sources[0]); assert.equal(material!.x_post.provider, "xquik"); assert.equal(material!.backfill, true);
  assert.equal((await collectXShard(`editorial:xquik-bootstrap:${T}`, sources)).created, 0, "repeat paid responses cannot duplicate the tweet");
});

test("scheduler batches uninitialized Xquik accounts without individual fetch jobs", async () => {
  process.env.COLLECT_KINDS = "x_search";
  await sql`UPDATE sources SET next_fetch_at = NULL WHERE id IN ${sql(sources)}`;
  const result = await scheduleDueSources();
  assert.ok(result.shards >= 1);
  const individual = await sql`SELECT id FROM pgboss.job WHERE name = 'sources.fetch' AND data->>'sourceId' IN ${sql(sources)}`;
  assert.equal(individual.length, 0);
});

test("Xquik Article extraction calls its own route and falls back to full bodyText without SocialData", async () => {
  rows = [rawTweet(baseId + 20n, handles[0]!, "https://x.com/i/article/777")];
  await collectXShard(`editorial:xquik-article:${T}`, [sources[0]!]);
  const [material] = await sql<{ id: string }[]>`SELECT id FROM articles WHERE identity_key = ${`x:${baseId + 20n}`}`;
  assert.equal(await extractArticleBody(material!.id), "ok");
  assert.equal(articleReads.at(-1), String(baseId + 20n));
  const [body] = await sql`SELECT title, x_article FROM articles WHERE id = ${material!.id}`;
  assert.equal(body!.title, "Confirmed Xquik Article"); assert.equal(body!.x_article.text, "Full original article body");
  assert.equal(xArticleText({ title: "test", content_state: { blocks: [{ type: "unstyled", text: "body" }] } })!.text, "body");
});

test("an in-flight paid single-source fetch cannot overwrite a newly selected Bird route", async () => {
  rows = [rawTweet(baseId + 100n)]; holdSearch = gate(); searchEntered = gate();
  const running = collectSource(sources[0]!);
  await searchEntered.promise;
  try {
    await sql`UPDATE sources SET config=${sql.json({ provider: "bird", query: `from:${handles[0]} -filter:replies`, bird: { maxPagesPerRound: 1 } })},
      cursor=${sql.json({ lastTweetId: "111", bird: { coverage: "unknown", backlog: [] } })},interval_minutes=1440 WHERE id=${sources[0]!}`;
    holdSearch.open(); const result = await running;
    assert.equal(result.status, "skipped"); assert.equal((await setting(sources[0]!))!.lastTweetId, "111");
    const [run] = await sql`SELECT detail FROM fetch_runs WHERE source_id=${sources[0]!} ORDER BY id DESC LIMIT 1`;
    assert.deepEqual(run!.detail, { provider: "xquik" }, "a newly selected Bird route cannot relabel the in-flight paid run");
    assert.equal((await sql`SELECT id FROM articles WHERE identity_key=${`x:${baseId + 100n}`}`).length, 0);
  } finally {
    holdSearch.open(); holdSearch = null;
    await sql`UPDATE sources SET config=${sql.json({ provider: "xquik", query: `from:${handles[0]} -filter:replies`, searchType: "Latest" })} WHERE id=${sources[0]!}`;
  }
});

test("an in-flight paid shard skips only changed members and preserves their Bird cursor and interval", async () => {
  rows = [rawTweet(baseId + 110n, handles[0]!), rawTweet(baseId + 111n, handles[1]!)];
  holdSearch = gate(); searchEntered = gate();
  const running = collectXShard(`editorial:xquik-switch:${T}`, sources);
  await searchEntered.promise;
  try {
    await sql`UPDATE sources SET config=${sql.json({ provider: "bird", query: `from:${handles[0]} -filter:replies`, bird: { maxPagesPerRound: 1 } })},
      cursor=${sql.json({ lastTweetId: "222", bird: { coverage: "unknown", backlog: [] } })},interval_minutes=1440 WHERE id=${sources[0]!}`;
    holdSearch.open(); const result = await running;
    assert.equal(result.status, "ok"); assert.equal(result.accounts, 2); assert.equal(result.created, 1);
    assert.equal((await setting(sources[0]!))!.lastTweetId, "222");
    assert.equal((await sql`SELECT interval_minutes FROM sources WHERE id=${sources[0]!}`)[0]!.interval_minutes, 1440);
    assert.equal((await sql`SELECT id FROM articles WHERE identity_key=${`x:${baseId + 110n}`}`).length, 0);
  } finally {
    holdSearch.open(); holdSearch = null;
    await sql`UPDATE sources SET config=${sql.json({ provider: "xquik", query: `from:${handles[0]} -filter:replies`, searchType: "Latest" })} WHERE id=${sources[0]!}`;
  }
});
