// A released body receipt resumes extraction, including a durable handoff an older worker missed.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { audit } from "@aihot/backend/audit";
import { closeDb, sql } from "@aihot/backend/db";
import { enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { invalidateRecentContentCache, RECENT_CONTENT_POLICY_KEY } from "@aihot/backend/jobs/recent-content";
import { applyRecoveryBatch, planRecoveryBatch, RECOVERY_BATCH_PREFIX } from "@aihot/backend/jobs/processing-recovery";
import { releaseReceipt, resumeReleasedBodyHandoffs } from "@aihot/backend/operations/recover";

const prefix = `body-release-${tag()}`;
const source = `${prefix}-rss`;
const ids: string[] = [], receiptIds: number[] = [], batchIds: string[] = [];
let policy: Array<{ value: unknown; updated_by: string | null; updated_at: string }> = [];
before(async () => {
  policy = await sql`SELECT value,updated_by,updated_at::text FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  await getBoss();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${source},'Body release fixture','rss','T1','editorial','2100-01-01')`;
});
beforeEach(async () => {
  await sql`INSERT INTO settings(key,value,updated_by) VALUES(${RECENT_CONTENT_POLICY_KEY},'{"enabled":true}','body-release-test')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  invalidateRecentContentCache();
});
afterEach(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`DELETE FROM settings WHERE key=ANY(${batchIds.map(id => RECOVERY_BATCH_PREFIX + id)}::text[])`;
  await sql`DELETE FROM articles WHERE source_id=${source}`;
  await sql`DELETE FROM receipts WHERE id=ANY(${receiptIds}::bigint[])`;
  await sql`DELETE FROM audit_log WHERE subject=ANY(${receiptIds.map(id => 'receipt:' + id)}::text[])`;
  await sql`UPDATE sources SET enabled=true,participation_mode='editorial',config='{}' WHERE id=${source}`;
  ids.length = 0; receiptIds.length = 0; batchIds.length = 0;
  invalidateRecentContentCache();
});
after(async () => {
  await sql`DELETE FROM sources WHERE id=${source}`;
  await sql`DELETE FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  for (const row of policy) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${RECENT_CONTENT_POLICY_KEY},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  await stopBoss(); await closeDb();
});
async function fixture(name: string, options: { state?: string; body?: string; receiptState?: string; minutes?: number; receiptUrl?: string | null } = {}) {
  const id = `${prefix}-${name}`; ids.push(id);
  const url = 'https://www.example.com/' + id;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,body_status,
    processing_state,processing_attempts,processing_attempt_tag,processing_error)
    VALUES(${id},${source},${id},${url},'Body release fixture',now()-${options.minutes ?? 1}*interval '1 minute',now(),now(),
      ${options.body ?? 'unconfirmed'},${options.state ?? 'analyzed'},2,'original-evaluation','receipt outcome unknown')`;
  const [r] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,attempts,request,created_at,updated_at)
    VALUES(${id},'jina','body_fallback',${'article:' + id},${options.receiptState ?? 'unknown'},1,
      ${sql.json({ url: options.receiptUrl === undefined ? url : options.receiptUrl })},now()-interval '2 hours',now()-interval '1 hour') RETURNING id`;
  receiptIds.push(r.id);
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,started_at,finished_at)
    VALUES(${r.id},1,'jina',${options.receiptState === 'failed' ? 'failed' : 'unknown'},now()-interval '2 hours',now()-interval '1 hour')`;
  return { id,url,receiptId: r.id };
}
const state = async (id: string) => (await sql`SELECT revision,body_status,processing_state,processing_attempts,processing_attempt_tag,
  processing_error,processing_retry_at,processing_queued_at FROM articles WHERE id=${id}`)[0]!;
const jobs = (id: string) => sql`SELECT id,name,state,data,priority FROM pgboss.job WHERE data->>'articleId'=${id}`;
async function oldRelease(receiptId: number) {
  await audit('ops.recover','receipt.release','receipt:' + receiptId,'Original automatic release without a handoff',
    { status: 'unknown' },{ status: 'failed',billed: null,requeued: false });
  return Number((await sql`SELECT max(id)::bigint AS id FROM audit_log WHERE subject=${'receipt:' + receiptId} AND action='receipt.release'`)[0].id);
}

test("release resumes analyzed/unconfirmed and failed/pending bodies through extract, preserving the evaluation and attempts", async () => {
  for (const [index,options] of [{ state: 'analyzed',body: 'unconfirmed' },{ state: 'failed',body: 'pending' }].entries()) {
    const f = await fixture('normal-' + index,options); const before = await state(f.id);
    const result = await releaseReceipt(f.receiptId,{ billed: false,note: 'Verified original unknown request' },'offline-test');
    assert.equal(result?.requeued,true);
    const after = await state(f.id);
    assert.equal(after.processing_state,'new'); assert.equal(after.body_status,'pending');
    assert.equal(after.revision,before.revision); assert.equal(after.processing_attempts,before.processing_attempts);
    assert.equal(after.processing_attempt_tag,'original-evaluation');
    const queued = await jobs(f.id); assert.equal(queued.length,1);
    assert.equal(queued[0].name,QUEUES.extractBody); assert.deepEqual(queued[0].data,{ articleId: f.id });
    assert.equal((await sql`SELECT attempts FROM receipts WHERE id=${f.receiptId}`)[0].attempts,1);
    await assert.rejects(releaseReceipt(f.receiptId,{ billed: false,note: 'Duplicate release' },'offline-test'),/结果未知/);
    assert.equal((await jobs(f.id)).length,1);
  }
});

test("active work, blocked/complete bodies, wrong URL and another unresolved receipt leave article state untouched", async () => {
  for (const kind of ['active','retry','created','blocked','skipped','ok','none','url','null-url','unknown']) {
    const f = await fixture('guard-' + kind,{ state: ['blocked','skipped'].includes(kind) ? kind : 'analyzed',
      body: ['ok','none'].includes(kind) ? kind : 'unconfirmed',receiptUrl: kind === 'url' ? 'https://www.example.com/different' : kind === 'null-url' ? null : undefined });
    if (['active','retry','created'].includes(kind)) {
      const job = await enqueue(QUEUES.analyze,{ articleId: f.id },{ singletonKey: f.id });
      await sql`UPDATE pgboss.job SET state=${kind} WHERE id=${job}`;
    }
    if (kind === 'unknown') {
      const [other] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,attempts)
        VALUES(${f.id + '-other'},'llm','score_article',${'article:' + f.id + '@1'},'unknown',1) RETURNING id`;
      receiptIds.push(other.id);
    }
    const before = await state(f.id); const count = (await jobs(f.id)).length;
    assert.equal((await releaseReceipt(f.receiptId,{ billed: false,note: 'Guarded release' },'offline-test'))?.requeued,false,kind);
    assert.deepEqual(await state(f.id),before,kind); assert.equal((await jobs(f.id)).length,count,kind);
  }
  for (const mode of ['disabled','isolated','hot_signal']) {
    const f = await fixture('source-' + mode);
    await sql`UPDATE sources SET enabled=${mode !== 'disabled'},participation_mode=${mode === 'disabled' ? 'editorial' : mode} WHERE id=${source}`;
    const before = await state(f.id);
    assert.equal((await releaseReceipt(f.receiptId,{ billed: false,note: 'Source guard' },'offline-test'))?.requeued,false);
    assert.deepEqual(await state(f.id),before);
  }
});

