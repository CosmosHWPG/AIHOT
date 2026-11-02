import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { after, afterEach, before, test } from "node:test";
import { sql, closeDb, type Db } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { queueProcessing, sweepRecoveryBatches } from "@aihot/backend/jobs/content";
import { registerEventJobs } from "@aihot/backend/jobs/events";
import { withEventCapacity, sweepDeferredEventJobs } from "@aihot/backend/jobs/event-deferral";
import { digestReports, digestInputsHash } from "@aihot/backend/events/derived-content";
import { BudgetExceededError } from "@aihot/backend/providers/receipts";
import { enqueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { getRecentContentPolicy, getRecentContentPriority, invalidateRecentContentCache, reprioritizeRecentContentJobs,
  RECENT_CONTENT_POLICY_KEY, setRecentContentPolicy, isStoryInProcessingScope } from "@aihot/backend/jobs/recent-content";
import { advanceRecoveryExtractionRevision, applyRecoveryBatch, getRecoveryBatch, planRecoveryBatch, recoveryBatchStatus,
  recoveryPlanDigest, RECOVERY_BATCH_PREFIX, RECOVERY_PRIORITY, retryRecoveryFailures, stopRecoveryBatch } from "@aihot/backend/jobs/processing-recovery";

const T = tag();
const prefix = `recovery-batch-${T}`;
const sources = { editorial: `${prefix}-x`, hot_signal: `${prefix}-signal`, rss: `${prefix}-rss`, other: `${prefix}-other`, external: `${prefix}-external` };
const ids: string[] = [];
const batches: string[] = [];
const storyIds: number[] = [];
let savedPolicy: Array<{ value: unknown; updated_by: string | null; updated_at: Date }> = [];
before(async () => {
  config.modelCallsEnabled = false;
  savedPolicy = await sql`SELECT value,updated_by,updated_at FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  await getBoss();
  for (const [kind, id] of Object.entries(sources)) await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${id},'Fixed recovery fixture',${kind === 'external' ? 'external' : kind === 'rss' || kind === 'other' ? 'rss' : 'x_search'},'T1',${kind === 'hot_signal' ? 'hot_signal' : 'editorial'},'2100-01-01')`;
});
afterEach(async () => {
  await sql`DELETE FROM event_job_deferrals WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`DELETE FROM event_job_deferrals WHERE singleton_key LIKE ${prefix + '%'}`;
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`DELETE FROM event_job_deferrals WHERE data->>'storyId'=ANY(${storyIds.map(String)}::text[])`;
  await sql`DELETE FROM pgboss.job WHERE data->>'storyId'=ANY(${storyIds.map(String)}::text[])`;
  await sql`DELETE FROM settings WHERE key=ANY(${batches.map(id => RECOVERY_BATCH_PREFIX + id)}::text[])`;
  await sql`DELETE FROM articles WHERE source_id=ANY(${Object.values(sources)}::text[])`;
  await sql`DELETE FROM facts WHERE story_id=ANY(${storyIds}::bigint[])`;
  await sql`DELETE FROM stories WHERE id=ANY(${storyIds}::bigint[])`;
  await sql`UPDATE sources SET enabled=true,participation_mode=CASE WHEN id=${sources.hot_signal} THEN 'hot_signal' ELSE 'editorial' END
    WHERE id=ANY(${Object.values(sources)}::text[])`;
  ids.length = 0;
  batches.length = 0;
  storyIds.length = 0;
  invalidateRecentContentCache();
});
after(async () => {
  await sql`DELETE FROM sources WHERE id=ANY(${Object.values(sources)}::text[])`;
  await sql`DELETE FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  for (const row of savedPolicy) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${RECENT_CONTENT_POLICY_KEY},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  await stopBoss();
  await closeDb();
});
async function article(name: string, kind: keyof typeof sources = "editorial", state = "new", minutes = 60 * 24 * 5) {
  const id = `${prefix}-${name}`;
  ids.push(id);
  const post = kind === "editorial" || kind === "hot_signal" ? { provider: "bird", tweetId: "123456789", text: "local fixture" } : null;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_text,body_status,processing_state,published_at,discovered_at,timeline_at,x_post)
    VALUES(${id},${sources[kind]},${id},${'https://example.test/' + id},'Local fixture','Short original excerpt','ok',${state},
      now()-${minutes}*interval '1 minute',now(),now(),${post ? sql.json(post) : null})`;
  return id;
}
async function attachStory(articleId: string, role = 'report') {
  const [story] = await sql`INSERT INTO stories(public_id,title) VALUES(${crypto.randomUUID()},'Offline fixed recovery story') RETURNING id`;
  storyIds.push(story.id);
  const [fact] = await sql`INSERT INTO facts(public_id,title,story_id) VALUES(${prefix + '-' + story.id},'Offline fact',${story.id}) RETURNING id`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact.id},${articleId},${role})`;
  await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,eligible,story_id,fact_id)
    SELECT a.id,'本地模型发布','本地报告说明模型发布和评测。',a.source_id,'news',a.url,a.published_at,a.discovered_at,a.timeline_at,a.timeline_at,true,${story.id},${fact.id}
    FROM articles a WHERE a.id=${articleId}`;
  await sql`UPDATE articles SET processing_state='analyzed',grouped_at=now() WHERE id=${articleId}`;
  return Number(story.id);
}
async function activate(name: string, articleIds: string[], kind: "bird-pending" | "model-failure" = "bird-pending") {
  await setRecentContentPolicy(true, "test", "keep the global bounded news policy");
  const id = `${prefix}-${name}`;
  batches.push(id);
  const plan = await planRecoveryBatch({ id, kind, articleIds, evidence: "fixed offline fixture" });
  await applyRecoveryBatch(plan, "test", "explicit fixed recovery fixture");
  return plan;
}

test("fixed permissions are audited/idempotent and cannot expand, revive or disable the ordinary window", async () => {
  const id = await article("immutable");
  const untouched = await article("untouched");
  const before = await sql`SELECT * FROM articles WHERE id=ANY(${[id,untouched]}::text[]) ORDER BY id`;
  const budgets = await sql`SELECT * FROM budgets ORDER BY service`;
  const plan = await activate("immutable-plan", [id]);
  await applyRecoveryBatch(plan, "test", "same operator request");
  const expanded = { ...plan, members: [...plan.members, { ...plan.members[0]!, articleId: untouched }] };
  await assert.rejects(applyRecoveryBatch({ ...expanded, digest: recoveryPlanDigest(expanded) }, "test", "forbidden expansion"), /cannot be changed or expanded/);
  assert.equal((await getRecentContentPolicy()).enabled, true);
  assert.deepEqual(await sql`SELECT * FROM articles WHERE id=ANY(${[id,untouched]}::text[]) ORDER BY id`, before);
  assert.deepEqual(await sql`SELECT * FROM budgets ORDER BY service`, budgets);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='content.processing-recovery.apply' AND subject=${'recovery:' + plan.id}`)[0].n, 1);
  await stopRecoveryBatch(plan.id, "revoked", "test", "stop further exceptional processing");
  assert.equal((await getRecentContentPriority(id)).allowed, false);
  await assert.rejects(applyRecoveryBatch(plan, "test", "revive"), /cannot be reactivated/);
  await setRecentContentPolicy(false, "test", "test that apply refuses an unbounded global policy");
  const other = await planRecoveryBatch({ id: `${prefix}-disabled-policy`, kind: "bird-pending", articleIds: [untouched], evidence: "offline" });
  await assert.rejects(applyRecoveryBatch(other, "test", "no global scope exemption"), /must remain enabled/);
});

