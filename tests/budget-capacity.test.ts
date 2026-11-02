// Wake only durable numeric-capacity waits. No provider or model is registered or called.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { wakeLlmBudgetWaits } from "@aihot/backend/jobs/budget-capacity";
import { RECENT_CONTENT_POLICY_KEY, invalidateRecentContentCache } from "@aihot/backend/jobs/recent-content";
import { TEMPORARY_LLM_BUDGET_KEY } from "@aihot/backend/providers/temporary-budget";

const T = tag();
const source = `budget-capacity-${T}`;
const prefix = `budget-wake-${T}-`;
const keys = [RECENT_CONTENT_POLICY_KEY, TEMPORARY_LLM_BUDGET_KEY];
type SavedBudget = { enabled: boolean; per_minute: number; per_hour: number; per_day: number; note: string | null; at: string };
type SavedSetting = { key: string; value: unknown; updated_by: string | null; at: string };
type SavedArticle = { id: string; retry_at: string | null; queued_at: string | null };
type SavedEvent = { queue: string; singleton_key: string; retry_at: string; updated_at: string };
let budgetBefore: SavedBudget | undefined;
let settingsBefore: SavedSetting[] = [];
let otherArticles: SavedArticle[] = [];
let otherEvents: SavedEvent[] = [];
let auditBaseline = 0;
const receipts: number[] = [];
const facts: number[] = [];
const stories: number[] = [];

before(async () => {
  [budgetBefore] = await sql`SELECT enabled,per_minute,per_hour,per_day,note,updated_at::text AS at FROM budgets WHERE service='llm'`;
  settingsBefore = await sql`SELECT key,value,updated_by,updated_at::text AS at FROM settings WHERE key=ANY(${keys}::text[])`;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${source},'Budget capacity fixture','rss','T1','editorial','2100-01-01')`;
});

beforeEach(async () => {
  // Existing fixtures share this disposable database. Preserve their durable wait dates exactly.
  otherArticles = await sql`SELECT id,processing_retry_at::text AS retry_at,processing_queued_at::text AS queued_at
    FROM articles WHERE source_id<>${source} AND processing_state='new' AND processing_retry_at>now()
      AND processing_error ~ '^(extract: )?Budget for llm exhausted [(](minute|hour|day|temporary|stopped)[)]$'`;
  otherEvents = await sql`SELECT queue,singleton_key,retry_at::text,updated_at::text FROM event_job_deferrals
    WHERE singleton_key NOT LIKE ${prefix + "%"} AND retry_at>now()
      AND reason ~ '^Budget for llm exhausted [(](minute|hour|day|temporary|stopped)[)]$'`;
  [ { id: auditBaseline } ] = await sql`SELECT coalesce(max(id),0)::bigint AS id FROM audit_log`;
  await sql`DELETE FROM settings WHERE key=ANY(${keys}::text[])`;
  await sql`INSERT INTO settings(key,value,updated_by) VALUES(${RECENT_CONTENT_POLICY_KEY},'{"enabled":true}','budget-capacity-test')`;
  await sql`INSERT INTO budgets(service,enabled,per_minute,per_hour,per_day,note) VALUES('llm',false,0,0,0,'disabled fixture')
    ON CONFLICT(service) DO UPDATE SET enabled=false,per_minute=0,per_hour=0,per_day=0,note='disabled fixture',updated_at=clock_timestamp()`;
  invalidateRecentContentCache();
});

afterEach(async () => {
  await sql`DELETE FROM event_job_deferrals WHERE singleton_key LIKE ${prefix + "%"}`;
  await sql`DELETE FROM facts WHERE id=ANY(${facts}::bigint[])`;
  await sql`DELETE FROM stories WHERE id=ANY(${stories}::bigint[])`;
  facts.length = 0;
  stories.length = 0;
  await sql`DELETE FROM articles WHERE source_id=${source}`;
  await sql`DELETE FROM receipts WHERE id=ANY(${receipts}::bigint[])`;
  receipts.length = 0;
  await sql`DELETE FROM audit_log WHERE action='content.capacity-wake' AND id>${auditBaseline}`;
  if (otherArticles.length) await sql`UPDATE articles a SET processing_retry_at=r.retry_at,processing_queued_at=r.queued_at
    FROM jsonb_to_recordset(${sql.json(otherArticles)}) AS r(id text,retry_at timestamptz,queued_at timestamptz) WHERE a.id=r.id`;
  if (otherEvents.length) await sql`UPDATE event_job_deferrals d SET retry_at=r.retry_at,updated_at=r.updated_at
    FROM jsonb_to_recordset(${sql.json(otherEvents)}) AS r(queue text,singleton_key text,retry_at timestamptz,updated_at timestamptz)
    WHERE d.queue=r.queue AND d.singleton_key=r.singleton_key`;
  invalidateRecentContentCache();
});

after(async () => {
  await sql`DELETE FROM sources WHERE id=${source}`;
  await sql`DELETE FROM settings WHERE key=ANY(${keys}::text[])`;
  for (const row of settingsBefore) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${row.key},${sql.json(row.value as never)},${row.updated_by},${row.at}::timestamptz)`;
  if (budgetBefore) await sql`UPDATE budgets SET enabled=${budgetBefore.enabled},per_minute=${budgetBefore.per_minute},
    per_hour=${budgetBefore.per_hour},per_day=${budgetBefore.per_day},note=${budgetBefore.note},updated_at=${budgetBefore.at}::timestamptz
    WHERE service='llm'`;
  else await sql`DELETE FROM budgets WHERE service='llm'`;
  invalidateRecentContentCache();
  await closeDb();
});

