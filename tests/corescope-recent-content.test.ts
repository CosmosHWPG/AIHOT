// The bounded news scope preserves publication dates, source roles and paid work already in progress.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { closeDb, sql, type Db } from "@aihot/backend/db";
import { enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { processArticle, queueProcessing } from "@aihot/backend/jobs/content";
import { config } from "@aihot/backend/config";
import { MODELS } from "@aihot/backend/providers/llm";
import {
  RECENT_CONTENT_POLICY_KEY, getRecentContentPolicy, getRecentContentPriority, getRecentContentScope,
  invalidateRecentContentCache, reprioritizeRecentContentJobs, setRecentContentPolicy,
} from "@aihot/backend/jobs/recent-content";

const T = tag();
const sources = { editorial: `recent-editorial-${T}`, hot_signal: `recent-signal-${T}`, isolated: `recent-isolated-${T}` };
let saved: Array<{ value: unknown; updated_by: string | null; updated_at: Date }> = [];
let savedJobPriorities: Array<{ id: string; priority: number }> = [];
const ids: string[] = [];
before(async () => {
  saved = await sql`SELECT value,updated_by,updated_at FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  await getBoss();
  savedJobPriorities = await sql`SELECT id,priority FROM pgboss.job
    WHERE name IN('content.analyze','content.extract-body','events.group') AND state IN('created','retry')`;
  for (const [mode, id] of Object.entries(sources)) await sql`
    INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${id},'Recent content fixture','rss','T1',${mode},'2100-01-01')`;
});

afterEach(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`DELETE FROM articles WHERE source_id=ANY(${Object.values(sources)}::text[])`;
  ids.length = 0;
  invalidateRecentContentCache();
});

after(async () => {
  if (savedJobPriorities.length) await sql`UPDATE pgboss.job j SET priority=r.priority
    FROM jsonb_to_recordset(${sql.json(savedJobPriorities)}) AS r(id uuid,priority integer)
    WHERE j.id=r.id AND j.state IN('created','retry')`;
  await sql`DELETE FROM sources WHERE id=ANY(${Object.values(sources)}::text[])`;
  await sql`DELETE FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  for (const row of saved) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${RECENT_CONTENT_POLICY_KEY},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  invalidateRecentContentCache();
  await stopBoss();
  await closeDb();
});

