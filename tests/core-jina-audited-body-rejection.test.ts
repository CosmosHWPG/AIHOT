// Human evidence can reject one exact Reader answer without blacklisting a source or its next body.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { audit } from "@aihot/backend/audit";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { markdownBody } from "@aihot/backend/content/markdown";
import { sha256 } from "@aihot/backend/lib/ids";
import { stripTags } from "@aihot/backend/lib/text";
import { completeReceipt } from "@aihot/backend/providers/receipts";
import { jinaRead } from "@aihot/backend/providers/jina";

const sourceId = `jina-audited-${tag()}`;
const ids: string[] = [];
const profileMarkdown = "# Publisher account profile\n\n" + "This is an account biography and profile navigation, rather than the linked status report. ".repeat(6);
let reply = profileMarkdown;
let warning = "";
let hits = 0;
let hold: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const originalPrivate = config.allowPrivateNetworkFetch;
const page = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body><div id='app'></div></body></html>");
});
const jina = http.createServer(async (req, res) => {
  hits += 1;
  const answer = reply;
  const waiting = hold;
  if (waiting) { waiting.entered.open(); await waiting.release.promise; }
  res.writeHead(200, { "content-type": "text/plain", "x-usage-tokens": "12" });
  res.end(`Title: Publisher account profile\nURL Source: ${req.url?.slice(1)}\n${warning}\nMarkdown Content:\n${answer}`);
});
await Promise.all([page, jina].map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
const base = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
process.env.JINA_BASE_URL = `http://127.0.0.1:${(jina.address() as { port: number }).port}`;
process.env.JINA_API_KEY = "test-jina-audited-body-key";
config.allowPrivateNetworkFetch = true;

let savedBudget: { enabled: boolean; per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  [savedBudget] = await sql`SELECT enabled,per_minute,per_hour,per_day FROM budgets WHERE service='jina'`;
  assert.ok(savedBudget);
  await sql`UPDATE budgets SET enabled=true,per_minute=1000000,per_hour=1000000,per_day=1000000 WHERE service='jina'`;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${sourceId},'Offline audited body fixture','rss',${sql.json({ fetchPublicContent: true })})`;
});
after(async () => {
  hold?.release.open();
  await Promise.all([page, jina].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  await sql`DELETE FROM articles WHERE source_id=${sourceId}`;
  await sql`DELETE FROM sources WHERE id=${sourceId}`;
  await sql`DELETE FROM receipts WHERE service='jina' AND subject=ANY(${ids.map(id => 'article:' + id)}::text[])`;
  await sql`DELETE FROM audit_log WHERE subject=ANY(${ids.map(id => 'content:' + id)}::text[])`;
  if (savedBudget) await sql`UPDATE budgets SET enabled=${savedBudget.enabled},per_minute=${savedBudget.per_minute},
    per_hour=${savedBudget.per_hour},per_day=${savedBudget.per_day} WHERE service='jina'`;
  config.allowPrivateNetworkFetch = originalPrivate;
  await closeDb();
});
function reset(answer = profileMarkdown) { reply = answer; warning = ""; hold = null; }
async function material() {
  const input = { sourceId, url: `${base}/${tag()}`, title: "Original status about a code editor extension",
    excerpt: "The publisher's original partial status remains evidence.", publishedAt: new Date(), via: "fetch" as const };
  const { articleId } = await upsertMaterial(input);
  ids.push(articleId);
  return { articleId, input };
}
function cleaned(markdown: string, url: string) { return stripTags(markdownBody(markdown, url)); }
async function authorize(articleId: string, url: string, text: string, receiptId: number, action = "content.body-rejection-authorized") {
  const [before] = await sql`SELECT revision FROM articles WHERE id=${articleId}`;
  await audit("offline-reviewer", action, `content:${articleId}`, "Verified profile text does not match this article's status",
    { revision: before?.revision, bodySha256: sha256(text) },
    { url, bodySha256: sha256(text), receiptId, evidence: "Exact offline answer and original status compared" });
}
const state = async (id: string) => (await sql`SELECT revision,body_status,body_text,body_html,excerpt FROM articles WHERE id=${id}`)[0]!;
const receipts = (id: string) => sql`SELECT id,status,attempts FROM receipts WHERE service='jina' AND subject=${'article:' + id}`;

test("an audited exact bad answer clears the old body once and reuses its completed receipt", async () => {
  reset();
  const { articleId, input } = await material();
  const badText = cleaned(profileMarkdown, input.url);
  await upsertMaterial({ ...input, bodyText: badText, bodyHtml: markdownBody(profileMarkdown, input.url), bodyStatus: "pending" });
  assert.equal((await state(articleId)).revision, 2);
  const beforeHits = hits;
  const old = await jinaRead(input.url, { purpose: "body_fallback", subject: `article:${articleId}` });
  await completeReceipt(sql, old.receiptId);
  await authorize(articleId, input.url, badText, old.receiptId);
  assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
  const saved = await state(articleId);
  assert.equal(saved.revision, 3);
  assert.equal(saved.body_status, "unconfirmed");
  assert.equal(saved.body_text, null);
  assert.equal(saved.body_html, null);
  assert.equal(saved.excerpt, input.excerpt);
  const history = await sql`SELECT revision,body_text FROM article_revisions WHERE article_id=${articleId} ORDER BY revision`;
  assert.deepEqual(history.map(r => [r.revision, r.body_text]), [[1, null], [2, badText], [3, null]]);
  assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
  assert.equal((await state(articleId)).revision, 3);
  assert.equal((await sql`SELECT id FROM audit_log WHERE subject=${'content:' + articleId} AND action='content.body-rejected'`).length, 1);
  assert.deepEqual((await receipts(articleId)).map(r => [r.id,r.status,r.attempts]), [[old.receiptId,"completed",1]]);
  assert.equal(hits, beforeHits + 1);
});

for (const mismatch of ["hash", "url", "article", "action"] as const) test(`an audited rejection with a different ${mismatch} cannot reject this body`, async () => {
  reset();
  const { articleId, input } = await material();
  const badText = cleaned(profileMarkdown, input.url);
  const old = await jinaRead(input.url, { purpose: "body_fallback", subject: `article:${articleId}` });
  const other = mismatch === "article" ? await material() : null;
  await authorize(other?.articleId ?? articleId, mismatch === "url" ? input.url + "/different" : input.url,
    mismatch === "hash" ? "A different previously reviewed answer" : badText, old.receiptId,
    mismatch === "action" ? "content.unrelated-review" : "content.body-rejection-authorized");
  assert.equal(await extractArticleBody(articleId, true), "ok");
  assert.equal((await state(articleId)).body_text, badText);
  assert.equal((await state(articleId)).body_status, "ok");
  assert.deepEqual((await receipts(articleId)).map(r => [r.id,r.status,r.attempts]), [[old.receiptId,"completed",1]]);
  assert.equal((await sql`SELECT id FROM audit_log WHERE subject=${'content:' + articleId} AND action='content.body-rejected'`).length, 0);
});

test("a later different legitimate Reader body is accepted despite the prior exact rejection", async () => {
  reset("# Original status report\n\n" + "This status describes a code editor extension release, its measurements and availability. ".repeat(7));
  const { articleId, input } = await material();
  const old = await jinaRead(input.url, { purpose: "body_fallback", subject: `article:${articleId}` });
  await authorize(articleId, input.url, cleaned(profileMarkdown, input.url), old.receiptId);
  assert.equal(await extractArticleBody(articleId, true), "ok");
  assert.equal((await state(articleId)).body_text, cleaned(reply, input.url));
});

test("an audited answer cannot clear a body after the URL changes during retrieval", async () => {
  reset();
  const { articleId, input } = await material();
  const badText = cleaned(profileMarkdown, input.url);
  await upsertMaterial({ ...input, bodyText: badText, bodyHtml: markdownBody(profileMarkdown, input.url), bodyStatus: "pending" });
  hold = { entered: gate(), release: gate() };
  const held = hold;
  const pending = extractArticleBody(articleId, true);
  await held.entered.promise;
  let expected;
  try {
    await authorize(articleId, input.url, badText, (await receipts(articleId))[0].id);
    await sql`UPDATE articles SET url=${input.url + '/new-url'} WHERE id=${articleId}`;
    expected = await state(articleId);
  } finally { held.release.open(); }
  assert.equal(await pending, "skipped");
  assert.deepEqual(await state(articleId), expected);
  assert.equal((await receipts(articleId))[0].status, "completed");
});

test("the existing Reader target-error guard still rejects without an audited authorization", async () => {
  reset(); warning = "Warning: Target URL returned error 403: Forbidden";
  const { articleId } = await material();
  assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
  assert.equal((await state(articleId)).body_text, null);
  assert.equal((await receipts(articleId))[0].status, "completed");
});
