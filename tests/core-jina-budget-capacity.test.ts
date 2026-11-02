// A disabled local count budget can end its own cooldown, without queuing or calling a provider.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { updateBudget } from "@aihot/backend/admin/settings";
import { wakeJinaBudgetWaits } from "@aihot/backend/jobs/budget-capacity";
import { enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { invalidateRecentContentCache, RECENT_CONTENT_POLICY_KEY } from "@aihot/backend/jobs/recent-content";
import { applyRecoveryBatch, planRecoveryBatch, RECOVERY_BATCH_PREFIX } from "@aihot/backend/jobs/processing-recovery";

const T = tag();
const prefix = `jina-wake-${T}`;
const source = `${prefix}-rss`;
const ids: string[] = [];
const batchIds: string[] = [];
const receiptIds: number[] = [];
type Budget = { enabled: boolean; per_minute: number; per_hour: number; per_day: number; note: string | null; updated_at: string };
let savedBudget: Budget | undefined;
let savedPolicy: Array<{ value: unknown; updated_by: string | null; updated_at: string }> = [];
let otherWaits: Array<{ id: string; retry_at: string }> = [];
let auditBaseline = 0;
before(async () => {
  [savedBudget] = await sql`SELECT enabled,per_minute,per_hour,per_day,note,updated_at::text FROM budgets WHERE service='jina'`;
  assert.ok(savedBudget);
  savedPolicy = await sql`SELECT value,updated_by,updated_at::text FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  await getBoss();
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${source},'Offline Jina quota wake','rss','T1','editorial','2100-01-01')`;
});
beforeEach(async () => {
  otherWaits = await sql`SELECT id,processing_retry_at::text AS retry_at FROM articles WHERE source_id<>${source}
    AND processing_retry_at>now() AND processing_error ~ '^extract: Budget for jina exhausted [(](minute|hour|day|stopped)[)]$'`;
  [{ id: auditBaseline }] = await sql`SELECT coalesce(max(id),0)::bigint AS id FROM audit_log`;
  await sql`INSERT INTO settings(key,value,updated_by) VALUES(${RECENT_CONTENT_POLICY_KEY},'{"enabled":true}','jina-wake-test')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`;
  await sql`UPDATE budgets SET enabled=true,per_minute=123,per_hour=456,per_day=789 WHERE service='jina'`;
  invalidateRecentContentCache();
});
afterEach(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`DELETE FROM settings WHERE key=ANY(${batchIds.map(id => RECOVERY_BATCH_PREFIX + id)}::text[])`;
  await sql`DELETE FROM articles WHERE source_id=${source}`;
  await sql`DELETE FROM receipts WHERE id=ANY(${receiptIds}::bigint[])`;
  await sql`DELETE FROM audit_log WHERE id>${auditBaseline} AND subject='budget:jina'`;
  if (otherWaits.length) await sql`UPDATE articles a SET processing_retry_at=w.retry_at
    FROM jsonb_to_recordset(${sql.json(otherWaits)}) AS w(id text,retry_at timestamptz) WHERE a.id=w.id`;
  await sql`UPDATE sources SET enabled=true,participation_mode='editorial',config='{}'::jsonb WHERE id=${source}`;
  ids.length = 0; batchIds.length = 0; receiptIds.length = 0;
  invalidateRecentContentCache();
});
after(async () => {
  await sql`DELETE FROM sources WHERE id=${source}`;
  await sql`DELETE FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  for (const row of savedPolicy) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${RECENT_CONTENT_POLICY_KEY},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  if (savedBudget) await sql`UPDATE budgets SET enabled=${savedBudget.enabled},per_minute=${savedBudget.per_minute},
    per_hour=${savedBudget.per_hour},per_day=${savedBudget.per_day},note=${savedBudget.note},updated_at=${savedBudget.updated_at} WHERE service='jina'`;
  await stopBoss(); await closeDb();
});
async function article(name: string, options: { error?: string; state?: string; body?: string; minutes?: number } = {}) {
  const id = `${prefix}-${name}`; ids.push(id);
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,body_status,
    processing_state,processing_error,processing_retry_at,processing_attempts,processing_attempt_tag)
    VALUES(${id},${source},${id},${'https://www.example.com/' + id},'Quota fixture',now()-${options.minutes ?? 1}*interval '1 minute',
      now(),now(),${options.body ?? 'pending'},${options.state ?? 'new'},${options.error ?? 'extract: Budget for jina exhausted (day)'},
      now()+interval '1 hour',2,'retained-evaluation')`;
  return id;
}
const state = async (id: string) => (await sql`SELECT processing_retry_at,processing_queued_at,processing_state,body_status,
  processing_error,processing_attempts,processing_attempt_tag FROM articles WHERE id=${id}`)[0]!;
const budget = async () => (await sql`SELECT enabled,per_minute,per_hour,per_day FROM budgets WHERE service='jina'`)[0]!;
async function receiptFor(id: string, status: "pending" | "unknown", byUrl = false) {
  const [a] = await sql`SELECT url FROM articles WHERE id=${id}`;
  const [r] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,subject,status,attempts,request)
    VALUES(${prefix + '-receipt-' + receiptIds.length},'jina','body_fallback',${byUrl ? 'article:different-subject' : 'article:' + id},
      ${status},1,${sql.json(byUrl ? { url: a!.url } : {})}) RETURNING id`;
  receiptIds.push(r.id);
}

test("switch-off wakes only local Jina numeric waits in the same transaction and preserves evidence", async () => {
  const eligible = [];
  for (const window of ["minute", "hour", "day", "stopped"]) eligible.push(await article(window, { error: `extract: Budget for jina exhausted (${window})` }));
  await sql`UPDATE articles SET processing_queued_at=now()-interval '1 minute' WHERE id=${eligible[0]}`;
  const original = await Promise.all(eligible.map(state));
  const attempts = (await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE service='jina'`)[0].n;
  const jobs = (await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE data->>'articleId'=ANY(${eligible}::text[])`)[0].n;
  await updateBudget("jina", { enabled: false,reason: "Authorized count switch-off" }, "offline-test");
  for (const [index,id] of eligible.entries()) {
    const current = await state(id);
    assert.ok(current.processing_retry_at.getTime() <= Date.now());
    assert.deepEqual({ ...current,processing_retry_at: original[index].processing_retry_at }, original[index]);
  }
  assert.deepEqual(await budget(), { enabled: false,per_minute: 123,per_hour: 456,per_day: 789 });
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE service='jina'`)[0].n, attempts);
  assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE data->>'articleId'=ANY(${eligible}::text[])`)[0].n, jobs);
  const [audit] = await sql`SELECT before,after FROM audit_log WHERE subject='budget:jina' AND action='content.capacity-wake' AND id>${auditBaseline} ORDER BY id DESC LIMIT 1`;
  assert.ok(eligible.every(id => audit.after.articleIds.includes(id)));
  assert.equal(audit.after.enabled, false);
  for (const [index,id] of eligible.entries()) {
    const previous = audit.before.waits.find((w: { articleId: string }) => w.articleId === id);
    assert.equal(Date.parse(previous.retryAt),original[index].processing_retry_at.getTime());
  }
  assert.deepEqual(await wakeJinaBudgetWaits(), { articles: 0 });
});

test("enabled budgets and an unbounded global policy do not wake; late local waits can be swept after switch-off", async () => {
  const id = await article("late"); const before = await state(id);
  assert.deepEqual(await wakeJinaBudgetWaits(), { articles: 0 });
  assert.deepEqual(await state(id), before);
  await sql`UPDATE budgets SET enabled=false WHERE service='jina'`;
  await sql`UPDATE settings SET value='{"enabled":false}' WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  assert.deepEqual(await wakeJinaBudgetWaits(), { articles: 0 });
  assert.deepEqual(await state(id), before);
  await sql`UPDATE settings SET value='{"enabled":true}' WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  await wakeJinaBudgetWaits();
  assert.ok((await state(id)).processing_retry_at.getTime() <= Date.now());
});

test("provider cooldowns, unknown/busy receipts, active jobs and nonpending/nonnew material remain untouched", async () => {
  const blocked: string[] = [];
  for (const error of ["extract: jina HTTP 401", "extract: jina HTTP 429", "extract: Receipt 42 is in flight",
    "extract: Receipt 42 has an unknown outcome", "extract: Budget for jina exhausted (credits-reserve)",
    "extract: Budget for jina exhausted (temporary)", "Budget for jina exhausted (day)",
    "extract: Budget for jina exhausted (day) extra", "extract: Budget for llm exhausted (day)"]) blocked.push(await article('error-' + blocked.length, { error }));
  for (const body of ["ok", "unconfirmed", "none"]) blocked.push(await article('body-' + body, { body }));
  for (const state of ["failed", "analyzed", "blocked", "skipped"]) blocked.push(await article('state-' + state, { state }));
  for (const status of ["pending", "unknown"] as const) {
    const id = await article('receipt-' + status); blocked.push(id); await receiptFor(id, status);
  }
  const shared = await article("shared-url-unknown"); blocked.push(shared); await receiptFor(shared,"unknown",true);
  for (const status of ["created", "active", "retry"]) {
    const id = await article('job-' + status); blocked.push(id);
    const job = await enqueue(QUEUES.extractBody, { articleId: id }, { singletonKey: id });
    assert.ok(job); await sql`UPDATE pgboss.job SET state=${status} WHERE id=${job}`;
  }
  const before = await Promise.all(blocked.map(state));
  await sql`UPDATE budgets SET enabled=false WHERE service='jina'`;
  await wakeJinaBudgetWaits();
  assert.deepEqual(await Promise.all(blocked.map(state)), before);
  assert.deepEqual((await sql`SELECT status FROM receipts WHERE id=ANY(${receiptIds}::bigint[]) ORDER BY id`).map(r => r.status), ["pending","unknown","unknown"]);
});

test("the exact admitted recovery exception is included while outside2000, old and drifted material stays paused", async () => {
  const fixed = await article("fixed", { minutes: 60,body: "unconfirmed" });
  const outside = await article("outside", { minutes: 60 });
  const old = await article("old", { minutes: 49 * 60 });
  const future = await article("future", { minutes: -60 });
  const batchId = `${prefix}-approved`; batchIds.push(batchId);
  const plan = await planRecoveryBatch({ id: batchId,kind: "web-body-recovery",articleIds: [fixed],evidence: "Exact offline fixed member" });
  await applyRecoveryBatch(plan,"offline-test","Explicit fixed webpage permission");
  await sql`UPDATE articles SET body_status='pending' WHERE id=${fixed}`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,processing_state)
    SELECT ${prefix + '-filler-'}||g,${source},${prefix + '-filler-'}||g,'https://www.example.com/filler/'||g,'Scope filler',
      now()-interval '1 minute',now(),now(),'blocked' FROM generate_series(1,2000) g`;
  invalidateRecentContentCache();
  const before = await Promise.all([outside,old,future].map(state));
  await sql`UPDATE budgets SET enabled=false WHERE service='jina'`;
  await wakeJinaBudgetWaits();
  assert.ok((await state(fixed)).processing_retry_at.getTime() <= Date.now());
  assert.deepEqual(await Promise.all([outside,old,future].map(state)),before);
  await sql`UPDATE articles SET processing_retry_at=now()+interval '1 hour' WHERE id=${fixed}`;
  await sql`UPDATE sources SET config='{"changed":true}' WHERE id=${source}`;
  const drifted = await state(fixed); await wakeJinaBudgetWaits();
  assert.deepEqual(await state(fixed),drifted);
  await sql`UPDATE sources SET config='{}',enabled=false WHERE id=${source}`;
  await wakeJinaBudgetWaits(); assert.deepEqual(await state(fixed),drifted);
  await sql`UPDATE sources SET enabled=true,participation_mode='isolated' WHERE id=${source}`;
  await wakeJinaBudgetWaits(); assert.deepEqual(await state(fixed),drifted);
});

test("a failed wake audit rolls both the budget switch and the retry change back", async () => {
  const id = await article("rollback"); const before = await state(id); const beforeBudget = await budget();
  const name = `reject_jina_wake_${T}`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.subject='budget:jina' AND NEW.action='content.capacity-wake' THEN RAISE EXCEPTION 'fixture refuses Jina wake audit'; END IF;
    RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try { await assert.rejects(updateBudget("jina",{ enabled: false,reason: "Atomic wake" },"offline-test"),/fixture refuses Jina wake audit/); }
  finally { await sql.unsafe(`DROP TRIGGER ${name} ON audit_log`); await sql.unsafe(`DROP FUNCTION ${name}()`); }
  assert.deepEqual(await state(id),before);
  assert.deepEqual(await budget(),beforeBudget);
});
