// Publisher policy must refuse before any paid ledger or network operation, including old unknowns.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { jinaRead, JinaPublisherPolicyError } from "@aihot/backend/providers/jina";
import { jinaDeniedPublisher, routineBodyRoute } from "@aihot/backend/content/body-route";

const prefix = `jina-publisher-${tag()}`;
const previousDispatcher = getGlobalDispatcher(), previousProxy = config.egressProxyUrl;
const previousPrivate = config.allowPrivateNetworkFetch, previousKey = process.env.JINA_API_KEY, previousBase = process.env.JINA_BASE_URL;
const mock = new MockAgent(); let hits = 0;
const urls = ["https://doublepulsar.com/research-abcd1234abcd", "https://www.mittrchina.com/news/detail/17164", "https://speechhome.com/post/2116116444335968256"];
before(() => {
  mock.disableNetConnect();
  mock.get("http://127.0.0.1:21998").intercept({ path: /.*/ }).reply(() => { hits++; return { statusCode: 200, data: "Unexpected Jina request" }; }).persist();
  config.egressProxyUrl = null; config.allowPrivateNetworkFetch = true; setGlobalDispatcher(mock);
  process.env.JINA_API_KEY = "offline-policy-test"; process.env.JINA_BASE_URL = "http://127.0.0.1:21998";
});
after(async () => {
  await sql`DELETE FROM receipts WHERE logical_key LIKE ${prefix + "%"} OR subject LIKE ${prefix + "%"}`;
  await closeDb(); await mock.close(); setGlobalDispatcher(previousDispatcher);
  config.egressProxyUrl = previousProxy; config.allowPrivateNetworkFetch = previousPrivate;
  if (previousKey === undefined) delete process.env.JINA_API_KEY; else process.env.JINA_API_KEY = previousKey;
  if (previousBase === undefined) delete process.env.JINA_BASE_URL; else process.env.JINA_BASE_URL = previousBase;
});

test("the three approved routes cover article IDs, including exact 19-digit Speechhome identity", () => {
  assert.deepEqual(routineBodyRoute(urls[0]!), { id: "doublepulsar-rss", adapter: "rss", feedUrl: "https://doublepulsar.com/feed" });
  assert.deepEqual(routineBodyRoute(urls[1]!), { id: "mittrchina-native", adapter: "mittrchina" });
  assert.deepEqual(routineBodyRoute(urls[2]!), { id: "speechhome-native", adapter: "speechhome" });
  assert.equal(routineBodyRoute("https://www.speechhome.com/blogs/all/2116116444335968256")?.adapter, "speechhome");
  assert.equal(routineBodyRoute(urls[0]! + "?source=rss-blog&utm_source=feed")?.adapter, "rss");
});
test("publisher-wide no-Jina covers navigation, queries, fragments and supported www aliases", () => {
  for (const host of ["doublepulsar.com", "www.doublepulsar.com", "mittrchina.com", "www.mittrchina.com", "apii.web.mittrchina.com", "speechhome.com", "www.speechhome.com", "speechhome.com."])
    for (const path of ["/", "/login?next=article#part", "/future-unsupported-layout", "/feed"])
      assert.equal(jinaDeniedPublisher(`https://${host}${path}`), true);
});
test("unsupported or credential-bearing routes never acquire an approved body strategy", () => {
  for (const url of ["https://doublepulsar.com/", "https://doublepulsar.com/feed", "https://doublepulsar.com/tagged/security",
    "https://www.mittrchina.com/news/detail/0", "https://speechhome.com/blogs/2116116444335968256", "https://speechhome.com/post/1?access_token=private",
    "https://user:password@speechhome.com/post/1", "https://speechhome.com:8443/post/1", "http://speechhome.com/post/1", "https://speechhome.com/post/1#part"])
    assert.equal(routineBodyRoute(url), null, url);
});
test("unrelated Hacker News targets and lookalike hosts retain their existing supplier policy", () => {
  for (const url of ["https://news.ycombinator.com/item?id=1", "https://other-publisher.example.com/article", "https://evil.mittrchina.com/news/detail/17164",
    "https://mittrchina.com.evil.example.com/news/detail/17164", "https://speechhome.com@evil.example.com/post/1", "not a URL"])
    assert.equal(jinaDeniedPublisher(url), false, url);
});
for (const purpose of ["body_fallback", "source_detail", "source_listing", "other-purpose"]) test(`${purpose} refuses all three publishers with zero receipts and network calls`, async () => {
  const before = await sql`SELECT count(*)::int AS n FROM receipts WHERE subject LIKE ${prefix + "%"}`;
  for (const [i,url] of urls.entries()) {
    await assert.rejects(jinaRead(url, { purpose, subject: `${prefix}-${purpose}-${i}`, format: "markdown" }), JinaPublisherPolicyError);
    await assert.rejects(jinaRead(url, { purpose, subject: `${prefix}-${purpose}-${i}`, format: "html", round: "different-day" }), JinaPublisherPolicyError);
  }
  assert.deepEqual(await sql`SELECT count(*)::int AS n FROM receipts WHERE subject LIKE ${prefix + "%"}`, before);
  assert.equal(hits, 0);
});
test("the prohibition wins even without configured credentials", async () => {
  const key = process.env.JINA_API_KEY; delete process.env.JINA_API_KEY;
  try { await assert.rejects(jinaRead(urls[0]!, { purpose: "body_fallback", subject: prefix + "-without-key" }), JinaPublisherPolicyError); }
  finally { process.env.JINA_API_KEY = key; }
  assert.equal(hits, 0);
});
test("old unknown receipts and attempts remain untouched; no release or new paid identity is created", async () => {
  const [receipt] = await sql<{id:number}[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,attempts,request)
    VALUES(${prefix + "-old-unknown"},'jina','body_fallback',${prefix + "-old"},'unknown',1,${sql.json({ url: urls[2] })}) RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status) VALUES(${receipt.id},1,'jina','unknown')`;
  const ledger = () => sql`SELECT r.*,t.status AS attempt_status,t.started_at,t.finished_at FROM receipts r JOIN receipt_attempts t ON t.receipt_id=r.id WHERE r.id=${receipt.id}`;
  const before = await ledger();
  await assert.rejects(jinaRead(urls[2]!, { purpose: "body_fallback", subject: prefix + "-old", round: "next-day", format: "html" }), JinaPublisherPolicyError);
  assert.deepEqual(await ledger(), before); assert.equal(hits, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE subject=${prefix + "-old"}`)[0]!.n, 1);
});
