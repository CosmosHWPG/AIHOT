// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { groupingPriority, settleNonEditorial } from "./content.ts";
import { isHistorical, newsCondition } from "../content/materials.ts";
import { enqueue, ensureQueue, QUEUES, work } from "./queue.ts";
import { withEventCapacity } from "./event-deferral.ts";
import { sql } from "../db.ts";
import { getRecentContentPriority, isStoryInProcessingScope } from "./recent-content.ts";
import { isRecoveryBatchMember } from "./processing-recovery.ts";
export { sweepDeferredEventJobs } from "./event-deferral.ts";

export async function registerEventJobs(boss: PgBoss) {
  // Serial on purpose: two reports of the same new fact must not both create it.
  await work(boss, QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async (data,job) => {
    const admission = await getRecentContentPriority(data.articleId);
    if (!admission.allowed && admission.reason !== "isolated") {
      if (!(await isRecoveryBatchMember(data.articleId))) await sql`DELETE FROM event_job_deferrals WHERE queue='events.group' AND singleton_key=${data.articleId}`;
      return { state: "outside-priority-window" };
    }
    return withEventCapacity(QUEUES.group, data, async () => {
    const { articleId, signalOnly, regroup, force } = data;
    // A discussion post comes here straight from collection: record it first (settleNonEditorial).
    if (signalOnly && !(await settleNonEditorial(articleId)).group) return { verdict: "skipped" };
    const result = await groupArticle(articleId, { signalOnly, regroup: regroup ?? force });
    if (result.storyId && !result.verdict.startsWith("signal")) {
      await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
    }
    return result;
    },job);
  });
  await work(boss, QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5 }, async (data,job) => {
    if (!(await isStoryInProcessingScope(data.storyId))) {
        const related = await sql<{ article_id: string }[]>`SELECT fa.article_id FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id WHERE f.story_id=${data.storyId}`;
        let retainedRecovery = false;
        for (const row of related) if (await isRecoveryBatchMember(row.article_id)) { retainedRecovery = true; break; }
        if (!retainedRecovery) await sql`DELETE FROM event_job_deferrals WHERE queue='events.digest' AND singleton_key=${`story:${data.storyId}`}`;
        return { state: "outside-priority-window" };
    }
    return withEventCapacity(QUEUES.digest, data, () => composeStoryDigest(data.storyId, { rewrite: data.afterCorrection }),job);
  });
}

export async function sweepUngrouped(): Promise<{ enqueued: number }> {
  await ensureQueue(QUEUES.group);
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; participation_mode: string; backfill: boolean; published_at: Date | null; discovered_at: Date }[]>`
      SELECT a.id, s.participation_mode, a.backfill, a.published_at, a.discovered_at
      FROM articles a JOIN sources s ON s.id = a.source_id
      WHERE a.grouping_status = 'pending' AND a.created_at < now() - interval '3 minutes'
        AND s.enabled
        AND (s.participation_mode = 'editorial' AND a.processing_state = 'analyzed' AND EXISTS (
              SELECT 1 FROM analyses an WHERE an.article_id = a.id AND an.input_revision = a.revision AND an.relevance = 'pass')
          OR s.participation_mode = 'hot_signal' AND a.processing_state = 'skipped' AND ${newsCondition})
        AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name = ${QUEUES.group}
          AND j.data->>'articleId' = a.id AND j.state IN ('created', 'active', 'retry'))
        AND NOT EXISTS (SELECT 1 FROM event_job_deferrals d WHERE d.queue = ${QUEUES.group} AND d.singleton_key = a.id)
      ORDER BY a.published_at DESC NULLS LAST, a.created_at LIMIT 100 FOR UPDATE OF a SKIP LOCKED`;
    let enqueued = 0;
    for (const row of rows) {
      if (!(await getRecentContentPriority(row.id, { db: tx })).allowed) continue;
      const signal = row.participation_mode === "hot_signal";
      const priority = groupingPriority({ signal, historical: isHistorical(row) });
      const data = signal ? { articleId: row.id, signalOnly: true } : { articleId: row.id };
      if (await enqueue(QUEUES.group, data, { singletonKey: row.id, priority }, tx)) enqueued++;
    }
    return { enqueued };
  });
}
