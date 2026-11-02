// Metadata-only body failures must not purchase answers, rewrite receipts or revive old evidence.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { sha256 } from "@aihot/backend/lib/ids";
import { stripTags } from "@aihot/backend/lib/text";
import { markdownBody } from "@aihot/backend/content/markdown";
import { parseJinaText } from "@aihot/backend/providers/jina";
import { completeReceipt, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { classifyJinaBodyFailure, getBodyFailure, recordBodyFailure, resolveBodyFailure } from "@aihot/backend/content/body-failure-cache";

const prefix = `body-failure-${tag()}`;
const source = `${prefix}-rss`;
const ids: string[] = [], receipts: number[] = [];
const longBody = '# Actual article\n\n' + 'This verified report describes the architecture, its measurements and public release details. '.repeat(8);
const bodyText = (raw: string,url: string) => stripTags(markdownBody(parseJinaText(raw).markdown,url));
const raw = (url: string,body = 'Short incomplete rendering.',title = 'Article',warning = '') =>
  `Title: ${title}\nURL Source: ${url}\n${warning}\nMarkdown Content:\n${body}`;
before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${source},'Body failure cache fixture','rss','T1','editorial','2100-01-01')`;
});
afterEach(async () => {
  await sql`DELETE FROM articles WHERE source_id=${source}`;
  await sql`DELETE FROM receipts WHERE id=ANY(${receipts}::bigint[])`;
  await sql`DELETE FROM audit_log WHERE subject=ANY(${ids.map(id => 'content:' + id)}::text[])`;
  ids.length = 0; receipts.length = 0;
});
after(async () => { await sql`DELETE FROM sources WHERE id=${source}`; await closeDb(); });
async function article(name: string) {
  const id = `${prefix}-${name}`; ids.push(id); const url = 'https://www.example.com/' + id;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,body_status,processing_state)
    VALUES(${id},${source},${id},${url},'Cache fixture',now(),now(),now(),'pending','new')`;
  return { id,url };
}
async function saved(a: { id: string; url: string },text: string,status = 'completed',options: { purpose?: string; subject?: string; url?: string; outerStatus?: number; age?: number } = {}) {
  const [r] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,attempts,request,response,created_at,received_at,completed_at)
    VALUES(${prefix + '-receipt-' + receipts.length},'jina',${options.purpose ?? 'body_fallback'},${options.subject ?? 'article:' + a.id},${status},1,
      ${sql.json({ url: options.url ?? a.url })},${['completed','received'].includes(status) ? sql.json({ text,status: options.outerStatus ?? 200 }) : null},
      clock_timestamp()-${options.age ?? 0}*interval '1 second',
      ${['completed','received'].includes(status) ? sql`clock_timestamp()` : null},${status === 'completed' ? sql`clock_timestamp()` : null}) RETURNING id`;
  receipts.push(r.id);
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,started_at,finished_at)
    VALUES(${r.id},1,'jina',${status === 'completed' ? 'received' : status},clock_timestamp()-${options.age ?? 0}*interval '1 second',
      ${['completed','received'].includes(status) ? sql`clock_timestamp()` : null})`;
  return r.id;
}
const ledger = () => sql`SELECT r.id,r.status,r.attempts,r.response,r.completed_at,t.status AS attempt_status,t.started_at,t.finished_at
  FROM receipts r LEFT JOIN receipt_attempts t ON t.receipt_id=r.id WHERE r.id=ANY(${receipts}::bigint[]) ORDER BY r.id,t.attempt`;

