// A quota wait must survive a worker restart without spending the job's real failure retries.
import { sql, type Db } from "../db.ts";
import { BudgetExceededError, ReceiptBusyError } from "../providers/receipts.ts";
import { enqueue, QUEUES, shutdownSignal, type JobData } from "./queue.ts";
import { getProcessingScopeTargets, getRecentContentPriority, isStoryInProcessingScope } from "./recent-content.ts";

type EventQueue = typeof QUEUES.group | typeof QUEUES.digest;
type EventData = JobData[EventQueue];
interface Deferral {
  queue: EventQueue;
  singleton_key: string;
  data: EventData;
  retry_at: Date;
  remaining_retries: number;
  reason: string;
  generation: number;
}
interface Waiting { state: "waiting"; retryAt: Date }

const DEFAULT_RETRIES: Record<EventQueue, number> = { [QUEUES.group]: 4, [QUEUES.digest]: 3 };

function taskKey(queue: EventQueue, data: EventData): string {
  return queue === QUEUES.group ? (data as JobData[typeof QUEUES.group]).articleId
    : `story:${(data as JobData[typeof QUEUES.digest]).storyId}`;
}

function validData(queue: EventQueue, data: unknown): data is EventData {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const value = data as Record<string, unknown>;
  if (queue === QUEUES.group) return typeof value.articleId === "string" && value.articleId.length > 0 &&
    (value.signalOnly === undefined || typeof value.signalOnly === "boolean") &&
    (value.force === undefined || typeof value.force === "boolean");
  return Number.isSafeInteger(value.storyId) && Number(value.storyId) > 0 &&
    (value.afterCorrection === undefined || typeof value.afterCorrection === "boolean");
}

async function saveDeferral(db: Db, queue: EventQueue, data: EventData, retryAt: Date, remaining: number, reason: string) {
  const key = taskKey(queue, data);
  // An explicit correction/force remains explicit if another waiting job for the same item arrives.
  await db`INSERT INTO event_job_deferrals (queue,singleton_key,data,retry_at,remaining_retries,reason)
    VALUES (${queue},${key},${db.json(data as never)},${retryAt},${remaining},${reason})
    ON CONFLICT (queue,singleton_key) DO UPDATE SET
      data = (event_job_deferrals.data || EXCLUDED.data) ||
        CASE WHEN ${queue} = 'events.group' THEN
          jsonb_build_object('force',coalesce((event_job_deferrals.data->>'force')::boolean,false) OR coalesce((EXCLUDED.data->>'force')::boolean,false),
            'signalOnly',coalesce((event_job_deferrals.data->>'signalOnly')::boolean,false) AND coalesce((EXCLUDED.data->>'signalOnly')::boolean,false))
        ELSE jsonb_build_object('afterCorrection',coalesce((event_job_deferrals.data->>'afterCorrection')::boolean,false) OR coalesce((EXCLUDED.data->>'afterCorrection')::boolean,false)) END,
      retry_at=GREATEST(event_job_deferrals.retry_at,EXCLUDED.retry_at),
      remaining_retries=LEAST(event_job_deferrals.remaining_retries,EXCLUDED.remaining_retries),
      reason=EXCLUDED.reason,generation=event_job_deferrals.generation+1,queued_at=NULL,updated_at=now()`;
}

/** Run the ordinary handler, converting only capacity waits into a completed, durably deferred job. */
export async function withEventCapacity<Q extends EventQueue, T>(queue: Q, data: JobData[Q], run: () => Promise<T>, job?: { id: string }): Promise<T | Waiting> {
  const key = taskKey(queue, data);
  const [prior] = await sql<Deferral[]>`SELECT queue,singleton_key,data,retry_at,remaining_retries,reason,generation
    FROM event_job_deferrals WHERE queue=${queue} AND singleton_key=${key}`;
  if (prior && prior.retry_at.getTime() > Date.now()) {
    await saveDeferral(sql,queue,data,prior.retry_at,prior.remaining_retries,prior.reason);
    return { state: "waiting", retryAt: prior.retry_at };
  }
  try {
    const result = await run();
    if (prior) await sql`DELETE FROM event_job_deferrals WHERE queue=${queue} AND singleton_key=${key} AND generation=${prior.generation}`;
    return result;
  } catch (error) {
    // A restart must let pg-boss retry the current job; it is neither capacity nor provider failure.
    if (shutdownSignal.signal.aborted) throw error;
    if (error instanceof BudgetExceededError || error instanceof ReceiptBusyError) {
      // The replacement job gets only the retries that this job had left. Waiting never replenishes
      // retries already spent on real errors, even if failures and budget waits alternate.
      const [active] = job ? await sql<{ remaining: number }[]>`SELECT greatest(0,retry_limit-retry_count)::int AS remaining
        FROM pgboss.job WHERE id=${job.id} AND name=${queue} AND state='active'` : [];
      const remaining = active?.remaining ?? prior?.remaining_retries ?? DEFAULT_RETRIES[queue];
      const seconds = error instanceof BudgetExceededError ? Math.max(60, error.retryAfterSeconds) : 60;
      const retryAt = new Date(Date.now() + seconds * 1000);
      await saveDeferral(sql, queue, data, retryAt, remaining, error.message.slice(0, 500));
      return { state: "waiting", retryAt };
    }
    // Unknown receipts, rejected requests and malformed outputs retain the ordinary failure policy.
    // They are never resurrected by the capacity sweep.
    if (prior) await sql`DELETE FROM event_job_deferrals WHERE queue=${queue} AND singleton_key=${key} AND generation=${prior.generation}`;
    throw error;
  }
}