test("producer and direct consumer admit only the pinned members; source, mode, enabled, date and revision drift stay blocked", async () => {
  const id = await article("guards");
  const other = await article("not-a-member");
  await activate("guards-plan", [id]);
  assert.equal((await getRecentContentPriority(id)).reason, "fixed-recovery-batch");
  assert.equal((await getRecentContentPriority(id)).priority, RECOVERY_PRIORITY);
  assert.equal(await queueProcessing(other), null);
  assert.deepEqual(await import("@aihot/backend/jobs/content").then(m => m.processArticle(other)), { state: "outside-priority-window" });
  for (const change of [
    async () => sql`UPDATE articles SET revision=2 WHERE id=${id}`,
    async () => sql`UPDATE articles SET source_id=${sources.other} WHERE id=${id}`,
    async () => sql`UPDATE sources SET enabled=false WHERE id=${sources.editorial}`,
    async () => sql`UPDATE sources SET participation_mode='hot_signal' WHERE id=${sources.editorial}`,
    async () => sql`UPDATE sources SET participation_mode='isolated' WHERE id=${sources.editorial}`,
    async () => sql`UPDATE articles SET published_at=NULL WHERE id=${id}`,
    async () => sql`UPDATE articles SET published_at=now()+interval '1 hour' WHERE id=${id}`,
  ]) {
    await change();
    const admission = await getRecentContentPriority(id);
    assert.equal(admission.allowed, false);
    assert.notEqual(admission.reason, "fixed-recovery-batch");
    await sql`UPDATE articles SET revision=1,source_id=${sources.editorial},published_at=now()-interval '5 days' WHERE id=${id}`;
    await sql`UPDATE sources SET enabled=true,participation_mode='editorial' WHERE id=${sources.editorial}`;
  }
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE subject LIKE ${'article:' + id + '%'}`)[0].n, 0);
});

test("the latest-2000 exception keeps normal news ahead and preserves queued retry and paid identities", async () => {
  const id = await article("rank-exception", "editorial", "new", 2);
  const recent = await article("rank-newest", "editorial", "new", 0);
  const plan = await activate("rank-plan", [id]);
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,processing_state)
    SELECT ${prefix + '-filler-'}||g,${sources.rss},${prefix + '-filler-'}||g,'https://example.test/filler/'||g,'Filler',
      now()-interval '1 minute',now(),now(),'blocked' FROM generate_series(1,2000) g`;
  invalidateRecentContentCache();
  assert.equal((await getRecentContentPriority(id)).reason, "fixed-recovery-batch");
  assert.ok((await getRecentContentPriority(recent)).priority! > RECOVERY_PRIORITY);
  await sql`UPDATE articles SET processing_attempt_tag='original-paid-evaluation',processing_attempts=2,
    processing_retry_at=now()+interval '1 hour' WHERE id=${id}`;
  const job = await queueProcessing(id);
  assert.ok(job);
  await sql`UPDATE pgboss.job SET retry_count=2,start_after=now()+interval '1 hour' WHERE id=${job}`;
  const before = (await sql`SELECT data,retry_count,retry_limit,start_after FROM pgboss.job WHERE id=${job}`)[0];
  await reprioritizeRecentContentJobs();
  assert.deepEqual((await sql`SELECT data,retry_count,retry_limit,start_after FROM pgboss.job WHERE id=${job}`)[0], before);
  assert.equal(before.data.attemptTag, "original-paid-evaluation");
  assert.equal((await sql`SELECT priority FROM pgboss.job WHERE id=${job}`)[0].priority, RECOVERY_PRIORITY);
  assert.equal((await getRecoveryBatch(plan.id))?.members[0]?.revision, 1);
});

