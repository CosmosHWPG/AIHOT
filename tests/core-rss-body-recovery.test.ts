// Fixed per-article RSS body recovery: every HTTP connection terminates at local test stubs.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { sanitizeFeedBody } from "@aihot/backend/content/feed-body";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { applyRecoveryBatch, getRecoveryAdmission, getRecoveryBatch, getRecoveryRssBodyPolicy,
  parseRecoveryPlan, planRecoveryBatch, recoveryBatchStatus,
  RECOVERY_BATCH_PREFIX, stopRecoveryBatch, type RecoveryPlan, type RssBodyPolicy } from "@aihot/backend/jobs/processing-recovery";
import { invalidateRecentContentCache, RECENT_CONTENT_POLICY_KEY, setRecentContentPolicy,
  getRecentContentPriority } from "@aihot/backend/jobs/recent-content";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";

const prefix = `rss-body-${tag()}`;
const sourceIds = [`${prefix}-source`, `${prefix}-other`];
const articleIds: string[] = [], batchIds: string[] = [];
const sockets = new Set<Duplex>();
const feedReplies = new Map<string, { xml: string; hold?: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } }>();
let feedHits = 0, articleHits = 0, jinaHits = 0;
const proxy = http.createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://stub.example.com").pathname;
  const feed = feedReplies.get(path);
  if (feed) {
    feedHits++;
    if (feed.hold) { feed.hold.entered.open(); await feed.hold.release.promise; }
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(feed.xml);
  } else {
    articleHits++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><div id='app'></div></body></html>");
  }
});
proxy.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
proxy.on("connect", (req, socket, head) => {
  // The CONNECT target remains a structurally public URL, but is never dialled.
  if (!/^(?:articles|feeds)\.example\.com:80$/.test(req.url ?? "")) { socket.destroy(); return; }
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length) socket.unshift(head);
  proxy.emit("connection", socket);
});
proxy.on("clientError", (_error, socket) => socket.destroy());
const jina = http.createServer((_req, res) => {
  jinaHits++;
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Title: Unexpected paid fallback\nMarkdown Content:\n" + "A paid fallback must never run for this fixed article policy. ".repeat(12));
});
let originalProxy: string | null, originalPrivate: boolean;
let savedPolicy: Array<{ value: unknown; updated_by: string | null; updated_at: Date }> = [];
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const articleHtml = "<p>Anthropic Claude developer security research covers a remote access trojan and its safeguards. "
  + "The publication explains the technical evidence and original investigation in substantive detail.</p>";