async function fixture(name: string, minutes = 0, mode: keyof typeof sources = "editorial", db: Db = sql, state = "new") {
  const id = `recent-${T}-${name}`;
  ids.push(id);
  await db`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,processing_state,body_status)
    VALUES(${id},${sources[mode]},${id},${`https://example.test/${id}`},'Local recent fixture',
      now()-${minutes}*interval '1 minute',now(),now(),${state},'ok')`;
  return id;
}

test("a missing or disabled policy preserves existing processing and enabling is audited without changing budgets", async () => {
  await sql`DELETE FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  assert.equal((await getRecentContentPolicy()).enabled, false);
  const old = await fixture("disabled-old", 60 * 24 * 30);
  assert.deepEqual((({ reason, allowed, priority }) => ({ reason, allowed, priority }))(await getRecentContentPriority(old)),
    { reason: "disabled", allowed: true, priority: null });
  const budgets = await sql`SELECT * FROM budgets ORDER BY service`;
  await assert.rejects(setRecentContentPolicy(true, "test", " "), /reason is required/);
  await setRecentContentPolicy(true, "test", "process recent source materials");
  const policy = await getRecentContentPolicy();
  assert.equal(policy.enabled, true);
  assert.equal(policy.windowHours, 48);
  assert.equal(policy.maxRecords, 2000);
  assert.deepEqual(await sql`SELECT * FROM budgets ORDER BY service`, budgets);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log
    WHERE action='content.recent-processing' AND subject=${`settings:${RECENT_CONTENT_POLICY_KEY}`} AND reason='process recent source materials'`)[0].n, 1);
});

test("only trusted publication dates within 48 hours qualify; recent discovery never admits history", async () => {
  await setRecentContentPolicy(true, "test", "publication date window");
  await sql.begin(async tx => {
    const now = await fixture("now", 0, "editorial", tx);
    const signal = await fixture("signal", 1, "hot_signal", tx);
    const old = await fixture("old", 2880.001, "editorial", tx);
    const edge = await fixture("edge", 2880, "editorial", tx);
    const future = await fixture("future", -1, "editorial", tx);
    const unknown = await fixture("unknown", 0, "editorial", tx);
    const isolated = await fixture("isolated", 0, "isolated", tx);
    await tx`UPDATE articles SET published_at=NULL WHERE id=${unknown}`;
    assert.equal((await getRecentContentPriority(now, { db: tx })).allowed, true);
    assert.equal((await getRecentContentPriority(signal, { db: tx })).allowed, true);
    assert.equal((await getRecentContentPriority(old, { db: tx })).reason, "outside-window");
    assert.notEqual((await getRecentContentPriority(edge, { db: tx })).reason, "outside-window", "the exact 48h boundary is inclusive");
    assert.equal((await getRecentContentPriority(future, { db: tx })).reason, "future-publication");
    assert.equal((await getRecentContentPriority(unknown, { db: tx })).reason, "unknown-publication");
    assert.equal((await getRecentContentPriority(isolated, { db: tx })).reason, "isolated");
    assert.equal((await getRecentContentPriority("does-not-exist", { db: tx })).reason, "missing");
    assert.deepEqual((await tx`SELECT participation_mode FROM sources WHERE id=ANY(${Object.values(sources)}::text[]) ORDER BY participation_mode`).map(r => r.participation_mode),
      ["editorial", "hot_signal", "isolated"]);
  });
});

test("all article states occupy the latest 2000 before pending filtering, and isolated resources consume no slots", async () => {
  await setRecentContentPolicy(true, "test", "all states before pending");
  await sql.begin(async tx => {
    const records = Array.from({ length: 2000 }, (_, i) => ({ id: `recent-${T}-rank-${String(i).padStart(4, "0")}` }));
    ids.push(...records.map(r => r.id));
    await tx`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,processing_state,body_status)
      SELECT r.id,${sources.editorial},r.id,'https://example.test/'||r.id,'Completed local fixture',now(),now(),now(),
        CASE WHEN right(r.id,1) IN('0','1','2','3','4') THEN 'analyzed' ELSE 'blocked' END,'ok'
      FROM jsonb_to_recordset(${tx.json(records)}) AS r(id text)`;
    const pending = await fixture("rank-pending", 1, "editorial", tx);
    const resource = await fixture("rank-resource", 0, "isolated", tx);
    const scope = await getRecentContentScope({ db: tx });
    assert.equal(scope.rows.length, 2000);
    assert.deepEqual(scope.rows.map(r => r.id), records.map(r => r.id).reverse());
    assert.equal(scope.rows[0].priority, 12000);
    assert.equal(scope.rows.at(-1)!.priority, 10001);
    assert.equal((await getRecentContentPriority(pending, { db: tx })).reason, "outside-latest-2000");
    assert.equal((await getRecentContentPriority(resource, { db: tx })).reason, "isolated");
    assert.equal((await tx`SELECT processing_state FROM articles WHERE id=${pending}`)[0].processing_state, "new");
  });
});

test("cross-process policy switches invalidate cached scopes and transaction inserts stay visible", async () => {
  await setRecentContentPolicy(true, "test", "cache switching");
  const first = await fixture("cache-first", 2);
  await getRecentContentScope();
  await sql`UPDATE settings SET value='{"enabled":false}',updated_at=clock_timestamp() WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  assert.equal((await getRecentContentPriority(first)).reason, "disabled");
  const latest = await fixture("cache-new", 0);
  await sql`UPDATE settings SET value='{"enabled":true}',updated_at=clock_timestamp() WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  assert.equal((await getRecentContentPriority(latest)).allowed, true);
  assert.ok((await getRecentContentScope()).rows.find(r => r.id === latest));
  await sql.begin(async tx => {
    const own = await fixture("uncommitted", 0, "editorial", tx);
    assert.ok((await getRecentContentScope({ db: tx })).rows.find(r => r.id === own));
    assert.equal((await getRecentContentPriority(own, { db: tx })).allowed, true);
  });
  await sql`UPDATE sources SET participation_mode='isolated' WHERE id=${sources.editorial}`;
  assert.equal((await getRecentContentPriority(first)).reason, "isolated");
  await sql`UPDATE sources SET participation_mode='editorial' WHERE id=${sources.editorial}`;
});

test("queue reordering preserves active jobs, retry times, paid identities and article publication flags", async () => {
  await setRecentContentPolicy(true, "test", "reorder pending queue");
  const newer = await fixture("queue-new", 1);
  const older = await fixture("queue-old", 2881);
  const active = await fixture("queue-active", 2);
  assert.ok(await enqueue(QUEUES.analyze, { articleId: newer, attemptTag: "existing-paid-identity" },
    { singletonKey: newer, priority: -2, startAfter: 600 }));
  assert.ok(await enqueue(QUEUES.extractBody, { articleId: older }, { singletonKey: older, priority: 0, startAfter: 600 }));
  assert.ok(await enqueue(QUEUES.group, { articleId: active }, { singletonKey: active, priority: 123 }));
  await sql`UPDATE pgboss.job SET state='active',started_on=now() WHERE data->>'articleId'=${active}`;
  await sql`UPDATE articles SET processing_retry_at=now()+interval '2 hours',processing_attempt_tag='existing-paid-identity'
    WHERE id=${newer}`;
  const articlesBefore = await sql`SELECT * FROM articles WHERE id=ANY(${ids}::text[]) ORDER BY id`;
  const jobsBefore = await sql`SELECT * FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[]) ORDER BY id`;
  const result = await reprioritizeRecentContentJobs();
  assert.ok(result.eligible >= 1);
  assert.ok(result.outside >= 1);
  assert.ok(result.activeUntouched >= 1);
  const jobsAfter = await sql`SELECT * FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[]) ORDER BY id`;
  for (const before of jobsBefore) {
    const after = jobsAfter.find(j => j.id === before.id)!;
    assert.equal(after.start_after.getTime(), before.start_after.getTime());
    assert.deepEqual(after.data, before.data);
    if (before.state === "active") assert.deepEqual(after, before);
  }
  assert.ok(jobsAfter.find(j => j.data.articleId === newer)!.priority > 10000);
  assert.equal(jobsAfter.find(j => j.data.articleId === older)!.priority, -10000);
  assert.deepEqual(await sql`SELECT * FROM articles WHERE id=ANY(${ids}::text[]) ORDER BY id`, articlesBefore);
  await setRecentContentPolicy(false, "test", "restore prior processing policy");
  await reprioritizeRecentContentJobs();
  assert.equal((await sql`SELECT priority FROM pgboss.job WHERE data->>'articleId'=${newer}`)[0].priority, 0);
});

test("queueProcessing rejects old material before changing article state, queue markers or receipt identity", async () => {
  await setRecentContentPolicy(true, "test", "producer admission integration");
  const old = await fixture("producer-old", 2881);
  await sql`UPDATE articles SET processing_queued_at=now()-interval '2 days',processing_retry_at=now()+interval '2 hours',
    processing_attempts=2,processing_error='existing capacity wait',processing_attempt_tag='original-paid-identity' WHERE id=${old}`;
  const before = await sql`SELECT * FROM articles WHERE id=${old}`;
  const receiptsBefore = await sql`SELECT id FROM receipts WHERE subject=${`article:${old}@1`}`;
  assert.equal(await queueProcessing(old, { step: "analyze", attemptTag: "must-not-replace-paid-identity" }), null);
  assert.deepEqual(await sql`SELECT * FROM articles WHERE id=${old}`, before);
  assert.deepEqual(await sql`SELECT id FROM receipts WHERE subject=${`article:${old}@1`}`, receiptsBefore);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE data->>'articleId'=${old}`).length, 0);
});