test("outside2000 is paused while the current fixed recovery member returns to the extract queue", async () => {
  const fixed = await fixture('fixed',{ minutes: 60 }); const outside = await fixture('outside',{ minutes: 60 });
  const batchId = `${prefix}-batch`; batchIds.push(batchId);
  const plan = await planRecoveryBatch({ id: batchId,kind: 'web-body-recovery',articleIds: [fixed.id],evidence: 'Exact body release fixture' });
  await applyRecoveryBatch(plan,'offline-test','Fixed permitted body');
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,processing_state)
    SELECT ${prefix + '-filler-'}||g,${source},${prefix + '-filler-'}||g,'https://www.example.com/filler/'||g,'Scope filler',
      now()-interval '1 minute',now(),now(),'blocked' FROM generate_series(1,2000) g`;
  invalidateRecentContentCache(); const before = await state(outside.id);
  assert.equal((await releaseReceipt(outside.receiptId,{ billed: false,note: 'Outside scope' },'offline-test'))?.requeued,false);
  assert.deepEqual(await state(outside.id),before); assert.equal((await jobs(outside.id)).length,0);
  assert.equal((await releaseReceipt(fixed.receiptId,{ billed: false,note: 'Still admitted' },'offline-test'))?.requeued,true);
  const queued = await jobs(fixed.id); assert.equal(queued[0].name,QUEUES.extractBody); assert.equal(queued[0].priority,9000);
});

test("a durable old false release is handed off once without another release or provider attempt", async () => {
  const f = await fixture('old-false',{ receiptState: 'failed' }); const releaseAuditId = await oldRelease(f.receiptId);
  assert.ok((await resumeReleasedBodyHandoffs()).resumed >= 1);
  assert.equal((await jobs(f.id))[0].name,QUEUES.extractBody);
  const [handoff] = await sql`SELECT after FROM audit_log WHERE action='receipt.body-resumed' AND subject=${'receipt:' + f.receiptId}`;
  assert.equal(handoff.after.releaseAuditId,releaseAuditId);
  await sql`UPDATE pgboss.job SET state='completed' WHERE data->>'articleId'=${f.id}`;
  await sql`UPDATE articles SET processing_state='analyzed',body_status='unconfirmed' WHERE id=${f.id}`;
  await resumeReleasedBodyHandoffs();
  assert.equal((await jobs(f.id)).length,1);
  assert.equal((await sql`SELECT id FROM audit_log WHERE action='receipt.release' AND subject=${'receipt:' + f.receiptId}`).length,1);
  assert.equal((await sql`SELECT id FROM audit_log WHERE action='receipt.body-resumed' AND subject=${'receipt:' + f.receiptId}`).length,1);
  assert.equal((await sql`SELECT attempts FROM receipts WHERE id=${f.receiptId}`)[0].attempts,1);
});

test("durable repair does not touch second unknowns, completed bodies or a release already used by a provider attempt", async () => {
  const unknown = await fixture('second-unknown'); await oldRelease(unknown.receiptId);
  await sql`UPDATE receipts SET attempts=2 WHERE id=${unknown.receiptId}`;
  const complete = await fixture('complete',{ receiptState: 'failed',body: 'ok' }); await oldRelease(complete.receiptId);
  const used = await fixture('used',{ receiptState: 'failed' }); await oldRelease(used.receiptId);
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,started_at,finished_at)
    VALUES(${used.receiptId},2,'jina','failed',clock_timestamp(),clock_timestamp())`;
  await sql`UPDATE receipts SET attempts=2 WHERE id=${used.receiptId}`;
  const before = await Promise.all([unknown,complete,used].map(f => state(f.id)));
  await resumeReleasedBodyHandoffs();
  assert.deepEqual(await Promise.all([unknown,complete,used].map(f => state(f.id))),before);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE data->>'articleId'=ANY(${[unknown.id,complete.id,used.id]}::text[])`).length,0);
  assert.deepEqual((await sql`SELECT status,attempts FROM receipts WHERE id=ANY(${[unknown.receiptId,complete.receiptId,used.receiptId]}::bigint[]) ORDER BY id`).map(r => [r.status,r.attempts]),[['unknown',2],['failed',1],['failed',2]]);
});

test("a handoff audit failure rolls the resumed body and queue back without consuming the old release", async () => {
  const f = await fixture('rollback',{ receiptState: 'failed' }); const releaseAuditId = await oldRelease(f.receiptId);
  const before = await state(f.id); const name = `fail_body_handoff_${tag()}`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='receipt.body-resumed' AND NEW.subject='receipt:${f.receiptId}' THEN RAISE EXCEPTION 'fixture refuses body handoff audit'; END IF;
    RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try { await assert.rejects(resumeReleasedBodyHandoffs(),/fixture refuses body handoff audit/); }
  finally { await sql.unsafe(`DROP TRIGGER ${name} ON audit_log`); await sql.unsafe(`DROP FUNCTION ${name}()`); }
  assert.deepEqual(await state(f.id),before); assert.equal((await jobs(f.id)).length,0);
  assert.equal((await sql`SELECT id FROM audit_log WHERE action='receipt.body-resumed' AND subject=${'receipt:' + f.receiptId}`).length,0);
  await resumeReleasedBodyHandoffs();
  assert.equal((await sql`SELECT after->>'releaseAuditId' AS id FROM audit_log WHERE action='receipt.body-resumed' AND subject=${'receipt:' + f.receiptId}`)[0].id,String(releaseAuditId));
});

test("200 nonfetchable old releases cannot starve a later fetchable body handoff", async () => {
  const paused = Array.from({ length: 200 },(_,i) => `${prefix}-nonfetch-${i}`); ids.push(...paused);
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,body_status,processing_state)
    SELECT x.id,${source},x.id,'https://x.com/example/status/'||x.id,'Nonfetchable body',now()-interval '1 minute',now(),now(),
      'unconfirmed','analyzed' FROM unnest(${paused}::text[]) AS x(id)`;
  const saved = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,attempts,request,created_at,updated_at)
    SELECT a.id,'jina','body_fallback','article:'||a.id,'failed',1,jsonb_build_object('url',a.url),now()-interval '2 hours',now()-interval '1 hour'
    FROM articles a WHERE a.id=ANY(${paused}::text[]) RETURNING id`;
  receiptIds.push(...saved.map(r => r.id));
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,started_at,finished_at)
    SELECT r.id,1,'jina','failed',now()-interval '2 hours',now()-interval '1 hour' FROM receipts r WHERE r.id=ANY(${saved.map(r => r.id)}::bigint[])`;
  await sql`INSERT INTO audit_log(actor,action,subject,reason,before,after)
    SELECT 'ops.recover','receipt.release','receipt:'||r.id,'Old false handoff','{"status":"unknown"}'::jsonb,
      '{"status":"failed","billed":null,"requeued":false}'::jsonb FROM receipts r WHERE r.id=ANY(${saved.map(r => r.id)}::bigint[])`;
  const allowed = await fixture('after-nonfetch',{ receiptState: 'failed' }); await oldRelease(allowed.receiptId);
  invalidateRecentContentCache(); await resumeReleasedBodyHandoffs();
  assert.equal((await jobs(allowed.id)).length,1);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE data->>'articleId'=ANY(${paused}::text[])`).length,0);
});

test("a later different receipt for this article or URL consumes the old release and retains real provider cooldowns", async () => {
  for (const same of ['article','url']) {
    const f = await fixture('cross-receipt-' + same,{ receiptState: 'failed' }); await oldRelease(f.receiptId);
    const [later] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,attempts,request)
      VALUES(${f.id + '-new-day'},'jina','body_fallback',${same === 'article' ? 'article:' + f.id : 'article:different-material'},
        'failed',1,${sql.json({ url: same === 'url' ? f.url : f.url + '/changed' })}) RETURNING id`;
    receiptIds.push(later.id);
    await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status,started_at,finished_at)
      VALUES(${later.id},1,'jina','failed',clock_timestamp(),clock_timestamp())`;
    await sql`UPDATE articles SET processing_retry_at=now()+interval '1 hour',processing_error='extract: jina HTTP 429' WHERE id=${f.id}`;
    const cooling = await state(f.id); await resumeReleasedBodyHandoffs();
    assert.deepEqual(await state(f.id),cooling); assert.equal((await jobs(f.id)).length,0);
    await sql`UPDATE articles SET processing_retry_at=NULL WHERE id=${f.id}`;
    const elapsed = await state(f.id); await resumeReleasedBodyHandoffs();
    assert.deepEqual(await state(f.id),elapsed); assert.equal((await jobs(f.id)).length,0);
    assert.equal((await sql`SELECT attempts FROM receipts WHERE id=${f.receiptId}`)[0].attempts,1);
  }
});