before(async () => {
  await Promise.all([proxy, jina].map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
  originalProxy = config.egressProxyUrl; originalPrivate = config.allowPrivateNetworkFetch;
  config.egressProxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  config.allowPrivateNetworkFetch = true;
  process.env.JINA_BASE_URL = `http://127.0.0.1:${(jina.address() as { port: number }).port}`;
  process.env.JINA_API_KEY = "offline-rss-body-key";
  await getBoss();
  savedPolicy = await sql`SELECT value,updated_by,updated_at FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  await setRecentContentPolicy(true, "offline-test", "Keep the existing recent-content boundary");
  for (const id of sourceIds) await sql`INSERT INTO sources(id,name,kind,enabled,tier,participation_mode,first_party,site_fulltext,syndicate_fulltext,config)
    VALUES(${id},'Original RSS source','rss',true,'T2','editorial',false,false,false,
      ${sql.json({ feedUrl: 'http://feeds.example.com/original-source-feed', marker: 'unchanged-source-config' })})`;
});
afterEach(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${articleIds}::text[])`;
  await sql`DELETE FROM settings WHERE key=ANY(${batchIds.map(id => RECOVERY_BATCH_PREFIX + id)}::text[])`;
  await sql`DELETE FROM receipts WHERE subject=ANY(${articleIds.map(id => 'article:' + id)}::text[])`;
  await sql`DELETE FROM articles WHERE id=ANY(${articleIds}::text[])`;
  await sql`UPDATE sources SET enabled=true,participation_mode='editorial',config=
    ${sql.json({ feedUrl: 'http://feeds.example.com/original-source-feed', marker: 'unchanged-source-config' })}
    WHERE id=ANY(${sourceIds}::text[])`;
  articleIds.length = 0; batchIds.length = 0; feedReplies.clear(); invalidateRecentContentCache();
});
after(async () => {
  await sql`DELETE FROM sources WHERE id=ANY(${sourceIds}::text[])`;
  await sql`DELETE FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  for (const row of savedPolicy) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${RECENT_CONTENT_POLICY_KEY},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  await stopBoss(); await closeDb();
  config.egressProxyUrl = originalProxy; config.allowPrivateNetworkFetch = originalPrivate;
  for (const socket of sockets) socket.destroy();
  await Promise.all([proxy, jina].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function fixture(name: string, field: "content:encoded" | "description" = "content:encoded", state = "analyzed") {
  const url = `http://articles.example.com/${prefix}/${name}`;
  const title = `Offline exact article ${name}`;
  const result = await upsertMaterial({ sourceId: sourceIds[0]!, url, title, author: "Original collector attribution",
    publishedAt: new Date(Date.now() - 60 * 60_000), excerpt: "Original feed summary", bodyStatus: "unconfirmed", via: "fetch" });
  const id = result.articleId; articleIds.push(id);
  await sql`UPDATE articles SET processing_state=${state},processing_attempt_tag='existing-evaluation' WHERE id=${id}`;
  const feedUrl = `http://feeds.example.com/${prefix}/${name}.rss`, raw = articleHtml.repeat(5);
  const body = sanitizeFeedBody(raw, url);
  const proof = { bodySha256: hash(body.text), tailSha256: hash(body.text.slice(-200)), requiredTerms: ["Anthropic", "Claude", "trojan"] };
  const policy: RssBodyPolicy = { feedUrl, allowJina: false, ...(field === "description" ? { descriptionProof: proof } : { bodyProof: proof }) };
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Offline publisher</title><item><title>${title}</title><link>${url}</link><guid>${url}</guid><dc:creator>Different publisher byline</dc:creator><pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate><${field}><![CDATA[${raw}]]></${field}></item></channel></rss>`;
  feedReplies.set(new URL(feedUrl).pathname, { xml });
  return { id, url, title, feedUrl, body, policy };
}
async function plan(name: string, f: Awaited<ReturnType<typeof fixture>>, policy = f.policy) {
  const id = `${prefix}-${name}`; batchIds.push(id);
  return planRecoveryBatch({ id, kind: "web-body-recovery", articleIds: [f.id], evidence: "Exact reviewed offline feed body", rssBodies: { [f.id]: policy } });
}
async function activate(name: string, f: Awaited<ReturnType<typeof fixture>>) {
  const manifest = await plan(name, f);
  await applyRecoveryBatch(manifest, "offline-test", "Only this fixed reviewed body");
  return manifest;
}
const frozen = async (id: string) => (await sql`SELECT source_id,url,title,author,published_at,processing_attempt_tag FROM articles WHERE id=${id}`)[0]!;

test("planning freezes the exact RSS proof and refuses Jina opt-in, missing proof, nonpublic feeds or extra IDs", async () => {
  const f = await fixture("plan");
  const good = await plan("good-plan", f);
  assert.deepEqual(good.members[0]!.rssBody, f.policy);
  const changed = { ...good, members: [{ ...good.members[0]!, rssBody: { ...f.policy, allowJina: true } }] };
  assert.throws(() => parseRecoveryPlan(changed));
  await assert.rejects(plan("missing-proof", f, { feedUrl: f.feedUrl, allowJina: false }), /verified exact body proof/);
  for (const [index, feedUrl] of ["http://127.0.0.1/feed", "http://localhost/feed", "http://10.0.0.1/feed",
    "https://user:password@example.com/feed", "https://feeds.example.com/feed?api_key=private", "https://x.com/feed"].entries()) {
    await assert.rejects(plan(`nonpublic-${index}`, f, { ...f.policy, feedUrl }), /public feed/);
  }
  await assert.rejects(planRecoveryBatch({ id: `${prefix}-extra-id`, kind: "web-body-recovery", articleIds: [f.id],
    evidence: "No extra membership", rssBodies: { unapproved: f.policy } }), /outside fixed/);
});

test("RSS strategies remain limited to at most three fixed web members", async () => {
  const four = await Promise.all([0, 1, 2, 3].map(i => fixture(`limit-${i}`)));
  await assert.rejects(planRecoveryBatch({ id: `${prefix}-four`, kind: "web-body-recovery", articleIds: four.map(f => f.id),
    evidence: "No widening", rssBodies: Object.fromEntries(four.map(f => [f.id, f.policy])) }), /at most three/);
  await sql`UPDATE articles SET processing_state='failed' WHERE id=${four[0]!.id}`;
  await assert.rejects(planRecoveryBatch({ id: `${prefix}-wrong-kind`, kind: "model-failure", articleIds: [four[0]!.id],
    evidence: "No RSS policy on old kinds", rssBodies: { [four[0]!.id]: four[0]!.policy } }), /fixed web members/);
});

test("source, config, revision and URL drift remove the RSS strategy without changing another source", async () => {
  const f = await fixture("drift"); await activate("drift-batch", f);
  assert.equal((await getRecoveryRssBodyPolicy(f.id)).strategy?.feedUrl, f.feedUrl);
  await sql`UPDATE articles SET source_id=${sourceIds[1]!} WHERE id=${f.id}`;
  assert.equal((await getRecoveryRssBodyPolicy(f.id)).strategy, null);
  await sql`UPDATE articles SET source_id=${sourceIds[0]!} WHERE id=${f.id}`;
  await sql`UPDATE sources SET config='{"changed":true}'::jsonb WHERE id=${sourceIds[0]!}`;
  assert.equal((await getRecoveryRssBodyPolicy(f.id)).strategy, null);
  await sql`UPDATE sources SET config=${sql.json({ feedUrl: 'http://feeds.example.com/original-source-feed', marker: 'unchanged-source-config' })} WHERE id=${sourceIds[0]!}`;
  await sql`UPDATE articles SET revision=2 WHERE id=${f.id}`;
  assert.equal((await getRecoveryRssBodyPolicy(f.id)).strategy, null);
  await sql`UPDATE articles SET revision=1,url=${f.url + '-different'} WHERE id=${f.id}`;
  assert.deepEqual(await getRecoveryRssBodyPolicy(f.id), { denyJina: false, strategy: null });
  await sql`UPDATE articles SET url=${f.url} WHERE id=${f.id}`;
  assert.equal((await getRecoveryRssBodyPolicy(f.id)).strategy?.feedUrl, f.feedUrl);
});

for (const state of ["revoked", "complete"] as const) test(`a ${state} policy remains deny-Jina only, grants no scope and cannot revive`, async () => {
  const f = await fixture(state); const manifest = await activate(`${state}-batch`, f);
  await stopRecoveryBatch(manifest.id, state, "offline-test", "End this finite body recovery");
  assert.deepEqual(await getRecoveryRssBodyPolicy(f.id), { denyJina: true, strategy: null });
  assert.equal(await getRecoveryAdmission(f.id), null);
  await assert.rejects(applyRecoveryBatch(manifest, "offline-test", "No revival"), /cannot be reactivated/);
  await sql`UPDATE articles SET published_at=now()-interval '49 hours' WHERE id=${f.id}`;
  assert.equal((await getRecentContentPriority(f.id)).allowed, false);
  const beforeJina = jinaHits, beforeFeed = feedHits;
  assert.equal(await extractArticleBody(f.id, true), "unconfirmed");
  assert.equal(feedHits, beforeFeed); assert.equal(jinaHits, beforeJina);
});

for (const field of ["content:encoded", "description"] as const) test(`official ${field} extraction creates one revision while preserving identity, permissions and paid identity`, async () => {
  const f = await fixture(`extract-${field.replace(':', '-')}`, field); const manifest = await activate(`extract-${field.replace(':', '-')}-batch`, f);
  const before = await frozen(f.id), source = await sql`SELECT * FROM sources WHERE id=${sourceIds[0]!}`;
  const beforeJina = jinaHits, beforeFeed = feedHits, beforeArticle = articleHits;
  assert.equal(await extractArticleBody(f.id, true), "ok");
  assert.deepEqual(await frozen(f.id), before);
  assert.deepEqual(await sql`SELECT * FROM sources WHERE id=${sourceIds[0]!}`, source);
  const [saved] = await sql`SELECT revision,body_status,body_text,processing_state FROM articles WHERE id=${f.id}`;
  assert.equal(saved.revision, 2); assert.equal(saved.body_status, "ok"); assert.equal(saved.body_text, f.body.text);
  assert.equal(saved.processing_state, "new");
  assert.equal((await getRecoveryBatch(manifest.id))!.currentRevisions[f.id], 2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM article_revisions WHERE article_id=${f.id}`)[0]!.n, 2);
  const audits = await sql`SELECT after FROM audit_log WHERE action='content.body-restored' AND subject=${'content:' + f.id}`;
  assert.equal(audits.length, 1); assert.equal(audits[0]!.after.via, "rss"); assert.equal(audits[0]!.after.allowJina, false);
  assert.equal(audits[0]!.after.bodySha256, hash(f.body.text));
  assert.equal(await extractArticleBody(f.id, true), "skipped");
  assert.equal(feedHits, beforeFeed + 1); assert.equal(jinaHits, beforeJina);
  assert.equal(articleHits, beforeArticle, "the verified RSS body is tried before the original page");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE service='jina' AND subject=${'article:' + f.id}`)[0]!.n, 0);
  assert.equal((await recoveryBatchStatus(manifest.id))!.completeable, false, "the new body still requires ordinary analysis");
});

for (const mismatch of ["body", "tail", "topic"] as const) test(`a ${mismatch} proof mismatch leaves the original body unconfirmed without buying Jina`, async () => {
  const f = await fixture(`proof-${mismatch}`), proof = f.policy.bodyProof!;
  const policy: RssBodyPolicy = { ...f.policy, bodyProof: { ...proof,
    ...(mismatch === "body" ? { bodySha256: "0".repeat(64) } : {}),
    ...(mismatch === "tail" ? { tailSha256: "0".repeat(64) } : {}),
    ...(mismatch === "topic" ? { requiredTerms: ["missing-reviewed-topic"] } : {}) } };
  const manifest = await plan(`proof-${mismatch}-batch`, f, policy);
  await applyRecoveryBatch(manifest, "offline-test", "A proof still has to match the actual feed response");
  const before = await frozen(f.id), beforeJina = jinaHits;
  assert.equal(await extractArticleBody(f.id, true), "unconfirmed");
  assert.deepEqual(await frozen(f.id), before);
  const [saved] = await sql`SELECT revision,body_text,body_status FROM articles WHERE id=${f.id}`;
  assert.equal(saved.revision, 1); assert.equal(saved.body_text, null); assert.equal(saved.body_status, "unconfirmed");
  assert.equal(jinaHits, beforeJina);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE service='jina' AND subject=${'article:' + f.id}`)[0]!.n, 0);
});

