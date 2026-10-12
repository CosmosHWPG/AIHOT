import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { identityKeyForUrl, normalizeUrl } from "@aihot/backend/lib/url";
import { mpHistory, mpArticle, resolveMpAccountSelector, MpIdentityError } from "@aihot/backend/providers/dajiala";
import { ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { checkMpAccount } from "@aihot/backend/sources/mp";

const T = tag();
const key = "fictional-dajiala-key-" + T;
let index = 0;
const account = () => Buffer.from(String(3000000000 + ++index)).toString("base64");
const article = (biz: string, mid = "2247483647", sn = "1".repeat(32)) => `https://mp.weixin.qq.com/s?${new URLSearchParams({ __biz: biz, mid, idx: "1", sn })}`;
const histories = new Map<string, unknown>();
const bodies = new Map<string, unknown>();
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
const provider = await stub((_hit, req) => {
  if (req.url.startsWith("/fbmain/monitor/v3/post_history")) {
    const body = JSON.parse(req.body);
    requests.push({ url: req.url, body });
    const identity = body.url ? new URL(body.url).searchParams.get("__biz") : body.ghid;
    return histories.get(identity) ?? { code: 0, data: [], cost_money: 0.14 };
  }
  const url = new URL(req.url, "http://stub").searchParams.get("url")!;
  requests.push({ url: req.url.split("?")[0]!, body: { articleUrl: url } });
  return bodies.get(url) ?? { code: 0, content: "Fixture body", url, cost_money: 0.03 };
});
process.env.DAJIALA_BASE_URL = provider.url;
process.env.DAJIALA_KEY = key;
const privateBefore = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
let budget: { per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  [budget] = await sql`SELECT per_minute, per_hour, per_day FROM budgets WHERE service='dajiala'`;
  await sql`UPDATE budgets SET per_minute=1000, per_hour=10000, per_day=100000 WHERE service='dajiala'`;
});
after(async () => {
  if (budget) await sql`UPDATE budgets SET per_minute=${budget.per_minute}, per_hour=${budget.per_hour}, per_day=${budget.per_day} WHERE service='dajiala'`;
  config.allowPrivateNetworkFetch = privateBefore;
  await provider.close(); await stopBoss(); await closeDb();
});
async function source(biz: string) {
  const id = `test-dajiala-${T}-${index}`;
  const seed = article(biz);
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${id},'Dajiala fixture','mp_account',${sql.json({ transport: "dajiala", articleUrl: seed, biz })},'T1','editorial',
      ${sql.json({ lastCheckedAt: "2020-01-01T00:00:00.000Z" })},'2100-01-01')`;
  return id;
}
const post = (url: string) => ({ position: 1, url, title: "WeChat fixture " + T, post_time: Math.floor(Date.now() / 1000) - 3600, sn: "1".repeat(32) });

test("an account's material limit bounds paid body calls while missing credentials never consume a receipt", async () => {
  const biz = account(); const id = await source(biz);
  await sql`UPDATE sources SET config=config || '{"limit":2}'::jsonb WHERE id=${id}`;
  const posts = ["2247483647", "2247483648", "2247483649", "2247483650"].map((mid, i) => {
    const sn = String(i + 2).repeat(32);
    return { ...post(article(biz, mid, sn)), sn };
  });
  histories.set(biz, { code: 0, data: posts, cost_money: 0.14 });
  const before = provider.hits();
  const result = await checkMpAccount(id, "manual");
  assert.equal(result.status, "ok"); assert.equal("created" in result && result.created, 2);
  assert.equal(provider.hits() - before, 3, "one history request and only two body requests");
  const keyBefore = process.env.DAJIALA_KEY;
  delete process.env.DAJIALA_KEY;
  try {
    const calls = provider.hits();
    const missing = await checkMpAccount(id, "manual");
    assert.equal(missing.status, "unconfigured");
    assert.equal(provider.hits(), calls);
  } finally {process.env.DAJIALA_KEY = keyBefore;}
});

test("account selectors require a verified public long-link biz and retain original ghid compatibility", () => {
  const biz = account();
  assert.equal(resolveMpAccountSelector({ articleUrl: article(biz), biz }).biz, biz);
  assert.equal(resolveMpAccountSelector("gh_012345abcdef").ghid, "gh_012345abcdef");
  assert.throws(() => resolveMpAccountSelector({ articleUrl: article(biz), biz: account() }), /disagree/);
  assert.throws(() => resolveMpAccountSelector({ articleUrl: "https://mp.weixin.qq.com/s/short-link", biz }), /long link/);
  assert.throws(() => resolveMpAccountSelector({ articleUrl: "https://mp.weixin.qq.com.evil.invalid/s?__biz=" + biz }), /public WeChat/);
  assert.throws(() => resolveMpAccountSelector({ articleUrl: "https://mp.weixin.qq.com/s?__biz=not-base64" }), /invalid WeChat biz/);
});

test("two article seeds of one account share the history receipt and send the documented url selector", async () => {
  const biz = account();
  histories.set(biz, { code: 0, data: [post(article(biz))], ghid: "gh_012345abcdef", cost_money: 0.14, remain_money: 50 });
  const before = provider.hits();
  const first = await mpHistory({ articleUrl: article(biz), biz }, { subject: T, window: T });
  const again = await mpHistory({ articleUrl: article(biz, "2247483648"), biz }, { subject: T, window: T });
  assert.equal(provider.hits() - before, 1);
  assert.equal(first.receiptId, again.receiptId);
  assert.equal(again.reused, true);
  assert.equal(first.ghid, "gh_012345abcdef");
  const sent = requests.at(-1)!.body;
  assert.equal(sent.url, normalizeUrl(article(biz)));
  assert.equal(sent.biz, undefined, "biz is an identity guard, not an undocumented request selector");
  assert.equal(sent.ghid, undefined);
  assert.equal(sent.key, key);
  const [receipt] = await sql<{ cost: string; request: Record<string, unknown> }[]>`SELECT cost, request FROM receipts WHERE id=${first.receiptId}`;
  assert.equal(Number(receipt!.cost), 0.14);
  assert.ok(!JSON.stringify(receipt!.request).includes(key), "only public account identity enters the diagnostic summary");
});

test("foreign-account history fails before body collection without advancing the source cursor", async () => {
  const biz = account(); const id = await source(biz);
  histories.set(biz, { code: 0, data: [post(article(account()))], cost_money: 0.14 });
  const result = await checkMpAccount(id, "manual");
  assert.equal(result.status, "failed");
  const [stored] = await sql<{ cursor: { lastCheckedAt: string }; n: number }[]>`
    SELECT cursor, (SELECT count(*)::int FROM articles WHERE source_id=${id}) AS n FROM sources WHERE id=${id}`;
  assert.equal(stored!.cursor.lastCheckedAt, "2020-01-01T00:00:00.000Z");
  assert.equal(stored!.n, 0);
  const [receipt] = await sql<{ status: string; cost: string }[]>`SELECT status,cost FROM receipts WHERE subject=${id} ORDER BY id DESC LIMIT 1`;
  assert.equal(receipt!.status, "received"); assert.equal(Number(receipt!.cost), 0.14, "a billed unusable answer remains auditable");
});

test("authentication, balance and transient failures are distinguished without copying provider messages", async () => {
  for (const [code, label, retryable] of [[10002, "authentication failed", false], [20001, "insufficient balance", false], [2005, "temporary provider failure", true]] as const) {
    const biz = account(); histories.set(biz, { code, msg: key });
    await assert.rejects(mpHistory({ articleUrl: article(biz) }, { subject: `${T}-${code}`, window: T }), (error: Error) => {
      assert.ok(error instanceof ProviderRejectedError); assert.equal(error.retryable, retryable);
      assert.ok(error.message.includes(label)); assert.ok(!error.message.includes(key)); return true;
    });
    const [receipt] = await sql<{ error: string }[]>`SELECT error FROM receipts WHERE subject=${`${T}-${code}`} ORDER BY id DESC LIMIT 1`;
    assert.ok(!receipt!.error.includes(key));
  }
});

test("a billed rejection is reused rather than charged again in the same account window", async () => {
  const biz = account(); histories.set(biz, { code: 101, cost_money: 0.14 });
  const before = provider.hits();
  for (let i = 0; i < 2; i++) await assert.rejects(mpHistory({ articleUrl: article(biz) }, { subject: `${T}-billed`, window: T }), /code 101/);
  assert.equal(provider.hits() - before, 1);
  const [receipt] = await sql<{ status: string; cost: string; attempts: number }[]>`SELECT status,cost,attempts FROM receipts WHERE subject=${`${T}-billed`} ORDER BY id DESC LIMIT 1`;
  assert.equal(receipt!.status, "received"); assert.equal(Number(receipt!.cost), 0.14); assert.equal(receipt!.attempts, 1);
});

test("a short-link body requires confirmed canonical identity and rejects another article from the same account", async () => {
  const biz = account(); const short = `https://mp.weixin.qq.com/s/unresolved-${T}`;
  bodies.set(short, { code: 0, content: "Body", biz, cost_money: 0.03 });
  await assert.rejects(mpArticle(short, { subject: T, identity: `${T}-unresolved`, expectedBiz: biz }), MpIdentityError);
  bodies.set(article(biz), { code: 0, content: "Body", biz, url: article(biz, "2247483648"), cost_money: 0.03 });
  await assert.rejects(mpArticle(article(biz), { subject: T, identity: `${T}-wrong-article`, expectedBiz: biz }), /article identity mismatch/);
});

