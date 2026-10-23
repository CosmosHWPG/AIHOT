// Resume numeric-quota waits through the existing worker; no requests or business decisions occur here.
import { sql, type Db } from "../db.ts";
import { audit } from "../audit.ts";
import { restoreExpiredLlmBudget, temporaryLlmAllowance } from "../providers/temporary-budget.ts";
import { getRecentContentPolicy, getRecentContentScope } from "./recent-content.ts";

export async function wakeLlmBudgetWaits(db: Db = sql): Promise<{ articles: number; events: number }> {
  const run = async (tx: Db) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('budget:llm'))`;
    await restoreExpiredLlmBudget(tx);
    const [budget] = await tx<{ enabled: boolean; per_minute: number; per_hour: number; per_day: number }[]>`
      SELECT enabled,per_minute,per_hour,per_day FROM budgets WHERE service='llm'`;
    if (!budget) return { articles: 0,events: 0 };
    if (budget.enabled) {
      const [used] = await tx<{ minute: number; hour: number; day: number }[]>`
        SELECT count(*) FILTER(WHERE started_at>now()-interval '1 minute')::int AS minute,
          count(*) FILTER(WHERE started_at>now()-interval '1 hour')::int AS hour,count(*)::int AS day
        FROM receipt_attempts WHERE service='llm' AND origin='live' AND started_at>now()-interval '1 day'`;
      if (used!.minute>=budget.per_minute || used!.hour>=budget.per_hour || used!.day>=budget.per_day ||
          (await temporaryLlmAllowance(tx))?.exhausted) return { articles: 0,events: 0 };
    }
    const policy = await getRecentContentPolicy(tx);
    const ids = policy.enabled ? (await getRecentContentScope({ db: tx,fresh: true })).rows.map(row => row.id) : [];
    const articles = await tx`UPDATE articles SET processing_retry_at=now(),processing_queued_at=NULL
      WHERE ${policy.enabled ? tx`id=ANY(${ids}::text[])` : tx`true`} AND processing_state='new'
        AND processing_retry_at>now()
        AND processing_error ~ '^(extract: )?Budget for llm exhausted [(](minute|hour|day|temporary|stopped)[)]$' RETURNING id`;
    const events = await tx`UPDATE event_job_deferrals SET retry_at=now(),updated_at=now()
      WHERE retry_at>now() AND reason ~ '^Budget for llm exhausted [(](minute|hour|day|temporary|stopped)[)]$'
        AND ${policy.enabled ? tx`((queue='events.group' AND data->>'articleId'=ANY(${ids}::text[]))
          OR (queue='events.digest' AND EXISTS (SELECT 1 FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id
            WHERE f.story_id::text=event_job_deferrals.data->>'storyId' AND fa.article_id=ANY(${ids}::text[]))))` : tx`true`}
      RETURNING singleton_key`;
    if (articles.length || events.length) await audit("system:budget-capacity","content.capacity-wake","budget:llm",
      budget.enabled ? "Numeric capacity is available" : "Administrator disabled LLM count limits",
      null,{ articles: articles.length,events: events.length,enabled: budget.enabled },{ db: tx });
    return { articles: articles.length,events: events.length };
  };
  return "begin" in db ? (db as typeof sql).begin(run) : run(db);
}