async function material(name: string, error: string, { minutes = 1, state = "new" } = {}) {
  const id = prefix + name;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,body_status,
    processing_state,processing_error,processing_attempts,processing_retry_at,processing_queued_at)
    VALUES(${id},${source},${id},${`https://example.test/${id}`},'Local capacity fixture',now()-${minutes}*interval '1 minute',
      now(),now(),'ok',${state},${error},2,now()+interval '2 hours',now()-interval '1 hour')`;
  return id;
}

async function event(name: string, reason: string, remaining = 2) {
  const key = prefix + name;
  await sql`INSERT INTO event_job_deferrals(queue,singleton_key,data,retry_at,remaining_retries,reason,generation,queued_at)
    VALUES('events.group',${key},${sql.json({ articleId: key })},now()+interval '2 hours',${remaining},${reason},3,now()-interval '1 hour')`;
  return key;
}

async function attempts() {
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,purpose,status,attempts)
    VALUES(${prefix + "counted-" + receipts.length},'llm','budget_capacity_fixture','completed',3) RETURNING id`;
  receipts.push(receipt.id);
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,status)
    VALUES(${receipt.id},1,'llm','received'),(${receipt.id},2,'llm','unknown'),(${receipt.id},3,'llm','failed')`;
}

async function digest(name: string, articleId: string) {
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories(public_id,title,origin)
    VALUES(${randomUUID()},'Local digest fixture','manual') RETURNING id`;
  stories.push(story.id);
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title,manual)
    VALUES(${prefix + name + "-fact"},${story.id},'Local supporting fact',true) RETURNING id`;
  facts.push(fact.id);
  await sql`INSERT INTO fact_articles(fact_id,article_id) VALUES(${fact.id},${articleId})`;
  const key = prefix + name;
  await sql`INSERT INTO event_job_deferrals(queue,singleton_key,data,retry_at,remaining_retries,reason,generation)
    VALUES('events.digest',${key},${sql.json({ storyId: story.id })},now()+interval '2 hours',2,
      'Budget for llm exhausted (day)',5)`;
  return key;
}

const usage = () => sql`SELECT id,receipt_id,attempt,status,origin,started_at::text FROM receipt_attempts WHERE service='llm' ORDER BY id`;
const articleRows = () => sql`SELECT * FROM articles WHERE source_id=${source} ORDER BY id`;
const eventRows = () => sql`SELECT * FROM event_job_deferrals WHERE singleton_key LIKE ${prefix + "%"} ORDER BY singleton_key`;

test("disabled limits wake only recent new numeric waits, including temporary and stopped, without requests or count resets", async () => {
  await attempts();
  const admitted: string[] = [];
  for (const period of ["minute","hour","day","temporary","stopped"]) {
    admitted.push(await material(`allowed-${period}`,`${period === "temporary" ? "extract: " : ""}Budget for llm exhausted (${period})`));
  }
  const excluded = [
    await material("old","Budget for llm exhausted (day)",{ minutes: 2881 }),
    await material("failed","Budget for llm exhausted (day)",{ state: "failed" }),
    await material("unknown","receipt 123 outcome unknown"),
    await material("provider429","HTTP 429: provider rate limit"),
    await material("credits","Budget for llm exhausted (credits)"),
    await material("suffix","Budget for llm exhausted (day): provider returned 403"),
  ];
  const before = await articleRows();
  const countsBefore = await usage();
  const receiptIdsBefore = await sql`SELECT id FROM receipts ORDER BY id`;
  const result = await wakeLlmBudgetWaits();
  assert.ok(result.articles >= admitted.length);
  const after = await articleRows();
  for (const id of admitted) {
    const old = before.find(row => row.id === id)!;
    const row = after.find(row => row.id === id)!;
    assert.ok(row.processing_retry_at < old.processing_retry_at);
    assert.ok(row.processing_retry_at.getTime() <= Date.now()+1000);
    assert.equal(row.processing_queued_at,null);
    assert.deepEqual({ ...row,processing_retry_at: old.processing_retry_at,processing_queued_at: old.processing_queued_at },old);
  }
  for (const id of excluded) assert.deepEqual(after.find(row => row.id === id),before.find(row => row.id === id));
  assert.deepEqual(await usage(),countsBefore);
  assert.deepEqual(await sql`SELECT id FROM receipts ORDER BY id`,receiptIdsBefore);
});

test("event numeric waits become due without replenishing real-error retries; other failures stay untouched", async () => {
  await material("event-numeric","ready event input",{ state: "analyzed" });
  await material("event-stopped","ready event input",{ state: "analyzed" });
  const numeric = await event("event-numeric","Budget for llm exhausted (temporary)",1);
  const stopped = await event("event-stopped","Budget for llm exhausted (stopped)",0);
  await material("event-outside","ready old input",{ minutes: 2881,state: "analyzed" });
  await event("event-outside","Budget for llm exhausted (day)");
  for (const [name,reason] of [
    ["event-unknown","receipt 123 outcome unknown"], ["event-provider","HTTP 429: provider rate limit"],
    ["event-credits","Budget for llm exhausted (credits)"], ["event-busy","Receipt 123 is in flight"],
  ]) {
    await material(name,"ready event input",{ state: "analyzed" });
    await event(name,reason);
  }
  const before = await eventRows();
  const countsBefore = await usage();
  await wakeLlmBudgetWaits();
  const after = await eventRows();
  for (const old of before) {
    const row = after.find(value => value.singleton_key === old.singleton_key)!;
    if ([numeric,stopped].includes(old.singleton_key)) {
      assert.ok(row.retry_at < old.retry_at);
      assert.ok(row.retry_at.getTime() <= Date.now()+1000);
      assert.deepEqual({ ...row,retry_at: old.retry_at,updated_at: old.updated_at },old);
    } else assert.deepEqual(row,old);
  }
  assert.equal(after.find(row => row.singleton_key === numeric)!.remaining_retries,1);
  assert.equal(after.find(row => row.singleton_key === stopped)!.remaining_retries,0);
  assert.deepEqual(await usage(),countsBefore);
});

test("enabled exhausted or zero budgets cannot wake article or event waits", async () => {
  await attempts();
  await material("enabled-wait","Budget for llm exhausted (day)");
  await material("enabled-event","ready event input",{ state: "analyzed" });
  await event("enabled-event","Budget for llm exhausted (day)");
  await sql`UPDATE budgets SET enabled=true,per_minute=10000,per_hour=10000,per_day=1 WHERE service='llm'`;
  const articlesBefore = await articleRows();
  const eventsBefore = await eventRows();
  const countsBefore = await usage();
  assert.deepEqual(await wakeLlmBudgetWaits(),{ articles: 0,events: 0 });
  await sql`UPDATE budgets SET per_minute=0,per_hour=0,per_day=0 WHERE service='llm'`;
  assert.deepEqual(await wakeLlmBudgetWaits(),{ articles: 0,events: 0 });
  assert.deepEqual(await articleRows(),articlesBefore);
  assert.deepEqual(await eventRows(),eventsBefore);
  assert.deepEqual(await usage(),countsBefore);
});

test("digest waits wake only when their fact evidence belongs to the recent ranked scope", async () => {
  const recent = await material("digest-recent-input","ready digest input",{ state: "analyzed" });
  const old = await material("digest-old-input","ready old digest input",{ minutes: 2881,state: "analyzed" });
  const admitted = await digest("digest-admitted",recent);
  const outside = await digest("digest-outside",old);
  const before = await eventRows();
  const countsBefore = await usage();
  await wakeLlmBudgetWaits();
  const after = await eventRows();
  const admittedBefore = before.find(row => row.singleton_key === admitted)!;
  const admittedAfter = after.find(row => row.singleton_key === admitted)!;
  assert.ok(admittedAfter.retry_at < admittedBefore.retry_at);
  assert.deepEqual({ ...admittedAfter,retry_at: admittedBefore.retry_at,updated_at: admittedBefore.updated_at },admittedBefore);
  assert.deepEqual(after.find(row => row.singleton_key === outside),before.find(row => row.singleton_key === outside));
  assert.deepEqual(await usage(),countsBefore);
});