test('precise failure classification uses the same cleaned hash, without rejecting an article discussing challenges', () => {
  const url = 'https://www.example.com/article';
  for (const body of ['', 'x'.repeat(199)]) {
    const answer = raw(url,body); assert.deepEqual(classifyJinaBodyFailure(answer,url),{ reason: 'short_body',bodyHash: sha256(bodyText(answer,url)) });
  }
  assert.equal(classifyJinaBodyFailure(raw(url,'x'.repeat(200)),url),null);
  const error = raw(url,longBody,'Article','Warning: Target URL returned error 403: Forbidden');
  assert.equal(classifyJinaBodyFailure(error,url)?.reason,'target_http_error');
  const reddit = raw(url,'# Prove your humanity\n\nComplete the challenge.\n\n' + longBody,'Reddit - Prove your humanity');
  assert.equal(classifyJinaBodyFailure(reddit,url)?.reason,'verification_interstitial');
  assert.equal(classifyJinaBodyFailure(raw(url,'# Research on CAPTCHA\n\nWe quote prove your humanity and complete the challenge.\n\n' + longBody),url),null);
  assert.equal(classifyJinaBodyFailure(raw(url,longBody,'Just a moment...'),url),null);
  assert.equal(classifyJinaBodyFailure(raw(url,longBody + '\n\nWarning: Target URL returned error 403 is a quotation.'),url),null);
});

test('settled short answers lazily block future days/reruns without changing ledger, article identity or budget policy', async () => {
  const a = await article('lazy'); const answer = raw(a.url); const receiptId = await saved(a,answer,'completed',{ age: 2 * 86400 });
  const before = await ledger(); const hit = await getBodyFailure(a.id,a.url);
  assert.equal(hit?.receiptId,receiptId); assert.equal(hit?.reason,'short_body'); assert.equal(hit?.bodyHash,sha256(bodyText(answer,a.url)));
  await sql`UPDATE articles SET revision=revision+1,body_status='pending',processing_state='new' WHERE id=${a.id}`;
  assert.equal((await getBodyFailure(a.id,a.url))?.id,hit?.id);
  assert.deepEqual(await ledger(),before);
  assert.equal((await sql`SELECT count(*)::int AS n FROM article_body_failure_cache WHERE article_id=${a.id} AND event_kind='failure'`)[0].n,1);
  assert.equal(await getBodyFailure(a.id,a.url + '/different'),null);
});

