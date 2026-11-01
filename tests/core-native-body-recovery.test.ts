// Only local MockAgent responses and a disposable *_test database are used.
import { gate, tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { config } from '@aihot/backend/config';
import { sql, closeDb } from '@aihot/backend/db';
import { extractArticleBody } from '@aihot/backend/content/extract';
import { sanitizeFeedBody } from '@aihot/backend/content/feed-body';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { sha256 } from '@aihot/backend/lib/ids';
import { RECOVERY_BATCH_PREFIX, planRecoveryBatch, applyRecoveryBatch, stopRecoveryBatch,
  getRecoveryBodyPolicy, getRecoveryRssBodyPolicy, getRecoveryAdmission, recoveryBatchStatus,
  recoveryPlanDigest, parseRecoveryPlan, getRecoveryBatch } from '@aihot/backend/jobs/processing-recovery';
import { RECENT_CONTENT_POLICY_KEY, setRecentContentPolicy, invalidateRecentContentCache } from '@aihot/backend/jobs/recent-content';
import { getBoss, stopBoss } from '@aihot/backend/jobs/queue';

const prefix = tag(), sourceId = `${prefix}-native-source`, ids: string[] = [], batches: string[] = [];
let counter = 700000, mock: MockAgent, paidHits = 0;
const previousDispatcher = getGlobalDispatcher();
let previousProxy: string | null, previousPrivate: boolean, oldPolicy: any[] = [];
before(async () => {
  previousProxy = config.egressProxyUrl; previousPrivate = config.allowPrivateNetworkFetch;
  config.egressProxyUrl = null; config.allowPrivateNetworkFetch = true;
  mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
  // A forbidden paid call would be recorded without ever reaching a real provider.
  process.env.JINA_BASE_URL = 'https://jina.example.com'; process.env.JINA_API_KEY = 'offline-only';
  mock.get('https://jina.example.com').intercept({ path: /.*/ }).reply(() => {
    paidHits++; return { statusCode: 200, data: 'Unexpected paid request' };
  }).persist();
  await getBoss(); oldPolicy = await sql`SELECT value,updated_by,updated_at FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  await setRecentContentPolicy(true, 'offline-test', 'Preserve the global window');
  await sql`INSERT INTO sources(id,name,kind,enabled,tier,participation_mode,site_fulltext,syndicate_fulltext,config)
    VALUES(${sourceId},'Native body original source','rss',true,'T2','editorial',false,false,'{}')`;
});
afterEach(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`DELETE FROM settings WHERE key=ANY(${batches.map(id => RECOVERY_BATCH_PREFIX + id)}::text[])`;
  await sql`DELETE FROM articles WHERE id=ANY(${ids}::text[])`;
  await sql`UPDATE sources SET config='{}',enabled=true WHERE id=${sourceId}`;
  ids.length = 0; batches.length = 0; invalidateRecentContentCache();
  assert.equal(paidHits, 0);
});
after(async () => {
  await sql`DELETE FROM sources WHERE id=${sourceId}`;
  await sql`DELETE FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  for (const row of oldPolicy) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${RECENT_CONTENT_POLICY_KEY},${sql.json(row.value)},${row.updated_by},${row.updated_at})`;
  await stopBoss(); await closeDb(); setGlobalDispatcher(previousDispatcher); await mock.close();
  config.egressProxyUrl = previousProxy; config.allowPrivateNetworkFetch = previousPrivate;
});
async function fixture(adapter: 'mittrchina' | 'speechhome' = 'mittrchina') {
  const itemId = String(++counter), url = adapter === 'mittrchina'
    ? `https://www.mittrchina.com/news/detail/${itemId}` : `https://speechhome.com/post/${itemId}`;
  const title = `Original ${adapter} research ${itemId}`;
  const raw = '<p>Native research on AI4S and Nemotron explains verified architecture, evaluations, evidence and limitations in detail.</p>'.repeat(9);
  const body = sanitizeFeedBody(raw, url);
  const policy = { adapter, allowJina: false as const, bodyProof: { bodySha256: sha256(body.text), tailSha256: sha256(body.text.slice(-200)), requiredTerms: ['research', 'evidence'] } };
  const result = await upsertMaterial({ sourceId, url, title, author: 'Original author', publishedAt: new Date(Date.now() - 3600000),
    excerpt: 'Keep original excerpt', bodyStatus: 'unconfirmed', via: 'fetch' });
  ids.push(result.articleId);
  await sql`UPDATE articles SET processing_state='analyzed',processing_attempt_tag='existing-tag' WHERE id=${result.articleId}`;
  const response = adapter === 'mittrchina' ? { code: 10000, data: { id: Number(itemId), name: title, status: 1, is_vip: 2, content: raw } }
    : { status: 200, data: { isSucceed: true, result: { id: itemId, title, content: raw, postType: 0, statusCode: 0 } } };
  const endpoint = adapter === 'mittrchina' ? `https://apii.web.mittrchina.com/information/details?id=${itemId}`
    : `https://speechhome.com/api/api/post/detail/${itemId}`;
  return { id: result.articleId, url, title, body, policy, response, endpoint };
}
async function plan(f: Awaited<ReturnType<typeof fixture>>, parentBatchId?: string) {
  const id = `${prefix}-native-${batches.length}`; batches.push(id);
  return planRecoveryBatch({ id, kind: 'web-body-recovery', articleIds: [f.id], evidence: 'User named exact free native body recovery',
    nativeBodies: { [f.id]: f.policy }, ...(parentBatchId ? { parentBatchId } : {}) });
}
function reply(f: Awaited<ReturnType<typeof fixture>>, body = f.response) {
  const endpoint = new URL(f.endpoint);
  mock.get(endpoint.origin).intercept({ path: endpoint.pathname + endpoint.search }).reply(200, body, { headers: { 'content-type': 'application/json' } });
}
const frozen = async (id: string) => (await sql`SELECT source_id,url,title,author,published_at,processing_attempt_tag FROM articles WHERE id=${id}`)[0];

for (const adapter of ['mittrchina', 'speechhome'] as const) test(`${adapter} normal extraction stores one verified revision and preserves original identity`, async () => {
  const f = await fixture(adapter), manifest = await plan(f); await applyRecoveryBatch(manifest, 'offline-test', 'Fixed native recovery');
  reply(f); const before = await frozen(f.id);
  assert.equal(await extractArticleBody(f.id, true), 'ok'); assert.deepEqual(await frozen(f.id), before);
  const [row] = await sql`SELECT revision,body_status,body_text,processing_state FROM articles WHERE id=${f.id}`;
  assert.equal(row!.revision, 2); assert.equal(row!.body_status, 'ok'); assert.equal(row!.body_text, f.body.text); assert.equal(row!.processing_state, 'new');
  assert.equal((await getRecoveryBatch(manifest.id))!.currentRevisions[f.id], 2);
  assert.equal((await recoveryBatchStatus(manifest.id))!.completeable, false);
  assert.equal((await sql`SELECT after->>'via' AS via FROM audit_log WHERE action='content.body-restored' AND subject=${'content:' + f.id}`)[0]!.via, 'structured');
  assert.equal(await extractArticleBody(f.id, true), 'skipped');
});
test('native proof mismatch leaves the same empty body and never calls Jina', async () => {
  const f = await fixture(); f.policy.bodyProof.bodySha256 = '0'.repeat(64);
  const manifest = await plan(f); await applyRecoveryBatch(manifest, 'offline-test', 'Proof must match'); reply(f);
  assert.equal(await extractArticleBody(f.id, true), 'unconfirmed');
  assert.equal((await sql`SELECT revision FROM articles WHERE id=${f.id}`)[0]!.revision, 1);
});
for (const change of ['config', 'revision', 'url', 'revoke'] as const) test(`a ${change} change during native HTTP prevents a stale body write`, async () => {
  const f = await fixture(), manifest = await plan(f); await applyRecoveryBatch(manifest, 'offline-test', 'Exact native identity');
  const entered = gate(), endpoint = new URL(f.endpoint);
  mock.get(endpoint.origin).intercept({ path: endpoint.pathname + endpoint.search }).reply(() => {
    entered.open(); return { statusCode: 200, data: JSON.stringify(f.response), responseOptions: { headers: { 'content-type': 'application/json' } } };
  }).delay(150);
  const pending = extractArticleBody(f.id, true);
  await Promise.race([entered.promise, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(Error('No local native dispatch')), 5000); t.unref(); })]);
  if (change === 'config') await sql`UPDATE sources SET config='{"changed":true}' WHERE id=${sourceId}`;
  if (change === 'revision') await sql`UPDATE articles SET revision=revision+1 WHERE id=${f.id}`;
  if (change === 'url') await sql`UPDATE articles SET url=${f.url + '?different=1'} WHERE id=${f.id}`;
  if (change === 'revoke') await stopRecoveryBatch(manifest.id, 'revoked', 'offline-test', 'Revoke in flight');
  assert.equal(await pending, 'skipped');
  const [row] = await sql`SELECT body_text,body_status FROM articles WHERE id=${f.id}`;
  assert.equal(row!.body_text, null); assert.equal(row!.body_status, 'unconfirmed');
});
for (const terminal of ['complete', 'revoked'] as const) test(`${terminal} removes native admission but retains no-Jina across the legacy API`, async () => {
  const f = await fixture(), manifest = await plan(f); await applyRecoveryBatch(manifest, 'offline-test', 'Fixed body');
  await stopRecoveryBatch(manifest.id, terminal, 'offline-test', 'End finite test');
  const policy = await getRecoveryBodyPolicy(f.id);
  assert.equal(policy.denyJina, true); assert.equal(policy.nativeStrategy, null); assert.equal(policy.rssStrategy, null);
  assert.deepEqual(await getRecoveryRssBodyPolicy(f.id), { denyJina: true, strategy: null });
  assert.equal(await getRecoveryAdmission(f.id), null);
  // The later operator-approved daily route is independent of this closed fixed permission.
  // It may read the free endpoint, while the old batch stays closed and cannot grant scope.
  reply(f);
  assert.equal(await extractArticleBody(f.id, true), 'ok');
  assert.equal((await getRecoveryBatch(manifest.id))!.status, terminal);
  assert.equal(await getRecoveryAdmission(f.id), null);
  const [audit] = await sql`SELECT after FROM audit_log WHERE action='content.body-restored' AND subject=${'content:' + f.id} ORDER BY id DESC LIMIT 1`;
  assert.equal(audit!.after.scope, 'routine'); assert.equal(audit!.after.batchId, undefined);
});
test('a rejected native response cannot mark a changed URL unconfirmed', async () => {
  const f = await fixture(), manifest = await plan(f); await applyRecoveryBatch(manifest, 'offline-test', 'Fixed native identity');
  const entered = gate(), endpoint = new URL(f.endpoint);
  mock.get(endpoint.origin).intercept({ path: endpoint.pathname + endpoint.search }).reply(() => {
    entered.open(); return { statusCode: 200, data: '{}', responseOptions: { headers: { 'content-type': 'application/json' } } };
  }).delay(150);
  const pending = extractArticleBody(f.id, true); await entered.promise;
  await sql`UPDATE articles SET url=${f.url + '?changed=1'},body_status='pending' WHERE id=${f.id}`;
  assert.equal(await pending, 'skipped');
  assert.equal((await sql`SELECT body_status FROM articles WHERE id=${f.id}`)[0]!.body_status, 'pending');
});
test('a closed parent authorizes only its exact existing member after the rolling window ages', async () => {
  const f = await fixture(), parentId = `${prefix}-prior-body`; batches.push(parentId);
  // The original public body batch is created in-window and closed normally.
  const parent = await planRecoveryBatch({ id: parentId, kind: 'web-body-recovery', articleIds: [f.id], evidence: 'Initial recent body batch' });
  await applyRecoveryBatch(parent, 'offline-test', 'Original scope'); await stopRecoveryBatch(parentId, 'complete', 'offline-test', 'Original body outcome settled');
  const oldAt = new Date(Date.now() - 60 * 3600000).toISOString().replace('Z', '000Z'), oldWindow = new Date(Date.now() - 36 * 3600000).toISOString();
  await sql`UPDATE articles SET published_at=${oldAt} WHERE id=${f.id}`;
  const [r] = await sql`SELECT value FROM settings WHERE key=${RECOVERY_BATCH_PREFIX + parentId}`;
  const value = { ...r!.value, createdAt: oldWindow, windowAt: oldWindow, members: [{ ...parent.members[0]!, publishedAt: oldAt }] };
  value.digest = recoveryPlanDigest(value);
  await sql`UPDATE settings SET value=${sql.json(value)} WHERE key=${RECOVERY_BATCH_PREFIX + parentId}`;
  // Move this disposable fixture's complete history together; production inheritance cannot rewrite it.
  await sql`UPDATE audit_log SET after=jsonb_set(after,'{digest}',to_jsonb(${value.digest}::text))
    WHERE subject=${'recovery:' + parentId} AND action IN('content.processing-recovery.apply','content.processing-recovery.complete')`;
  await assert.rejects(plan(f), /recent|window/);
  const next = await plan(f, parentId); const parentBefore = await getRecoveryBatch(parentId);
  assert.equal(next.windowAt, oldWindow); assert.equal(next.parentBatchId, parentId);
  await applyRecoveryBatch(next, 'offline-test', 'Explicit exact old member native recovery');
  assert.deepEqual(await getRecoveryBatch(parentId), parentBefore);
  assert.equal((await getRecoveryBodyPolicy(f.id)).nativeStrategy?.batchId, next.id);
  const g = await fixture('speechhome'); await assert.rejects(plan(g, parentId), /parent|member|initial recent/i);
});
test('parent digest drift between planning and activation is rejected', async () => {
  const f = await fixture(), parentId = `${prefix}-parent-drift`; batches.push(parentId);
  const parent = await planRecoveryBatch({ id: parentId, kind: 'web-body-recovery', articleIds: [f.id], evidence: 'Original finite body cohort' });
  await applyRecoveryBatch(parent, 'offline-test', 'Original'); await stopRecoveryBatch(parentId, 'complete', 'offline-test', 'Original complete');
  const next = await plan(f, parentId);
  const changed = { ...parent, evidence: 'Different archived identity' }; const digest = recoveryPlanDigest(changed);
  await sql`UPDATE settings SET value=jsonb_set(value,'{digest}',to_jsonb(${digest}::text)) WHERE key=${RECOVERY_BATCH_PREFIX + parentId}`;
  await assert.rejects(applyRecoveryBatch(next, 'offline-test', 'No stale parent'), /parent|digest/i);
});
test('native and RSS strategies cannot be mixed on one member or put on non-web batches', async () => {
  const f = await fixture(), p = await plan(f);
  const mixed = { ...p, members: [{ ...p.members[0]!, rssBody: { feedUrl: 'https://publisher.example.com/feed', allowJina: false as const, bodyProof: f.policy.bodyProof } }] };
  assert.throws(() => parseRecoveryPlan({ ...mixed, digest: recoveryPlanDigest(mixed) }));
  assert.throws(() => parseRecoveryPlan({ ...p, kind: 'model-failure' }));
});