test("a resolved short link deduplicates an existing cache article and reuses paid body data on later checks", async () => {
  const biz = account(); const id = await source(biz); const cacheId = `${id}-cache`;
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode) VALUES (${cacheId},'Cache fixture','external','{}','T1','editorial')`;
  const canonical = article(biz); const short = `https://mp.weixin.qq.com/s/short-${T}-${index}`;
  const cached = await upsertMaterial({ sourceId: cacheId, url: canonical, title: "WeChat fixture " + T, bodyText: "Cached body", bodyStatus: "ok", via: "fetch" });
  histories.set(biz, { code: 0, data: [post(short)], ghid: "gh_012345abcdef", cost_money: 0.14 });
  bodies.set(short, { code: 0, content: "Provider body", biz, url: canonical, user_name: "gh_012345abcdef", cost_money: 0.03 });
  const before = provider.hits();
  const first = await checkMpAccount(id, "manual");
  assert.equal(first.status, "ok"); assert.equal("created" in first && first.created, 0);
  const again = await checkMpAccount(id, "schedule");
  assert.equal(again.status, "ok"); assert.equal(provider.hits() - before, 2, "manual/schedule share history; stored body receipt is also reused");
  const rows = await sql<{ id: string; source_id: string; body_text: string }[]>`SELECT id,source_id,body_text FROM articles WHERE identity_key=${identityKeyForUrl(canonical)}`;
  assert.equal(rows.length, 1); assert.equal(rows[0]!.id, cached.articleId); assert.equal(rows[0]!.source_id, cacheId); assert.equal(rows[0]!.body_text, "Cached body");
  const [discovery] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM article_discoveries WHERE article_id=${cached.articleId} AND source_id=${id}`;
  assert.equal(discovery!.n, 1);
  const receipts = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE subject=${id}`;
  assert.ok(receipts.length === 2 && receipts.every(r => r.status === "completed"));
});