test('unknown and pending answers outrank an existing failure and are never recorded as empty body evidence', async () => {
  const a = await article('unresolved'); const answer = raw(a.url); const r = await saved(a,answer);
  await recordBodyFailure({ articleId: a.id,url: a.url,receiptId: r,reason: 'short_body',bodyHash: sha256(bodyText(answer,a.url)) });
  const pending = await saved(a,'','pending'); const before = await ledger();
  await assert.rejects(getBodyFailure(a.id,a.url),ReceiptBusyError); assert.deepEqual(await ledger(),before);
  await assert.rejects(recordBodyFailure({ articleId: a.id,url: a.url,receiptId: pending,reason: 'short_body',bodyHash: sha256('') }),/saved matching/);
  await sql`UPDATE receipts SET status='unknown' WHERE id=${pending}`;
  await assert.rejects(getBodyFailure(a.id,a.url),(error: unknown) => error instanceof ReceiptUnknownError && error.receiptId === pending);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${pending}`)[0].status,'unknown');
});

test('lazy audited mismatches require exact article/URL/hash and preserve unrelated partial body text', async () => {
  const a = await article('audited'); const profile = raw(a.url,longBody,'Account profile'); const receiptId = await saved(a,profile);
  const text = bodyText(profile,a.url); const hash = sha256(text);
  await sql`UPDATE articles SET body_text='Original publisher partial',body_status='unconfirmed' WHERE id=${a.id}`;
  await audit('offline-test','content.body-rejection-authorized','content:' + a.id,'Exact wrong body reviewed',null,
    { url: a.url + '/different',bodySha256: hash,receiptId,evidence: 'offline fixture' });
  assert.equal(await getBodyFailure(a.id,a.url),null);
  await audit('offline-test','content.body-rejection-authorized','content:' + a.id,'Exact wrong body reviewed',null,
    { url: a.url,bodySha256: hash,receiptId,evidence: 'offline fixture' });
  const hit = await getBodyFailure(a.id,a.url); assert.equal(hit?.reason,'audited_body_mismatch'); assert.equal(hit?.bodyHash,hash);
  assert.equal((await sql`SELECT body_text FROM articles WHERE id=${a.id}`)[0].body_text,'Original publisher partial');
  const other = await article('other'); assert.equal(await getBodyFailure(other.id,other.url),null);
});

test('a newer valid settled body prevents an older failure being lazily selected; bad scope/hash/outer status cannot be recorded', async () => {
  const a = await article('valid-latest'); const old = raw(a.url); const oldId = await saved(a,old,'completed',{ age: 100 });
  await saved(a,raw(a.url,longBody)); assert.equal(await getBodyFailure(a.id,a.url),null);
  await assert.rejects(recordBodyFailure({ articleId: a.id,url: a.url,receiptId: oldId,reason: 'short_body',bodyHash: sha256('wrong') }),/hash mismatch/);
  const wrongPurpose = await saved(a,old,'completed',{ purpose: 'source_detail' });
  await assert.rejects(recordBodyFailure({ articleId: a.id,url: a.url,receiptId: wrongPurpose,reason: 'short_body',bodyHash: sha256(bodyText(old,a.url)) }),/saved matching/);
  const rejected = await saved(a,old,'completed',{ outerStatus: 429 });
  await assert.rejects(recordBodyFailure({ articleId: a.id,url: a.url,receiptId: rejected,reason: 'short_body',bodyHash: sha256(bodyText(old,a.url)) }),/saved matching/);
});

test('record participates in the material transaction and retains received evidence when that transaction rolls back', async () => {
  const a = await article('rollback'); const answer = raw(a.url); const receiptId = await saved(a,answer,'received');
  const input = { articleId: a.id,url: a.url,receiptId,reason: 'short_body' as const,bodyHash: sha256(bodyText(answer,a.url)) };
  assert.equal(await getBodyFailure(a.id,a.url),null,'received alone is not settled lazy evidence');
  await assert.rejects(sql.begin(async tx => { await recordBodyFailure(input,tx); await completeReceipt(tx,receiptId); throw Error('rollback material'); }),/rollback material/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM article_body_failure_cache WHERE article_id=${a.id}`)[0].n,0);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${receiptId}`)[0].status,'received');
  await sql.begin(async tx => { await recordBodyFailure(input,tx); await completeReceipt(tx,receiptId); });
  assert.equal((await getBodyFailure(a.id,a.url))?.receiptId,receiptId);
});

test('current normal-body proof resolves failures, retains history and does not let an old or late answer recreate them', async () => {
  const a = await article('resolved'); const bad = raw(a.url); const old = await saved(a,bad,'completed',{ age: 100 });
  await recordBodyFailure({ articleId: a.id,url: a.url,receiptId: old,reason: 'short_body',bodyHash: sha256(bodyText(bad,a.url)) });
  const normal = bodyText(raw(a.url,longBody),a.url); const hash = sha256(normal);
  assert.equal(await resolveBodyFailure({ articleId: a.id,url: a.url,revision: 1,bodyHash: hash,via: 'rss' }),0);
  await sql`UPDATE articles SET revision=2,body_text=${normal},body_status='ok' WHERE id=${a.id}`;
  assert.equal(await resolveBodyFailure({ articleId: a.id,url: a.url,revision: 1,bodyHash: hash,via: 'rss' }),0);
  assert.equal(await resolveBodyFailure({ articleId: a.id,url: a.url,revision: 2,bodyHash: hash,via: 'rss' }),1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM article_body_failure_cache WHERE article_id=${a.id} AND resolved_at IS NOT NULL`)[0].n,1);
  await sql`UPDATE articles SET body_status='pending' WHERE id=${a.id}`;
  assert.equal(await getBodyFailure(a.id,a.url),null);
  const fresh = await saved(a,bad); assert.equal((await getBodyFailure(a.id,a.url))?.receiptId,fresh,'a new real failed request can be cached after a resolution');
});