test("only an official extraction transaction advances the permission; rollback and external revision drift do not", async () => {
  const id = await article("extraction", "rss", "failed");
  await sql`UPDATE articles SET body_status='pending' WHERE id=${id}`;
  const plan = await activate("extract-plan", [id], "model-failure");
  await assert.rejects(sql.begin(async tx => {
    await tx`UPDATE articles SET revision=2 WHERE id=${id}`;
    await advanceRecoveryExtractionRevision(id, 1, 2, tx);
    throw new Error("rollback extraction");
  }), /rollback extraction/);
  assert.equal((await getRecoveryBatch(plan.id))?.currentRevisions[id], undefined);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<html><head><title>Full local article</title></head><body><article><h1>Full local article</h1>' +
      '<p>A local research report describes verified model measurements, implementation details and evaluation methods.</p>'.repeat(40) + '</article></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const allowPrivate = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  try {
    await sql`UPDATE articles SET url=${'http://127.0.0.1:' + port + '/body'} WHERE id=${id}`;
    assert.equal(await extractArticleBody(id, false), "ok");
  } finally { config.allowPrivateNetworkFetch = allowPrivate; await new Promise<void>(resolve => server.close(() => resolve())); }
  assert.equal((await getRecoveryBatch(plan.id))?.members[0]?.revision, 1, "the initial manifest stays immutable");
  assert.equal((await getRecoveryBatch(plan.id))?.currentRevisions[id], 2);
  assert.equal((await getRecentContentPriority(id)).allowed, true);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='content.processing-recovery.extraction-revision' AND subject=${'recovery:' + plan.id}`)[0].n, 1);
  await sql`UPDATE articles SET revision=3 WHERE id=${id}`;
  assert.equal((await getRecentContentPriority(id)).allowed, false);
});

test("safety net resumes lost work but preserves due times, active jobs, capacity deferrals and terminal event failures", async () => {
  const lost = await article("lost");
  const later = await article("later");
  const deferred = await article("deferred", "hot_signal");
  const terminal = await article("terminal", "hot_signal");
  const plan = await activate("sweep-plan", [lost,later,deferred,terminal]);
  await sql`UPDATE articles SET processing_retry_at=now()+interval '1 hour',processing_attempts=2 WHERE id=${later}`;
  await sql`UPDATE articles SET processing_state='skipped' WHERE id=ANY(${[deferred,terminal]}::text[])`;
  await withEventCapacity(QUEUES.group, { articleId: deferred, signalOnly: true }, async () => { throw new BudgetExceededError("embedding", "day", 3600); });
  const failedJob = await enqueue(QUEUES.group, { articleId: terminal, signalOnly: true }, { singletonKey: terminal, retryLimit: 2 });
  await sql`UPDATE pgboss.job SET state='failed',retry_count=2,completed_on=now(),output=${sql.json({ message: "real provider failure" })} WHERE id=${failedJob}`;
  const deferralBefore = await sql`SELECT * FROM event_job_deferrals WHERE singleton_key=${deferred}`;
  assert.equal((await sweepRecoveryBatches()).enqueued, 1);
  assert.equal((await sweepRecoveryBatches()).enqueued, 0);
  assert.deepEqual(await sql`SELECT * FROM event_job_deferrals WHERE singleton_key=${deferred}`, deferralBefore);
  assert.equal((await sql`SELECT processing_attempts FROM articles WHERE id=${later}`)[0].processing_attempts, 2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE data->>'articleId'=${terminal}`)[0].n, 1);
  assert.equal((await recoveryBatchStatus(plan.id))?.completeable, false);
  await assert.rejects(stopRecoveryBatch(plan.id, "complete", "test", "not yet"), /unsettled/);
});