test("a body from a foreign account fails the collector without importing or advancing its cursor", async () => {
  const biz = account(); const id = await source(biz); const canonical = article(biz);
  histories.set(biz, { code: 0, data: [post(canonical)], cost_money: 0.14 });
  bodies.set(canonical, { code: 0, content: "Wrong-account body", biz: account(), url: canonical, cost_money: 0.03 });
  const result = await checkMpAccount(id, "manual"); assert.equal(result.status, "failed");
  const [stored] = await sql<{ cursor: { lastCheckedAt: string }; n: number }[]>`SELECT cursor,(SELECT count(*)::int FROM articles WHERE source_id=${id}) AS n FROM sources WHERE id=${id}`;
  assert.equal(stored!.n, 0); assert.equal(stored!.cursor.lastCheckedAt, "2020-01-01T00:00:00.000Z");
});

test("a short link whose body call fails cannot be imported as a verified account article", async () => {
  const biz = account(); const id = await source(biz); const short = `https://mp.weixin.qq.com/s/fail-${T}-${index}`;
  histories.set(biz, { code: 0, data: [post(short)], cost_money: 0.14 }); bodies.set(short, new Reply(503, { error: "busy" }));
  const result = await checkMpAccount(id, "manual"); assert.equal(result.status, "failed");
  const [stored] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM articles WHERE source_id=${id}`;
  assert.equal(stored!.n, 0);
});
