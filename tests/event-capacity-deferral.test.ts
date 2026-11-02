import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { withEventCapacity, sweepDeferredEventJobs } from "@aihot/backend/jobs/event-deferral";
import { enqueue, ensureQueue, getBoss, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { BudgetExceededError, ReceiptBusyError, ReceiptUnknownError } from "@aihot/backend/providers/receipts";

const T = tag();
const prefix = `capacity-${T}`;
const story = Number(Date.now().toString().slice(-10));
const jobs: Array<{ name: string; id: string }> = [];

before(async () => { await ensureQueue(QUEUES.group); await ensureQueue(QUEUES.digest); });
after(async () => {
  for (const { id, name } of jobs) await (await getBoss()).deleteJob(name,id);
  await sql`DELETE FROM event_job_deferrals WHERE singleton_key LIKE ${prefix + "%"} OR singleton_key IN (${`story:${story}`},${`story:${story+1}`})`;
  await sql`DELETE FROM event_capacity_recoveries WHERE singleton_key LIKE ${prefix + "%"} OR singleton_key IN (${`story:${story}`},${`story:${story+1}`})`;
  await stopBoss();
  await closeDb();
});

async function due(queue: string, key: string) {
  await sql`UPDATE event_job_deferrals SET retry_at=now()-interval '1 second' WHERE queue=${queue} AND singleton_key=${key}`;
}
async function job(articleId: string, opts: { retryLimit?: number } = {}) {
  const id = await enqueue(QUEUES.group,{ articleId },{ singletonKey: articleId,...opts });
  assert.ok(id);
  jobs.push({ name: QUEUES.group,id });
  return id;
}
async function terminal(id: string, message: string, createdAt?: Date) {
  await sql`UPDATE pgboss.job SET state='failed',completed_on=now(),created_on=coalesce(${createdAt ?? null}::timestamptz,created_on),
    output=${sql.json({ name: "Error",message })} WHERE id=${id}`;
}

test("day budget waits persist and a duplicate before retry time does not call the provider", async () => {
  const articleId = `${prefix}-budget`;
  let calls = 0;
  const first = await withEventCapacity(QUEUES.group,{ articleId },async () => {
    calls++;
    throw new BudgetExceededError("llm","day",3600);
  });
  assert.equal(first.state,"waiting");
  const [row] = await sql`SELECT remaining_retries,generation,retry_at FROM event_job_deferrals WHERE singleton_key=${articleId}`;
  assert.equal(row!.remaining_retries,4);
  assert.ok(+row!.retry_at > Date.now()+3_500_000);
  const second = await withEventCapacity(QUEUES.group,{ articleId,force: true },async () => { calls++; return { state: "unexpected" }; });
  assert.equal(second.state,"waiting");
  assert.equal(calls,1);
  const [saved] = await sql`SELECT data FROM event_job_deferrals WHERE singleton_key=${articleId}`;
  assert.equal(saved!.data.force,true,"an explicit request is preserved while capacity is unavailable");
});

test("receipt-busy is deferred rather than failed, and due success clears the durable wait", async () => {
  const articleId = `${prefix}-busy`;
  const result = await withEventCapacity(QUEUES.group,{ articleId },async () => { throw new ReceiptBusyError("Receipt 123 is in flight"); });
  assert.equal(result.state,"waiting");
  await due(QUEUES.group,articleId);
  const done = await withEventCapacity(QUEUES.group,{ articleId },async () => ({ state: "grouped" }));
  assert.equal(done.state,"grouped");
  assert.equal((await sql`SELECT 1 FROM event_job_deferrals WHERE singleton_key=${articleId}`).length,0);
});

test("capacity replacement retains only the current job's unspent real-error retries", async () => {
  const articleId = `${prefix}-remaining`;
  const id = await job(articleId,{ retryLimit: 4 });
  await sql`UPDATE pgboss.job SET state='active',started_on=now(),retry_count=2 WHERE id=${id}`;
  const result = await withEventCapacity(QUEUES.group,{ articleId },async () => { throw new BudgetExceededError("llm","minute",60); },{ id });
  assert.equal(result.state,"waiting");
  const [saved] = await sql`SELECT remaining_retries FROM event_job_deferrals WHERE singleton_key=${articleId}`;
  assert.equal(saved!.remaining_retries,2);
  await (await getBoss()).complete(QUEUES.group,id,result);
  const old = await (await getBoss()).getJobById(QUEUES.group,id);
  assert.equal(old!.state,"completed");
  assert.equal(old!.retryCount,2,"quota did not add another failed retry");
  await due(QUEUES.group,articleId);
  await sweepDeferredEventJobs();
  const [replacement] = await sql<{ id: string; retry_limit: number }[]>`SELECT id,retry_limit FROM pgboss.job
    WHERE name='events.group' AND data->>'articleId'=${articleId} AND state='created'`;
  assert.ok(replacement);
  assert.equal(replacement.retry_limit,2,"replacement did not replenish the original retry budget");
  jobs.push({ name: QUEUES.group,id: replacement.id });
  const duplicate = await sweepDeferredEventJobs();
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=${articleId} AND state='created'`).length,1);
  assert.ok(duplicate.enqueued >= 0);
});

test("unknown receipts and real provider failures escape unchanged and are not capacity retries", async () => {
  const articleId = `${prefix}-true-failure`;
  await withEventCapacity(QUEUES.group,{ articleId },async () => { throw new BudgetExceededError("llm","hour",600); });
  await due(QUEUES.group,articleId);
  const unknown = new ReceiptUnknownError(123,"unknown paid outcome");
  await assert.rejects(withEventCapacity(QUEUES.group,{ articleId },async () => { throw unknown; }),error => error === unknown);
  assert.equal((await sql`SELECT 1 FROM event_job_deferrals WHERE singleton_key=${articleId}`).length,0);
  const rejected = new Error("provider HTTP 400");
  await assert.rejects(withEventCapacity(QUEUES.group,{ articleId },async () => { throw rejected; }),error => error === rejected);
  assert.equal((await sql`SELECT 1 FROM event_job_deferrals WHERE singleton_key=${articleId}`).length,0);
});

test("a successful older handler cannot delete a newer concurrent capacity wait", async () => {
  const articleId = `${prefix}-generation`;
  await withEventCapacity(QUEUES.group,{ articleId },async () => { throw new ReceiptBusyError("Receipt 321 is in flight"); });
  await due(QUEUES.group,articleId);
  await withEventCapacity(QUEUES.group,{ articleId },async () => {
    await withEventCapacity(QUEUES.group,{ articleId },async () => { throw new BudgetExceededError("llm","day",3600); });
    return { state: "grouped" };
  });
  const [wait] = await sql`SELECT reason,generation FROM event_job_deferrals WHERE singleton_key=${articleId}`;
  assert.ok(wait);
  assert.equal(wait.reason,"Budget for llm exhausted (day)");
  assert.equal(wait.generation,2);
});

test("legacy terminal capacity failures recover once; unknown and real failures stay terminal", async () => {
  const budgetId = await job(`${prefix}-legacy-budget`);
  await terminal(budgetId,"Budget for llm exhausted (day)");
  const unknownId = await job(`${prefix}-legacy-unknown`);
  await terminal(unknownId,"Receipt 234 has an unknown outcome; it is released once automatically, then from the admin");
  const providerId = await job(`${prefix}-legacy-provider`);
  await terminal(providerId,"Budget for llm exhausted (day): provider returned 403");
  const result = await sweepDeferredEventJobs();
  assert.ok(result.recovered >= 1);
  const recovered = await sql<{ job_id: string }[]>`SELECT job_id FROM event_capacity_recoveries WHERE job_id IN (${budgetId},${unknownId},${providerId})`;
  assert.deepEqual(recovered.map(r => r.job_id),[budgetId]);
  const [newJob] = await sql<{ id: string }[]>`SELECT id FROM pgboss.job WHERE name='events.group' AND data->>'articleId'=${`${prefix}-legacy-budget`} AND state='created'`;
  assert.ok(newJob);
  jobs.push({ name: QUEUES.group,id: newJob.id });
  await (await getBoss()).deleteJob(QUEUES.group,newJob.id);
  await sql`DELETE FROM event_job_deferrals WHERE singleton_key=${`${prefix}-legacy-budget`}`;
  await sweepDeferredEventJobs();
  assert.equal((await sql`SELECT 1 FROM event_job_deferrals WHERE singleton_key=${`${prefix}-legacy-budget`}`).length,0,"legacy failed row is not imported again");
});

test("a later terminal real failure prevents replaying an older capacity failure for the same task", async () => {
  const articleId = `${prefix}-superseded`;
  const old = await job(articleId);
  await terminal(old,"Budget for llm exhausted (hour)",new Date(Date.now()-20_000));
  const later = await job(articleId);
  await terminal(later,"Receipt 456 has an unknown outcome");
  await sweepDeferredEventJobs();
  assert.equal((await sql`SELECT 1 FROM event_capacity_recoveries WHERE job_id=${old}`).length,0);
  assert.equal((await sql`SELECT 1 FROM event_job_deferrals WHERE singleton_key=${articleId}`).length,0);
});

test("digest corrections and grouping force survive durable waiting and queue reconstruction", async () => {
  const storyId = story;
  await withEventCapacity(QUEUES.digest,{ storyId,afterCorrection: true },async () => { throw new BudgetExceededError("llm","hour",600); });
  await withEventCapacity(QUEUES.digest,{ storyId },async () => assert.fail("future wait called a provider"));
  await due(QUEUES.digest,`story:${storyId}`);
  await sweepDeferredEventJobs();
  const [saved] = await sql<{ id: string; data: { storyId: number; afterCorrection: boolean } }[]>`SELECT id,data FROM pgboss.job
    WHERE name='events.digest' AND data->>'storyId'=${String(storyId)} AND state='created'`;
  assert.ok(saved);
  assert.equal(saved.data.afterCorrection,true);
  jobs.push({ name: QUEUES.digest,id: saved.id });
});
