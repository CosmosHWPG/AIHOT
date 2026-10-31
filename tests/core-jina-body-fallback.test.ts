// Paid body answers settle with the material decision. Capacity waits and failed persistence
// must retain pending/reusable evidence rather than buy another answer or confirm an empty body.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody, extractFromUrl } from "@aihot/backend/content/extract";
import { contentHash, upsertMaterial } from "@aihot/backend/content/materials";
import { markdownBody } from "@aihot/backend/content/markdown";
import { stripTags } from "@aihot/backend/lib/text";
import { queueProcessing, registerExtractionJobs } from "@aihot/backend/jobs/content";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { completeReceipt, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { jinaRead } from "@aihot/backend/providers/jina";

const sourceId = `jina-body-${tag()}`;
const markdown = "# Original article\n\n" + "The publisher provides substantive article text for the authenticated rendering response. ".repeat(12);
let reply = markdown;
let warning = "";
let readerTitle = "Original article";
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
  const metadataWarning = warning;
  const title = readerTitle;
  const waiting = hold;
  if (waiting) { waiting.entered.open(); await waiting.release.promise; }
  if (drop) { req.socket.destroy(); return; }
  res.writeHead(200, { "content-type": "text/plain", "x-usage-tokens": "12" });
  res.end(`Title: ${title}\nURL Source: ${req.url?.slice(1)}\n${metadataWarning}\nMarkdown Content:\n${answer}`);
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

function reset(answer = markdown) { reply = answer; warning = ""; readerTitle = "Original article"; drop = false; hold = null; }
async function material(extra: { url?: string; bodyText?: string; bodyHtml?: string; bodyStatus?: "pending"; excerpt?: string } = {}) {
  const input = { sourceId, url: `${base}/${tag()}`, title: "Original article", publishedAt: new Date(), via: "fetch" as const, ...extra };
  const { articleId } = await upsertMaterial(input);
  return { articleId, input };
}
async function withStubbedPublicPage<T>(url: string, work: () => Promise<T>): Promise<T> {
  const previous = getGlobalDispatcher(), previousProxy = config.egressProxyUrl;
  const mock = new MockAgent(); mock.disableNetConnect(); mock.enableNetConnect(/^127\.0\.0\.1:/);
  const target = new URL(url);
  mock.get(target.origin).intercept({ path: target.pathname + target.search }).reply(200,
    "<html><body><div id='app'></div></body></html>", { headers: { "content-type": "text/html" } }).persist();
  config.egressProxyUrl = null;
  setGlobalDispatcher(mock);
  try { return await work(); }
  finally { setGlobalDispatcher(previous); config.egressProxyUrl = previousProxy; await mock.close(); }
}
const state = async (id: string) => ({ ...(await sql`SELECT title,excerpt,body_text,body_html,body_status,revision,content_hash,
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

const deniedMarkdown = "# Request blocked\n\n" + "The requested resource is unavailable. This response explains the access restriction rather than the publisher's article. ".repeat(6);
const verificationMarkdown = "# Performing security verification\n\n" + "The security check is still in progress. Please wait for the verification service to finish checking this connection. ".repeat(5);
const redditVerificationMarkdown = "# Prove your humanity\n\nTo continue, complete the challenge below.\n\n" + "This security check is still in progress. Please wait for the challenge service to finish before proceeding. ".repeat(3);
const youtubeConsentMarkdown = "# Before you continue to YouTube\n\nWe use cookies to provide this service.\n\nAccept all\n\nReject all\n\n" + "You can review your privacy preferences and choose how cookies are used before continuing. ".repeat(5);
for (const status of [403, 503]) test(`an outer-200 Reader target HTTP ${status} warning cannot confirm an error page as the body`, async () => {
  reset(deniedMarkdown);
  warning = `Warning: Target URL returned error ${status}: target unavailable`;
  const { articleId, input } = await material();
  const beforeHits = hits;
  const result = await extractFromUrl(input.url, { allowJina: true, subject: `article:${articleId}` });
  assert.equal(result.body, null);
  assert.equal(result.reason, `Jina Reader explicitly reported target HTTP ${status}`);
  assert.equal(result.rejectedText, stripTags(markdownBody(deniedMarkdown, input.url)));
  assert.ok(result.rejectedText!.length > 200);
  assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
  const saved = await state(articleId);
  assert.equal(saved.body_status, "unconfirmed");
  assert.equal(saved.body_text, null);
  assert.equal(saved.revision, 1);
  assert.equal(hits, beforeHits + 1);
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
});

test("a genuine article about CAPTCHA and quoted HTTP warnings is still accepted", async () => {
  reset("# Research on CAPTCHA systems\n\nThe researchers explain the phrase performing security verification in login interfaces.\n\n" + markdown + "\n\nThe paper studies CAPTCHA verification and login accessibility.\n\nWarning: Target URL returned error 403 is an example quoted by the article.\n");
  const { articleId } = await material();
  assert.equal(await extractArticleBody(articleId, true), "ok");
  const saved = await state(articleId);
  assert.equal(saved.body_status, "ok");
  assert.ok(saved.body_text.includes("CAPTCHA"));
  assert.equal(saved.revision, 2);
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
});

test("an exact verification title plus a strong verification instruction is not an article body", async () => {
  reset(verificationMarkdown);
  readerTitle = "Just a moment...";
  warning = "Warning: This page requires CAPTCHA verification.";
  const { articleId, input } = await material();
  const result = await extractFromUrl(input.url, { allowJina: true, subject: `article:${articleId}` });
  assert.equal(result.body, null);
  assert.equal(result.reason, "Jina Reader returned a security verification interstitial");
  assert.equal(result.rejectedText, stripTags(markdownBody(verificationMarkdown, input.url)));
  assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
  assert.equal((await state(articleId)).body_text, null);
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
});

test("the verification title alone does not reject substantive text without verification instructions", async () => {
  reset(); readerTitle = "Just a moment...";
  const { articleId } = await material();
  assert.equal(await extractArticleBody(articleId, true), "ok");
  assert.equal((await state(articleId)).body_status, "ok");
});

test("the exact Reddit verification title and both challenge instructions reject an outer-200 body", async () => {
  reset(redditVerificationMarkdown);
  readerTitle = "Reddit - Prove your humanity";
  warning = "Warning: This page requires CAPTCHA verification.";
  const { articleId, input } = await material();
  const beforeHits = hits;
  const result = await extractFromUrl(input.url, { allowJina: true, subject: `article:${articleId}` });
  assert.equal(result.body, null);
  assert.equal(result.reason, "Jina Reader returned a security verification interstitial");
  assert.equal(result.rejectedText, stripTags(markdownBody(redditVerificationMarkdown, input.url)));
  assert.ok(result.rejectedText!.length > 200);
  assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
  assert.equal((await state(articleId)).body_text, null);
  assert.equal(hits, beforeHits + 1);
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
});

test("a real release article discussing both Reddit challenge phrases is still accepted", async () => {
  reset("# Koboldcpp released\n\nThe release notes discuss CAPTCHA prompts containing the phrases prove your humanity and complete the challenge.\n\n" + markdown);
  readerTitle = "Koboldcpp released";
  warning = "Warning: This page requires CAPTCHA verification.";
  const { articleId } = await material();
  assert.equal(await extractArticleBody(articleId, true), "ok");
  assert.equal((await state(articleId)).body_status, "ok");
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
});

for (const instruction of ["", "Prove your humanity.", "Complete the challenge."]) test(`the exact Reddit title without both challenge instructions is accepted: ${instruction || 'neither'}`, async () => {
  reset(instruction + "\n\n" + markdown);
  readerTitle = "Reddit - Prove your humanity";
  warning = "Warning: This page requires CAPTCHA verification.";
  const { articleId } = await material();
  assert.equal(await extractArticleBody(articleId, true), "ok");
  assert.equal((await state(articleId)).body_status, "ok");
});

for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]) test(`an exact YouTube consent title and cookies with both buttons reject ${host}'s interstitial`, async () => {
  reset(youtubeConsentMarkdown); readerTitle = "Before you continue to YouTube";
  const url = `https://${host}/watch?v=${tag()}`;
  await withStubbedPublicPage(url, async () => {
    const { articleId } = await material({ url });
    const beforeHits = hits;
    const result = await extractFromUrl(url, { allowJina: true, subject: `article:${articleId}` });
    assert.equal(result.body, null);
    assert.equal(result.reason, "Jina Reader returned a YouTube cookie consent interstitial");
    assert.equal(result.rejectedText, stripTags(markdownBody(youtubeConsentMarkdown, url)));
    assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
    assert.equal((await state(articleId)).body_text, null);
    assert.equal(hits, beforeHits + 1);
    assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
  });
});

test("a real YouTube video description discussing cookie choices keeps its normal title and body", async () => {
  reset("# Mobile app updates\n\nThe video discusses cookies and the Accept all and Reject all buttons.\n\n" + markdown);
  readerTitle = "Claude's new mobile app updates are here";
  const url = `https://www.youtube.com/shorts/${tag()}`;
  await withStubbedPublicPage(url, async () => {
    const { articleId } = await material({ url });
    assert.equal(await extractArticleBody(articleId, true), "ok");
    assert.equal((await state(articleId)).body_status, "ok");
  });
});

for (const instructions of ["cookies and Accept all", "cookies and Reject all", "Accept all and Reject all"]) test(`the exact YouTube title without all consent markers is accepted: ${instructions}`, async () => {
  reset(instructions + "\n\n" + markdown); readerTitle = "Before you continue to YouTube";
  const url = `https://www.youtube.com/shorts/${tag()}`;
  await withStubbedPublicPage(url, async () => {
    const { articleId } = await material({ url });
    assert.equal(await extractArticleBody(articleId, true), "ok");
    assert.equal((await state(articleId)).body_status, "ok");
  });
});

test("a different site discussing the exact YouTube consent page is not rejected by a hostname substring", async () => {
  reset(youtubeConsentMarkdown + "\n\n" + markdown); readerTitle = "Before you continue to YouTube";
  const url = `https://youtube.com.example.invalid/${tag()}`;
  await withStubbedPublicPage(url, async () => {
    const { articleId } = await material({ url });
    assert.equal(await extractArticleBody(articleId, true), "ok");
    assert.equal((await state(articleId)).body_status, "ok");
  });
});

test("YouTube consent markers quoted beyond the bounded beginning do not reject substantive content", async () => {
  reset(markdown.repeat(6) + "\n\n" + youtubeConsentMarkdown); readerTitle = "Before you continue to YouTube";
  const url = `https://www.youtube.com/watch?v=${tag()}`;
  await withStubbedPublicPage(url, async () => {
    const { articleId } = await material({ url });
    assert.equal(await extractArticleBody(articleId, true), "ok");
    assert.equal((await state(articleId)).body_status, "ok");
  });
});

test("a previously completed identical YouTube consent answer is removed once without purchasing a new answer", async () => {
  reset(youtubeConsentMarkdown); readerTitle = "Before you continue to YouTube";
  const url = `https://www.youtube.com/shorts/${tag()}`;
  await withStubbedPublicPage(url, async () => {
    const { articleId, input } = await material({ url, excerpt: "The publisher's original video summary remains available." });
    const badHtml = markdownBody(youtubeConsentMarkdown, url), badText = stripTags(badHtml);
    await upsertMaterial({ ...input, bodyText: badText, bodyHtml: badHtml, bodyStatus: "pending" });
    assert.equal((await state(articleId)).revision, 2);
    const beforeHits = hits;
    const cached = await jinaRead(url, { purpose: "body_fallback", subject: `article:${articleId}` });
    await completeReceipt(sql, cached.receiptId);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
      const saved = await state(articleId);
      assert.equal(saved.body_text, null);
      assert.equal(saved.body_html, null);
      assert.equal(saved.body_status, "unconfirmed");
      assert.equal(saved.excerpt, input.excerpt);
      assert.equal(saved.revision, 3);
    }
    const history = await sql`SELECT revision,body_text FROM article_revisions WHERE article_id=${articleId} ORDER BY revision`;
    assert.deepEqual(history.map(r => [r.revision, r.body_text]), [[1, null], [2, badText], [3, null]]);
    const corrections = await sql`SELECT reason,before,after FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.body-rejected'`;
    assert.equal(corrections.length, 1);
    assert.equal(corrections[0]!.after.receiptId, cached.receiptId);
    assert.equal(JSON.stringify(corrections).includes(badText), false);
    assert.equal(hits, beforeHits + 1);
    assert.deepEqual((await receipts(articleId)).map(r => [r.id, r.status, r.attempts]), [[cached.receiptId, "completed", 1]]);
  });
});

for (const kind of ["target-error", "verification", "reddit-verification"] as const) test(`a previously stored identical Reader ${kind} page is removed in one audited revision using its existing receipt`, async () => {
  const rejectedMarkdown = kind === "reddit-verification" ? redditVerificationMarkdown : kind === "verification" ? verificationMarkdown : deniedMarkdown;
  reset(rejectedMarkdown);
  warning = kind === "target-error" ? "Warning: Target URL returned error 403: Forbidden" : "Warning: This page requires CAPTCHA verification.";
  if (kind === "verification") readerTitle = "Just a moment...";
  if (kind === "reddit-verification") readerTitle = "Reddit - Prove your humanity";
  const { articleId, input } = await material({ excerpt: "The original publisher feed summary remains available." });
  const badHtml = markdownBody(rejectedMarkdown, input.url);
  const badText = stripTags(badHtml);
  // Reproduce old extraction's persisted body; the official extraction retry starts it as pending.
  await upsertMaterial({ ...input, bodyText: badText, bodyHtml: badHtml, bodyStatus: "pending" });
  assert.equal((await state(articleId)).revision, 2);
  const beforeHits = hits;
  const cached = await jinaRead(input.url, { purpose: "body_fallback", subject: `article:${articleId}` });
  await completeReceipt(sql, cached.receiptId); // The legacy request was already paid and settled.
  assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
  const saved = await state(articleId);
  assert.equal(saved.body_text, null);
  assert.equal(saved.body_html, null);
  assert.equal(saved.excerpt, input.excerpt);
  assert.equal(saved.body_status, "unconfirmed");
  assert.equal(saved.processing_state, "new");
  assert.equal(saved.revision, 3);
  assert.equal(saved.content_hash, contentHash({ title: input.title, bodyText: null, excerpt: input.excerpt }));
  const history = await sql`SELECT revision,body_text FROM article_revisions WHERE article_id=${articleId} ORDER BY revision`;
  assert.deepEqual(history.map(r => [r.revision, r.body_text]), [[1, null], [2, badText], [3, null]]);
  const corrections = await sql`SELECT reason,before,after FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.body-rejected'`;
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0]!.before.revision, 2);
  assert.equal(corrections[0]!.after.revision, 3);
  assert.equal(corrections[0]!.after.receiptId, cached.receiptId);
  assert.equal(JSON.stringify(corrections).includes(badText), false, "the audit stores safe metadata, not the rejected page");
  assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
  assert.equal((await state(articleId)).revision, 3, "replaying the rejected answer cannot make repeated cleanup revisions");
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.body-rejected'`).length, 1);
  assert.equal(hits, beforeHits + 1, "cleanup reuses the same settled answer without another paid call");
  assert.deepEqual((await receipts(articleId)).map(r => [r.id, r.status, r.attempts]), [[cached.receiptId, "completed", 1]]);
});

