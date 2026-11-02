// Only a fixed web batch's analyzed but still-pending body gets the missing extraction handoff.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { sweepRecoveryBatches } from "@aihot/backend/jobs/content";
import { enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { invalidateRecentContentCache, RECENT_CONTENT_POLICY_KEY } from "@aihot/backend/jobs/recent-content";
import { applyRecoveryBatch, planRecoveryBatch, RECOVERY_BATCH_PREFIX, stopRecoveryBatch } from "@aihot/backend/jobs/processing-recovery";

const prefix = `web-handoff-${tag()}`;
const source = `${prefix}-rss`;
const ids: string[] = [], batches: string[] = [], receiptIds: number[] = [];
let policy: Array<{ value: unknown; updated_by: string | null; updated_at: string }> = [];
before(async () => {
  policy = await sql`SELECT value,updated_by,updated_at::text FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  await getBoss();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${source},'Web body handoff fixture','rss','T1','editorial','2100-01-01')`;
});
beforeEach(async () => {
  await sql`INSERT INTO settings(key,value,updated_by) VALUES(${RECENT_CONTENT_POLICY_KEY},'{"enabled":true}','web-handoff-test')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  invalidateRecentContentCache();
});
afterEach(async () => {
  await sql`DELETE FROM event_job_deferrals WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`DELETE FROM settings WHERE key=ANY(${batches.map(id => RECOVERY_BATCH_PREFIX + id)}::text[])`;
  await sql`DELETE FROM articles WHERE source_id=${source}`;
  await sql`DELETE FROM receipts WHERE id=ANY(${receiptIds}::bigint[])`;
  await sql`DELETE FROM audit_log WHERE subject=ANY(${ids.map(id => 'content:' + id)}::text[])`;
  await sql`UPDATE sources SET enabled=true,participation_mode='editorial',config='{}' WHERE id=${source}`;
  ids.length = 0; batches.length = 0; receiptIds.length = 0;
  invalidateRecentContentCache();
});
after(async () => {
  await sql`DELETE FROM sources WHERE id=${source}`;
  await sql`DELETE FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  for (const row of policy) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${RECENT_CONTENT_POLICY_KEY},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  await stopBoss(); await closeDb();
});
async function article(name: string) {
  const id = `${prefix}-${name}`; ids.push(id);
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,body_status,
    processing_state,processing_attempts,processing_attempt_tag)
    VALUES(${id},${source},${id},${'https://www.example.com/' + id},'Body handoff',now()-interval '1 hour',now(),now(),
      'unconfirmed','analyzed',2,'existing-evaluation')`;
  return id;
}
async function activate(name: string, members: string[], kind: 'web-body-recovery' | 'model-failure' = 'web-body-recovery') {
  const id = `${prefix}-${name}`; batches.push(id);
  const plan = await planRecoveryBatch({ id,kind,articleIds: members,evidence: 'Exact isolated body handoff fixtures' });
  await applyRecoveryBatch(plan,'offline-test','Only the fixed members may recover their bodies');
  return plan;
}
const state = async (id: string) => (await sql`SELECT revision,body_status,processing_state,processing_attempts,processing_attempt_tag,
  processing_retry_at,processing_error FROM articles WHERE id=${id}`)[0]!;
const jobs = (id: string) => sql`SELECT id,name,data,state FROM pgboss.job WHERE data->>'articleId'=${id}`;

test("an admitted web member with analyzed/pending body gets one audited extract job, retaining revision and paid identity", async () => {
  const id = await article('missing'); await activate('missing-batch',[id]);
  await sql`UPDATE articles SET body_status='pending' WHERE id=${id}`;
  const before = await state(id); const attempts = (await sql`SELECT count(*)::int AS n FROM receipt_attempts`)[0].n;
  await sweepRecoveryBatches();
  const after = await state(id); assert.equal(after.processing_state,'new'); assert.equal(after.body_status,'pending');
  assert.equal(after.revision,before.revision); assert.equal(after.processing_attempts,before.processing_attempts);
  assert.equal(after.processing_attempt_tag,'existing-evaluation');
  const queued = await jobs(id); assert.equal(queued.length,1); assert.equal(queued[0].name,QUEUES.extractBody);
  assert.deepEqual(queued[0].data,{ articleId: id });
  await sweepRecoveryBatches(); assert.equal((await jobs(id)).length,1);
  assert.equal((await sql`SELECT id FROM audit_log WHERE action='content.body-handoff' AND subject=${'content:' + id}`).length,1);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts`)[0].n,attempts);
});

test("completed/terminal bodies, blocked states, unknowns, active work, deferrals and future cooldowns do not reopen", async () => {
  const kinds = ['ok','unconfirmed','blocked','skipped','unknown','active','deferral','cooldown'];
  const members = await Promise.all(kinds.map(article)); await activate('guards-batch',members);
  for (const [index,kind] of kinds.entries()) {
    const id = members[index];
    await sql`UPDATE articles SET body_status=${kind === 'ok' ? 'ok' : kind === 'unconfirmed' ? 'unconfirmed' : 'pending'},
      processing_state=${['blocked','skipped'].includes(kind) ? kind : 'analyzed'} WHERE id=${id}`;
    if (kind === 'unknown') {
      const [r] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,attempts)
        VALUES(${id},'jina','body_fallback',${'article:' + id},'unknown',1) RETURNING id`; receiptIds.push(r.id);
    }
    if (kind === 'active') await enqueue(QUEUES.extractBody,{ articleId: id },{ singletonKey: id });
    if (kind === 'deferral') await sql`INSERT INTO event_job_deferrals(queue,singleton_key,data,retry_at,remaining_retries,reason)
      VALUES('events.group',${id},${sql.json({ articleId: id })},now()+interval '1 hour',2,'Budget for embedding exhausted (day)')`;
    if (kind === 'cooldown') await sql`UPDATE articles SET processing_retry_at=now()+interval '1 hour',processing_error='extract: jina HTTP 429' WHERE id=${id}`;
  }
  const before = await Promise.all(members.map(state)); await sweepRecoveryBatches();
  assert.deepEqual(await Promise.all(members.map(state)),before);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE data->>'articleId'=ANY(${members}::text[])`).length,1);
  assert.equal((await sql`SELECT id FROM audit_log WHERE action='content.body-handoff' AND subject=ANY(${members.map(id => 'content:' + id)}::text[])`).length,0);
});

test("a revoked or drifted web permission and an old model-failure batch cannot acquire this handoff", async () => {
  const drift = await article('drift'); const batch = await activate('drift-batch',[drift]);
  await sql`UPDATE articles SET body_status='pending' WHERE id=${drift}`;
  const before = await state(drift);
  await sql`UPDATE sources SET config='{"changed":true}' WHERE id=${source}`;
  await sweepRecoveryBatches(); assert.deepEqual(await state(drift),before); assert.equal((await jobs(drift)).length,0);
  await sql`UPDATE sources SET config='{}' WHERE id=${source}`;
  await sql`UPDATE articles SET revision=revision+1 WHERE id=${drift}`;
  const revised = await state(drift); await sweepRecoveryBatches();
  assert.deepEqual(await state(drift),revised); assert.equal((await jobs(drift)).length,0);
  await sql`UPDATE articles SET revision=1 WHERE id=${drift}`;
  await stopRecoveryBatch(batch.id,'revoked','offline-test','Pause the exact permission');
  await sweepRecoveryBatches(); assert.equal((await jobs(drift)).length,0);
  const old = await article('old-model'); await sql`UPDATE articles SET processing_state='failed' WHERE id=${old}`;
  await activate('old-model-batch',[old],'model-failure');
  await sql`UPDATE articles SET processing_state='analyzed',body_status='pending' WHERE id=${old}`;
  const oldBefore = await state(old); await sweepRecoveryBatches();
  assert.deepEqual(await state(old),oldBefore); assert.equal((await jobs(old)).length,0);
});