test("the explicit RSS repair is one audited retry phase and keeps all old receipts and successful identities", async () => {
  const id = await article("rss-repair", "rss", "failed");
  const outside = await article("not-approved-rss", "rss", "failed");
  await sql`UPDATE articles SET processing_attempts=3,processing_attempt_tag='original-identity' WHERE id=${id}`;
  const plan = await activate("rss-plan", [id], "model-failure");
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status,response)
    VALUES(${prefix + '-successful-stage'},'llm','prefilter_article',${'article:' + id + '@1'},'completed',${sql.json({ fixture: true })}) RETURNING id`;
  const [unknown] = await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status)
    VALUES(${prefix + '-unknown'},'llm','score_article',${'article:' + id + '@1'},'unknown') RETURNING id`;
  const queue = (articleId: string, db: Db) => queueProcessing(articleId, { db });
  await assert.rejects(retryRecoveryFailures(plan.id, [outside], "test", "refuse expansion", queue), /outside the fixed/);
  await assert.rejects(retryRecoveryFailures(plan.id, [id], "test", "do not clear unknown", queue), /unresolved receipt/);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${unknown.id}`)[0].status, "unknown");
  await sql`DELETE FROM receipts WHERE id=${unknown.id}`; // Test-only resolution; production CLI never releases receipts.
  const receiptsBefore = await sql`SELECT * FROM receipts WHERE id=${receipt.id}`;
  assert.deepEqual((await retryRecoveryFailures(plan.id, [id], "test", "repair deployed", queue)).retried, [id]);
  await sql`UPDATE articles SET processing_attempts=2 WHERE id=${id}`;
  assert.deepEqual((await retryRecoveryFailures(plan.id, [id], "test", "same command", queue)).alreadyRetried, [id]);
  assert.equal((await sql`SELECT processing_attempts,processing_attempt_tag FROM articles WHERE id=${id}`)[0].processing_attempts, 2);
  assert.equal((await sql`SELECT data FROM pgboss.job WHERE data->>'articleId'=${id}`)[0].data.attemptTag, "original-identity");
  assert.deepEqual(await sql`SELECT * FROM receipts WHERE id=${receipt.id}`, receiptsBefore);
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='content.processing-recovery.retry-failed' AND subject=${'content:' + id}`)[0].n, 1);
});