test("rejecting a Reader error page preserves a different valid partial body and feed summary", async () => {
  reset(deniedMarkdown);
  warning = "Warning: Target URL returned error 403: Forbidden";
  const partial = "A publisher-provided partial article about network architecture, not an access error.";
  const partialHtml = `<p>${partial}</p>`;
  const { articleId } = await material({ bodyText: partial, bodyHtml: partialHtml, bodyStatus: "pending", excerpt: "Original feed summary" });
  const before = await state(articleId);
  assert.equal(await extractArticleBody(articleId, true), "unconfirmed");
  const saved = await state(articleId);
  assert.equal(saved.body_text, partial);
  assert.equal(saved.body_html, partialHtml);
  assert.equal(saved.excerpt, before.excerpt);
  assert.equal(saved.content_hash, before.content_hash);
  assert.equal(saved.revision, before.revision);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.body-rejected'`).length, 0);
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
});

test("an obsolete rejected Reader answer cannot clear or downgrade a newer publisher body", async () => {
  reset(deniedMarkdown);
  warning = "Warning: Target URL returned error 403: Forbidden";
  hold = { entered: gate(), release: gate() };
  const held = hold;
  const { articleId, input } = await material();
  const badHtml = markdownBody(deniedMarkdown, input.url);
  await upsertMaterial({ ...input, bodyText: stripTags(badHtml), bodyHtml: badHtml, bodyStatus: "pending" });
  const pending = extractArticleBody(articleId, true);
  await held.entered.promise;
  let expected;
  try {
    await upsertMaterial({ ...input, title: "Corrected publisher article", bodyText: "A newer legitimate publisher body.", bodyHtml: "<p>A newer legitimate publisher body.</p>" });
    expected = await state(articleId);
  } finally { held.release.open(); }
  assert.equal(await pending, "skipped");
  assert.deepEqual(await state(articleId), expected);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.body-rejected'`).length, 0);
  assert.deepEqual((await receipts(articleId)).map(r => [r.status, r.attempts]), [["completed", 1]]);
});