test("direct processArticle cannot bypass old, unknown or future publication admission or send model calls", async () => {
  await setRecentContentPolicy(true, "test", "direct processing admission integration");
  const old = await fixture("consumer-old", 2881);
  const unknown = await fixture("consumer-unknown", 1);
  const future = await fixture("consumer-future", -1);
  await sql`UPDATE articles SET published_at=NULL WHERE id=${unknown}`;
  await sql`UPDATE articles SET body_text=${"AI lab launches a model with benchmark results and published pricing. ".repeat(10)}
    WHERE id=ANY(${[old, unknown, future]}::text[])`;
  const before = await sql`SELECT * FROM articles WHERE id=ANY(${[old, unknown, future]}::text[]) ORDER BY id`;
  const receiptsBefore = await sql`SELECT id FROM receipts WHERE subject=ANY(${[old, unknown, future].map(id => `article:${id}@1`)}::text[])`;
  // Any accidental request is captured locally, with real-model valves restored in finally.
  const provider = await stub(() => new Reply(503, { error: "unexpected local model call" }));
  const enabledBefore = config.modelCallsEnabled;
  const envKeys = new Set(Object.values(MODELS).flatMap(model => [model.baseUrlEnv, model.apiKeyEnv]));
  const envBefore = [...envKeys].map(key => ({ key, value: process.env[key] }));
  try {
    config.modelCallsEnabled = true;
    for (const model of Object.values(MODELS)) {
      process.env[model.baseUrlEnv] = `${provider.url}/v1`;
      process.env[model.apiKeyEnv] = "test-key";
    }
    for (const id of [old, unknown, future]) assert.deepEqual(await processArticle(id), { state: "outside-priority-window" });
    assert.equal(provider.hits(), 0);
    assert.deepEqual(await sql`SELECT * FROM articles WHERE id=ANY(${[old, unknown, future]}::text[]) ORDER BY id`, before);
    assert.deepEqual(await sql`SELECT id FROM receipts WHERE subject=ANY(${[old, unknown, future].map(id => `article:${id}@1`)}::text[])`, receiptsBefore);
    assert.equal((await sql`SELECT id FROM analyses WHERE article_id=ANY(${[old, unknown, future]}::text[])`).length, 0);
  } finally {
    config.modelCallsEnabled = enabledBefore;
    for (const { key, value } of envBefore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await provider.close();
  }
});

test("queueProcessing orders admitted news newest first while isolated settlement keeps resource publication rules", async () => {
  await setRecentContentPolicy(true, "test", "news ordering and resource integration");
  const older = await fixture("producer-older-news", 2);
  const newer = await fixture("producer-newer-news", 1);
  const resource = await fixture("producer-resource", 0, "isolated");
  const sourceBefore = await sql`SELECT * FROM sources WHERE id=${sources.isolated}`;
  const budgetsBefore = await sql`SELECT * FROM budgets ORDER BY service`;
  assert.ok(await queueProcessing(older));
  assert.ok(await queueProcessing(newer));
  assert.ok(await queueProcessing(resource));
  const jobs = await sql`SELECT name,data,priority FROM pgboss.job WHERE data->>'articleId'=ANY(${[older,newer,resource]}::text[])`;
  const newJob = jobs.find(job => job.data.articleId === newer)!;
  const oldJob = jobs.find(job => job.data.articleId === older)!;
  assert.equal(newJob.name, QUEUES.analyze);
  assert.equal(oldJob.name, QUEUES.analyze);
  assert.ok(newJob.priority > oldJob.priority);
  assert.ok(oldJob.priority > 10000);
  assert.equal(jobs.find(job => job.data.articleId === resource)!.name, QUEUES.group);
  assert.deepEqual(await processArticle(resource), { state: "skipped" });
  const [publication] = await sql`SELECT eligible,selected FROM publications WHERE article_id=${resource}`;
  assert.ok(publication);
  assert.equal(publication.eligible, false);
  assert.equal(publication.selected, false);
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${resource}`)[0].processing_state, "skipped");
  assert.deepEqual(await sql`SELECT * FROM sources WHERE id=${sources.isolated}`, sourceBefore);
  assert.deepEqual(await sql`SELECT * FROM budgets ORDER BY service`, budgetsBefore);
  assert.equal((await sql`SELECT id FROM receipts WHERE subject=${`article:${resource}@1`}`).length, 0);
});