for (const change of ["config", "revision", "url", "revoke"] as const) test(`a ${change} change while the feed is in flight prevents a stale body write`, async () => {
  const f = await fixture(`race-${change}`); const manifest = await activate(`race-${change}-batch`, f);
  const held = { entered: gate<void>(), release: gate<void>() };
  feedReplies.get(new URL(f.feedUrl).pathname)!.hold = held;
  const pending = extractArticleBody(f.id, true);
  const deadline = setTimeout(() => held.entered.open(), 5000);
  await held.entered.promise; clearTimeout(deadline);
  try {
    if (change === "config") await sql`UPDATE sources SET config='{"changed":true}'::jsonb WHERE id=${sourceIds[0]!}`;
    if (change === "revision") await sql`UPDATE articles SET revision=2 WHERE id=${f.id}`;
    if (change === "url") await sql`UPDATE articles SET url=${f.url + '-new'} WHERE id=${f.id}`;
    if (change === "revoke") await stopRecoveryBatch(manifest.id, "revoked", "offline-test", "Revoke before persistence");
  } finally { held.release.open(); }
  assert.equal(await pending, "skipped");
  const [saved] = await sql`SELECT revision,body_text,body_status FROM articles WHERE id=${f.id}`;
  assert.equal(saved.body_text, null); assert.equal(saved.body_status, "unconfirmed");
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='content.body-restored' AND subject=${'content:' + f.id}`)[0]!.n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE service='jina' AND subject=${'article:' + f.id}`)[0]!.n, 0);
});

test("a manifest without rssBody retains its legacy digest and grants no RSS or deny-Jina policy", async () => {
  const f = await fixture("legacy", "content:encoded", "failed"), id = `${prefix}-legacy-plan`; batchIds.push(id);
  const manifest: RecoveryPlan = await planRecoveryBatch({ id, kind: "model-failure", articleIds: [f.id], evidence: "Original legacy recovery" });
  const legacyDigest = hash(JSON.stringify({ id: manifest.id, kind: manifest.kind, evidence: manifest.evidence,
    members: [...manifest.members].sort((a,b) => a.articleId.localeCompare(b.articleId)) }));
  assert.equal(manifest.digest, legacyDigest); assert.equal(Object.hasOwn(manifest.members[0]!, "rssBody"), false);
  await applyRecoveryBatch(manifest, "offline-test", "Original no-RSS manifest");
  assert.deepEqual(await getRecoveryRssBodyPolicy(f.id), { denyJina: false, strategy: null });
  assert.equal(Object.hasOwn((await recoveryBatchStatus(id))!.members[0]!, "rssBody"), false);
});
