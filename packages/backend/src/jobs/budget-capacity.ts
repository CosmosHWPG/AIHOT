// Resume numeric-quota waits through the existing worker; no requests or business decisions occur here.
import { sql, type Db } from "../db.ts";
import { audit } from "../audit.ts";
import { restoreExpiredLlmBudget, temporaryLlmAllowance } from "../providers/temporary-budget.ts";
import { getProcessingScopeTargets, getRecentContentPolicy, getRecentContentScope } from "./recent-content.ts";

const JINA_NUMERIC_WAIT = "^extract: Budget for jina exhausted [(](minute|hour|day|stopped)[)]$";

/** Only an explicitly disabled local quota invalidates these waits; the normal worker does the work. */
export async function wakeJinaBudgetWaits(db: Db = sql): Promise<{ articles: number }> {
  const run = async (tx: Db) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('budget:jina'))`;
    const [budget] = await tx<{ enabled: boolean }[]>`SELECT enabled FROM budgets WHERE service='jina'`;
    if (budget?.enabled !== false) return { articles: 0 };
    const scope = await getProcessingScopeTargets(tx);
    if (!scope.enabled) return { articles: 0 };
    const candidates = await tx<{ id: string; source_id: string }[]>`SELECT a.id,a.source_id FROM articles a JOIN sources s ON s.id=a.source_id
      WHERE a.id=ANY(${scope.articleIds}::text[]) AND s.enabled AND s.participation_mode='editorial'
        AND a.processing_state='new' AND a.body_status='pending' AND a.processing_retry_at>now()
        AND a.processing_error ~ ${JINA_NUMERIC_WAIT}`;
    if (!candidates.length) return { articles: 0 };
    // Source/revision/config changes must settle before recomputing fixed-batch admission.
    await tx`SELECT id FROM sources WHERE id=ANY(${[...new Set(candidates.map(a => a.source_id))].sort()}::text[]) ORDER BY id FOR SHARE`;
    const locked = await tx<{ id: string }[]>`SELECT id FROM articles WHERE id=ANY(${candidates.map(a => a.id).sort()}::text[])
      ORDER BY id FOR UPDATE SKIP LOCKED`;
    const currentScope = await getProcessingScopeTargets(tx);
    if (!currentScope.enabled) return { articles: 0 };
    const allowed = new Set(currentScope.articleIds);
    const ids = locked.filter(a => allowed.has(a.id)).map(a => a.id);
    const rows = await tx<{ id: string; previous_retry_at: Date; retry_at: Date }[]>`
      WITH active_articles AS MATERIALIZED (
        SELECT DISTINCT j.data->>'articleId' AS id FROM pgboss.job j
        WHERE j.data->>'articleId'=ANY(${ids}::text[])
          AND j.name IN ('content.extract-body','content.analyze','events.group') AND j.state IN ('created','retry','active')
      ), unresolved AS MATERIALIZED (
        SELECT subject,request->>'url' AS url FROM receipts WHERE service='jina' AND status IN ('pending','unknown')
      ), waiting AS (
        SELECT a.id,a.processing_retry_at AS previous_retry_at FROM articles a JOIN sources s ON s.id=a.source_id
        WHERE a.id=ANY(${ids}::text[]) AND s.enabled AND s.participation_mode='editorial'
          AND a.processing_state='new' AND a.body_status='pending' AND a.processing_retry_at>now()
          AND a.processing_error ~ ${JINA_NUMERIC_WAIT}
          AND NOT EXISTS (SELECT 1 FROM active_articles j WHERE j.id=a.id)
          AND NOT EXISTS (SELECT 1 FROM unresolved r WHERE r.subject='article:'||a.id OR r.url=a.url)
      ) UPDATE articles a SET processing_retry_at=now() FROM waiting w WHERE a.id=w.id
        RETURNING a.id,w.previous_retry_at,a.processing_retry_at AS retry_at`;
    if (rows.length) await audit("system:budget-capacity","content.capacity-wake","budget:jina",
      "Administrator disabled Jina count limits; resume only local numeric waits",
      { waits: rows.map(a => ({ articleId: a.id,retryAt: a.previous_retry_at })) },
      { articles: rows.length,articleIds: rows.map(a => a.id),retryAt: rows[0].retry_at,enabled: false },{ db: tx });
    return { articles: rows.length };
  };
  return "begin" in db ? (db as typeof sql).begin(run) : run(db);
}

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
