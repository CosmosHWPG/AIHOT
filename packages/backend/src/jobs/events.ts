// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { settleNonEditorial } from "./content.ts";
import { enqueue, QUEUES, work } from "./queue.ts";
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
    const { articleId, signalOnly, force } = data;
    // A discussion post comes here straight from collection: record it first (settleNonEditorial).
    if (signalOnly && !force && !(await settleNonEditorial(articleId)).group) return { verdict: "skipped" };
    const result = await groupArticle(articleId, { signalOnly, force });
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
    return withEventCapacity(QUEUES.digest, data, () => composeStoryDigest(data.storyId, { afterCorrection: data.afterCorrection }),job);
  });
}