function legacyCapacity(message: string): boolean {
  return /^Budget for [\w-]+ exhausted \((?:minute|hour|day|stopped|unconfigured|credits-day|credits-reserve|balance-unavailable)\)$/.test(message)
    || /^Receipt \d+ is in flight$/.test(message);
}

/** Import only identifiable old terminal capacity failures, once. Saved receipt identities stay unchanged. */
async function recoverLegacyCapacity(): Promise<number> {
  return sql.begin(async tx => {
    const rows = await tx<{ id: string; name: EventQueue; data: unknown; message: string }[]>`
      SELECT j.id,j.name,j.data,coalesce(j.output->>'message','') AS message FROM pgboss.job j
      WHERE j.name IN ('events.group','events.digest') AND j.state='failed'
        AND NOT EXISTS (SELECT 1 FROM event_capacity_recoveries r WHERE r.job_id=j.id)
        AND (coalesce(j.output->>'message','') ~ '^Budget for [A-Za-z0-9_-]+ exhausted [(](minute|hour|day|stopped|unconfigured|credits-day|credits-reserve|balance-unavailable)[)]$'
          OR coalesce(j.output->>'message','') ~ '^Receipt [0-9]+ is in flight$')
        AND NOT EXISTS (SELECT 1 FROM pgboss.job later
          WHERE later.name=j.name AND later.created_on>j.created_on AND later.state IN ('completed','failed')
            AND CASE WHEN j.name='events.group' THEN later.data->>'articleId'=j.data->>'articleId'
              ELSE later.data->>'storyId'=j.data->>'storyId' END
            AND coalesce(later.output->>'state','')<>'waiting'
            AND NOT (coalesce(later.output->>'message','') ~ '^Budget for [A-Za-z0-9_-]+ exhausted [(](minute|hour|day|stopped|unconfigured|credits-day|credits-reserve|balance-unavailable)[)]$'
              OR coalesce(later.output->>'message','') ~ '^Receipt [0-9]+ is in flight$'))
      ORDER BY j.completed_on LIMIT 200 FOR UPDATE OF j SKIP LOCKED`;
    let recovered = 0;
    for (const row of rows) {
      if (!validData(row.name, row.data) || !legacyCapacity(row.message)) continue;
      await saveDeferral(tx, row.name, row.data, new Date(), DEFAULT_RETRIES[row.name], row.message);
      await tx`INSERT INTO event_capacity_recoveries (job_id,queue,singleton_key)
        VALUES (${row.id},${row.name},${taskKey(row.name,row.data)}) ON CONFLICT DO NOTHING`;
      recovered++;
    }
    return recovered;
  });
}

/** Every minute: recover legacy quota failures and queue due waits with one atomic durable handoff. */
export async function sweepDeferredEventJobs(): Promise<{ recovered: number; enqueued: number }> {
  const recovered = await recoverLegacyCapacity();
  const enqueued = await sql.begin(async tx => {
    const scope = await getProcessingScopeTargets(tx);
    const rows = await tx<Deferral[]>`SELECT d.queue,d.singleton_key,d.data,d.retry_at,d.remaining_retries,d.reason,d.generation
      FROM event_job_deferrals d WHERE d.retry_at<=now()
        AND (NOT ${scope.enabled}
          OR (d.queue='events.group' AND (d.data->>'articleId'=ANY(${scope.articleIds}::text[])
            OR EXISTS(SELECT 1 FROM articles a JOIN sources s ON s.id=a.source_id
              WHERE a.id=d.data->>'articleId' AND s.participation_mode='isolated')))
          OR (d.queue='events.digest' AND d.data->>'storyId'=ANY(${scope.storyIds.map(String)}::text[])))
        AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name=d.queue AND j.state IN ('created','retry','active')
          AND CASE WHEN d.queue='events.group' THEN j.data->>'articleId'=d.data->>'articleId' ELSE j.data->>'storyId'=d.data->>'storyId' END)
      ORDER BY d.retry_at,d.created_at LIMIT 100 FOR UPDATE OF d SKIP LOCKED`;
    let count = 0;
    for (const row of rows) {
      if (!validData(row.queue, row.data)) continue;
      // Keep durable evidence and its exact retry budget/date while a permission is stopped or
      // the ordinary rolling scope excludes it. A later natural admission can resume it.
      if (row.queue === QUEUES.group) {
        const admission = await getRecentContentPriority((row.data as JobData[typeof QUEUES.group]).articleId, { db: tx });
        if (!admission.allowed && admission.reason !== 'isolated') continue;
      } else if (!(await isStoryInProcessingScope((row.data as JobData[typeof QUEUES.digest]).storyId, tx))) continue;
      const job = row.queue === QUEUES.group
        ? await enqueue(QUEUES.group,row.data as JobData[typeof QUEUES.group],{ singletonKey: row.singleton_key,retryLimit: row.remaining_retries },tx)
        : await enqueue(QUEUES.digest,row.data as JobData[typeof QUEUES.digest],{ singletonKey: row.singleton_key,retryLimit: row.remaining_retries },tx);
      if (job) {
        await tx`UPDATE event_job_deferrals SET queued_at=now(),updated_at=now() WHERE queue=${row.queue} AND singleton_key=${row.singleton_key}`;
        count++;
      }
    }
    return count;
  });
  return { recovered, enqueued };
}