test('success without an old negative row leaves a marker that covers an already in-flight answer', async () => {
  const a = await article('late'); const late = await saved(a,'','pending',{ age: 100 });
  const normal = bodyText(raw(a.url,longBody),a.url); await sql`UPDATE articles SET body_text=${normal},body_status='ok' WHERE id=${a.id}`;
  assert.equal(await resolveBodyFailure({ articleId: a.id,url: a.url,revision: 1,bodyHash: sha256(normal),via: 'readability' }),0);
  await sql`UPDATE receipts SET status='completed',response=${sql.json({ text: raw(a.url),status: 200 })},received_at=clock_timestamp(),completed_at=clock_timestamp() WHERE id=${late}`;
  await sql`UPDATE articles SET body_status='pending' WHERE id=${a.id}`;
  assert.equal(await getBodyFailure(a.id,a.url),null);
  assert.equal((await sql`SELECT count(*)::int AS n FROM article_body_failure_cache WHERE article_id=${a.id} AND event_kind='resolution'`)[0].n,1);
});

test('verified cache survives independent receipt retention and cannot be cleared by a false body proof', async () => {
  const a = await article('retained'); const answer = raw(a.url); const receiptId = await saved(a,answer);
  const hit = await getBodyFailure(a.id,a.url); assert.equal(hit?.receiptId,receiptId);
  // Simulate only this fixture receipt's existing independent ledger-retention policy.
  await sql`DELETE FROM receipts WHERE id=${receiptId}`;
  assert.equal((await getBodyFailure(a.id,a.url))?.id,hit?.id);
  assert.equal(await resolveBodyFailure({ articleId: a.id,url: a.url,revision: 1,bodyHash: sha256('unverified'),via: 'history' }),0);
  assert.equal((await getBodyFailure(a.id,a.url))?.id,hit?.id);
});

test('a newer normal completed response is not hidden by an already active older negative', async () => {
  const a = await article('active-then-valid'); const bad = raw(a.url); const old = await saved(a,bad,'completed',{ age: 100 });
  const cached = await recordBodyFailure({ articleId: a.id,url: a.url,receiptId: old,reason: 'short_body',bodyHash: sha256(bodyText(bad,a.url)) });
  await saved(a,raw(a.url,longBody)); const before = await ledger();
  assert.equal(await getBodyFailure(a.id,a.url),null);
  assert.deepEqual(await ledger(),before);
  assert.equal((await sql`SELECT id FROM article_body_failure_cache WHERE id=${cached.id}`).length,1,'the old negative evidence is retained');
});

test('same-day reuse of a resolved old answer cannot reactivate its failure after a formal rerun', async () => {
  const a = await article('resolved-then-rerun'); const bad = raw(a.url); const receiptId = await saved(a,bad,'completed',{ age: 100 });
  const input = { articleId: a.id,url: a.url,receiptId,reason: 'short_body' as const,bodyHash: sha256(bodyText(bad,a.url)) };
  const cached = await recordBodyFailure(input);
  const normal = bodyText(raw(a.url,longBody),a.url);
  await sql`UPDATE articles SET revision=2,body_status='ok',body_text=${normal} WHERE id=${a.id}`;
  await resolveBodyFailure({ articleId: a.id,url: a.url,revision: 2,bodyHash: sha256(normal),via: 'readability' });
  await sql`UPDATE articles SET body_status='pending',processing_state='new' WHERE id=${a.id}`;
  const before = await ledger(); assert.equal(await getBodyFailure(a.id,a.url),null);
  assert.equal((await recordBodyFailure(input)).id,cached.id,'a reused old answer remains resolved history');
  assert.equal(await getBodyFailure(a.id,a.url),null);
  assert.equal((await sql`SELECT count(*)::int AS n FROM article_body_failure_cache WHERE article_id=${a.id} AND event_kind='failure' AND resolved_at IS NULL`)[0].n,0);
  assert.deepEqual(await ledger(),before);
});