test("fixed external editorial failures use the same audited repair without changing their source kind", async () => {
  const id = await article("external-repair", "external", "failed");
  const plan = await activate("external-plan", [id], "model-failure");
  assert.equal(plan.members[0]?.sourceKind, 'external');
  await retryRecoveryFailures(plan.id, [id], 'test', 'repair understanding output only', (articleId, db) => queueProcessing(articleId, { db }));
  assert.equal((await sql`SELECT kind FROM sources WHERE id=${sources.external}`)[0].kind, 'external');
  await sql`UPDATE sources SET kind='rss' WHERE id=${sources.external}`;
  assert.equal((await getRecentContentPriority(id)).allowed, false);
  await sql`UPDATE sources SET kind='external' WHERE id=${sources.external}`;
});

test("story digest missing handoff, terminal failures and unknown receipts block completion; ordinary digest provenance can finish it", async () => {
  const id = await article('digest-report');
  const plan = await activate('digest-plan', [id]);
  const storyId = await attachStory(id);
  assert.equal(await isStoryInProcessingScope(storyId), true);
  assert.equal((await recoveryBatchStatus(plan.id))?.members[0]?.stories[0]?.missingHandoff, true);
  assert.equal((await sweepRecoveryBatches()).enqueued, 1);
  const [job] = await sql`SELECT id,data FROM pgboss.job WHERE name='events.digest' AND data->>'storyId'=${String(storyId)}`;
  assert.deepEqual(job.data, { storyId }, 'missing handoff uses ordinary digest, with no forced re-evaluation');
  await sql`UPDATE pgboss.job SET state='failed',completed_on=now() WHERE id=${job.id}`;
  assert.equal((await recoveryBatchStatus(plan.id))?.completeable, false);
  await assert.rejects(stopRecoveryBatch(plan.id,'complete','test','digest still failed'), /unsettled/);
  assert.equal((await sweepRecoveryBatches()).enqueued, 0, 'real terminal failure is not resurrected');
  await sql`UPDATE pgboss.job SET state='completed',output=${sql.json({ updated: false })} WHERE id=${job.id}`;
  const [unknown] = await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status)
    VALUES(${prefix + '-story-unknown'},'llm','story_digest',${'story:' + storyId + '@1'},'unknown') RETURNING id`;
  assert.equal((await recoveryBatchStatus(plan.id))?.members[0]?.stories[0]?.unknownReceipts, 1);
  await assert.rejects(stopRecoveryBatch(plan.id,'complete','test','story receipt unknown'), /unsettled/);
  await sql`DELETE FROM receipts WHERE id=${unknown.id}`;
  const reports = await digestReports(storyId);
  assert.equal(reports.length, 1);
  await sql`INSERT INTO story_digests(story_id,version,digest,article_ids,inputs_hash,context_article_ids)
    VALUES(${storyId},2,'A verified offline fixture digest.',${[id]},${digestInputsHash(reports)},${[id]})`;
  await sql`UPDATE stories SET version=2,digest='A verified offline fixture digest.' WHERE id=${storyId}`;
  assert.equal((await recoveryBatchStatus(plan.id))?.completeable, true);
  assert.equal((await stopRecoveryBatch(plan.id,'complete','test','all ordinary stages settled')).status, 'complete');
});

test("hot signals and mention-only memberships grant no digest exception or unrelated digest-failure obligation", async () => {
  const signal = await article('signal-role', 'hot_signal');
  const mention = await article('mention-role');
  const plan = await activate('role-plan', [signal,mention]);
  const signalStory = await attachStory(signal);
  const mentionStory = await attachStory(mention, 'mention');
  await sql`UPDATE articles SET processing_state='skipped' WHERE id=${signal}`;
  for (const storyId of [signalStory,mentionStory]) {
    const job = await enqueue(QUEUES.digest,{ storyId },{ singletonKey: 'story:' + storyId });
    await sql`UPDATE pgboss.job SET state='failed',completed_on=now() WHERE id=${job}`;
    assert.equal(await isStoryInProcessingScope(storyId), false);
  }
  const status = await recoveryBatchStatus(plan.id);
  assert.ok(status?.members.every(member => member.stories.length === 0));
  assert.equal(status?.completeable, true);
});

test("a revoked due deferral stays paused without changing date/retry balance, then resumes through natural admission", async () => {
  const id = await article('paused-deferral','hot_signal');
  const plan = await activate('paused-plan',[id]);
  await withEventCapacity(QUEUES.group,{ articleId: id,signalOnly: true },async () => { throw new BudgetExceededError('embedding','day',3600); });
  await sql`UPDATE event_job_deferrals SET retry_at=now()-interval '1 minute',remaining_retries=1 WHERE singleton_key=${id}`;
  await stopRecoveryBatch(plan.id,'revoked','test','pause exception');
  const prior = await sql`SELECT * FROM event_job_deferrals WHERE singleton_key=${id}`;
  assert.equal((await sweepDeferredEventJobs()).enqueued,0);
  assert.equal((await sweepDeferredEventJobs()).enqueued,0);
  assert.deepEqual(await sql`SELECT * FROM event_job_deferrals WHERE singleton_key=${id}`,prior);
  await sql`UPDATE articles SET published_at=now() WHERE id=${id}`;
  invalidateRecentContentCache();
  assert.equal((await sweepDeferredEventJobs()).enqueued,1);
  const [job] = await sql`SELECT data,retry_limit FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=${id}`;
  assert.deepEqual(job.data,{ articleId: id,signalOnly: true });
  assert.equal(job.retry_limit,1);
});

test("more than 100 earlier paused deferrals cannot starve a later permitted member", async () => {
  const id = await article('not-starved','hot_signal');
  await activate('fair-deferrals',[id]);
  await sql`INSERT INTO event_job_deferrals(queue,singleton_key,data,retry_at,remaining_retries,reason)
    SELECT 'events.group',${prefix + '-paused-'}||g,jsonb_build_object('articleId',${prefix + '-paused-'}||g,'signalOnly',true),
      now()-interval '2 hours',1,'offline paused scope fixture' FROM generate_series(1,120) g`;
  await withEventCapacity(QUEUES.group,{ articleId:id,signalOnly:true },async () => { throw new BudgetExceededError('embedding','day',3600); });
  await sql`UPDATE event_job_deferrals SET retry_at=now()-interval '1 minute' WHERE singleton_key=${id}`;
  const prior = await sql`SELECT * FROM event_job_deferrals WHERE singleton_key LIKE ${prefix + '-paused-%'} ORDER BY singleton_key`;
  assert.equal((await sweepDeferredEventJobs()).enqueued,1);
  assert.deepEqual(await sql`SELECT * FROM event_job_deferrals WHERE singleton_key LIKE ${prefix + '-paused-%'} ORDER BY singleton_key`,prior);
  assert.equal((await sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=${id}`)[0].n,1);
});

test("complete requires material, grouping and deferrals to settle; revoked consumer retains a durable wait", async () => {
  const historical = await article("historical-signal", "hot_signal");
  const revoked = await article("revoked-signal", "hot_signal");
  const plan = await activate("event-plan", [historical,revoked]);
  await sql`UPDATE articles SET backfill=true WHERE id=${historical}`;
  await registerEventJobs(await getBoss());
  const job = await queueProcessing(historical);
  const deadline = Date.now() + 10_000;
  while ((await sql`SELECT state FROM pgboss.job WHERE id=${job}`)[0]?.state !== "completed") {
    assert.ok(Date.now() < deadline, "event consumer did not finish the permitted historical member");
    await delay(30);
  }
  const output = (await sql`SELECT output FROM pgboss.job WHERE id=${job}`)[0].output;
  assert.equal(output.verdict, "skipped", "existing historical/no-heat rule is preserved");
  assert.equal((await sql`SELECT processing_state FROM articles WHERE id=${historical}`)[0].processing_state, "skipped");
  await withEventCapacity(QUEUES.group, { articleId: revoked, signalOnly: true }, async () => { throw new BudgetExceededError("embedding", "day", 3600); });
  const prior = await sql`SELECT * FROM event_job_deferrals WHERE singleton_key=${revoked}`;
  await stopRecoveryBatch(plan.id, "revoked", "test", "stop this fixed permission");
  const stoppedJob = await enqueue(QUEUES.group, { articleId: revoked, signalOnly: true }, { singletonKey: revoked });
  while ((await sql`SELECT state FROM pgboss.job WHERE id=${stoppedJob}`)[0]?.state !== "completed") {
    assert.ok(Date.now() < deadline, "revoked consumer did not finish its admission check");
    await delay(30);
  }
  assert.deepEqual(await sql`SELECT * FROM event_job_deferrals WHERE singleton_key=${revoked}`, prior);
  assert.equal((await sql`SELECT output FROM pgboss.job WHERE id=${stoppedJob}`)[0].output.state, "outside-priority-window");
});
