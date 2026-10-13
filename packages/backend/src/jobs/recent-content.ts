// A bounded, rolling news processing window. The scope is ranked before checking article state:
// already analysed or blocked records still occupy their place in the newest 2,000 materials.
import { audit } from "../audit.ts";
import { sql, type Db } from "../db.ts";

export const RECENT_CONTENT_POLICY_KEY = "content.recent-processing";
export const RECENT_CONTENT_WINDOW_HOURS = 48;
export const RECENT_CONTENT_MAX_RECORDS = 2000;
const SCOPE_CACHE_MS = 5000;
const PRIORITY_BASE = 10_000;
const OUTSIDE_PRIORITY = -10_000;

export interface RecentContentPolicy {
  enabled: boolean;
  windowHours: 48;
  maxRecords: 2000;
  updatedAt: Date | null;
}

export interface RecentContentScopeRow {
  id: string;
  publishedAt: Date;
  participationMode: "editorial" | "hot_signal";
  rank: number;
  priority: number;
}

export interface RecentContentScope {
  at: Date;
  cutoff: Date;
  rows: RecentContentScopeRow[];
}

type ReadOptions = { db?: Db; fresh?: boolean };
type AdmissionReason = "disabled" | "admitted" | "missing" | "isolated" | "unknown-publication"
  | "future-publication" | "outside-window" | "outside-latest-2000";
export interface RecentContentAdmission {
  policy: RecentContentPolicy;
  allowed: boolean;
  priority: number | null;
  rank: number | null;
  reason: AdmissionReason;
}

let scopeCache: { signature: string; expiresAt: number; value: RecentContentScope } | null = null;
let pendingScope: { signature: string; promise: Promise<RecentContentScope> } | null = null;

export function invalidateRecentContentCache(): void {
  scopeCache = null;
  pendingScope = null;
}

/** Read the small setting every time: an operator's switch must invalidate other processes' scopes. */
export async function getRecentContentPolicy(db: Db = sql): Promise<RecentContentPolicy> {
  const [row] = await db<{ value: { enabled?: boolean }; updated_at: Date }[]>`
    SELECT value, updated_at FROM settings WHERE key = ${RECENT_CONTENT_POLICY_KEY}`;
  return { enabled: row?.value?.enabled === true, windowHours: RECENT_CONTENT_WINDOW_HOURS,
    maxRecords: RECENT_CONTENT_MAX_RECORDS, updatedAt: row?.updated_at ?? null };
}

function signature(policy: RecentContentPolicy): string {
  return `${policy.enabled}:${policy.updatedAt?.toISOString() ?? "missing"}`;
}

async function readScope(db: Db): Promise<RecentContentScope> {
  const [clock] = await db<{ at: Date; cutoff: Date }[]>`
    SELECT now() AS at, now() - interval '48 hours' AS cutoff`;
  const rows = await db<{ id: string; published_at: Date; participation_mode: "editorial" | "hot_signal" }[]>`
    SELECT a.id, a.published_at, s.participation_mode
    FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE s.participation_mode IN ('editorial', 'hot_signal')
      -- Keep comparison in PostgreSQL: JavaScript Date truncates now()'s microseconds and can
      -- otherwise exclude material stored with the same transaction's publication timestamp.
      AND a.published_at >= now() - interval '48 hours' AND a.published_at <= now()
    ORDER BY a.published_at DESC, a.id DESC LIMIT ${RECENT_CONTENT_MAX_RECORDS}`;
  return { at: clock.at, cutoff: clock.cutoff, rows: rows.map((row, index) => ({
    id: row.id, publishedAt: row.published_at, participationMode: row.participation_mode,
    rank: index + 1, priority: PRIORITY_BASE + RECENT_CONTENT_MAX_RECORDS - index,
  })) };
}

async function loadScope(policy: RecentContentPolicy, { db = sql, fresh = false }: ReadOptions): Promise<RecentContentScope> {
  // A caller transaction can contain newly stored material which another connection cannot see.
  // Neither its result nor a forced preview may replace a process's shared cache.
  if (db !== sql || fresh) return readScope(db);
  const key = signature(policy);
  if (scopeCache?.signature === key && scopeCache.expiresAt > Date.now()) return scopeCache.value;
  if (pendingScope?.signature === key) return pendingScope.promise;
  const promise = readScope(db).then(value => {
    if (pendingScope?.promise === promise) scopeCache = { signature: key, expiresAt: Date.now() + SCOPE_CACHE_MS, value };
    return value;
  }).finally(() => { if (pendingScope?.promise === promise) pendingScope = null; });
  pendingScope = { signature: key, promise };
  return promise;
}

/** Also available while disabled so an operator can review the exact ranked scope before enabling. */
export async function getRecentContentScope(options: ReadOptions = {}): Promise<RecentContentScope> {
  return loadScope(await getRecentContentPolicy(options.db), options);
}

/** Producer and consumer share admission. Date and participation changes are never hidden by a scope cache. */
export async function getRecentContentPriority(articleId: string, options: ReadOptions = {}): Promise<RecentContentAdmission> {
  const db = options.db ?? sql;
  const policy = await getRecentContentPolicy(db);
  const result = (reason: AdmissionReason, row?: RecentContentScopeRow): RecentContentAdmission => ({
    policy, reason, allowed: reason === "disabled" || reason === "admitted",
    priority: row?.priority ?? null, rank: row?.rank ?? null,
  });
  if (!policy.enabled) return result("disabled");
  const [article] = await db<{ participation_mode: string; published_at: Date | null; future: boolean; recent: boolean }[]>`
    SELECT s.participation_mode, a.published_at, a.published_at > now() AS future,
           a.published_at >= now() - interval '48 hours' AS recent
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!article) return result("missing");
  if (article.participation_mode !== "editorial" && article.participation_mode !== "hot_signal") return result("isolated");
  if (!article.published_at) return result("unknown-publication");
  if (article.future) return result("future-publication");
  if (!article.recent) return result("outside-window");
  let scope = await loadScope(policy, options);
  let ranked = scope.rows.find(row => row.id === articleId);
  // New collection can enter the front of the cached scope between reads. Refresh its admission,
  // rather than defer a new item merely because its collector used another database connection.
  if (!ranked && !options.fresh && db === sql && (scope.rows.length < RECENT_CONTENT_MAX_RECORDS
    || article.published_at.getTime() >= scope.rows.at(-1)!.publishedAt.getTime())) {
    scope = await loadScope(policy, { ...options, fresh: true });
    ranked = scope.rows.find(row => row.id === articleId);
  }
  return ranked ? result("admitted", ranked) : result("outside-latest-2000");
}

/** This changes only the dedicated policy; selection, publication and paid-service budgets are untouched. */
export async function setRecentContentPolicy(enabled: boolean, actor: string, reason: string, db: Db = sql): Promise<RecentContentPolicy> {
  if (!reason.trim()) throw new Error("reason is required");
  const run = async (tx: Db) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${RECENT_CONTENT_POLICY_KEY}))`;
    const before = await getRecentContentPolicy(tx);
    const value = { enabled, windowHours: RECENT_CONTENT_WINDOW_HOURS, maxRecords: RECENT_CONTENT_MAX_RECORDS,
      participationModes: ["editorial", "hot_signal"], order: "published_at DESC,id DESC" };
    await tx`INSERT INTO settings (key,value,updated_by) VALUES (${RECENT_CONTENT_POLICY_KEY},${tx.json(value)},${actor})
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`;
    const after = await getRecentContentPolicy(tx);
    await audit(actor, "content.recent-processing", `settings:${RECENT_CONTENT_POLICY_KEY}`, reason, before, after, { db: tx });
    return after;
  };
  const policy = "begin" in db ? await (db as typeof sql).begin(run) : await run(db);
  invalidateRecentContentCache();
  return policy;
}

/** Reorder only jobs which have not started. Keep retry times, active work and paid identities intact. */
export async function reprioritizeRecentContentJobs(db: Db = sql): Promise<{ eligible: number; outside: number; activeUntouched: number; updated: number }> {
  const policy = await getRecentContentPolicy(db);
  const scope = policy.enabled ? await getRecentContentScope({ db, fresh: true }) : null;
  const priorities = (scope?.rows ?? []).map(row => ({ id: row.id, priority: row.priority }));
  const rows = await db<{ admitted: boolean; changed: boolean }[]>`
    WITH ranked AS (
      SELECT * FROM jsonb_to_recordset(${db.json(priorities)}) AS r(id text,priority integer)
    ), ordered AS (
      SELECT j.id, r.id IS NOT NULL AS admitted,
        CASE WHEN ${policy.enabled} THEN coalesce(r.priority,${OUTSIDE_PRIORITY})
          WHEN a.backfill AND (a.published_at IS NULL OR a.discovered_at-a.published_at>interval '48 hours') THEN -2
          WHEN s.participation_mode='hot_signal' THEN -1 ELSE 0 END AS priority,
        j.priority AS previous_priority
      FROM pgboss.job j LEFT JOIN articles a ON a.id=j.data->>'articleId'
      LEFT JOIN sources s ON s.id=a.source_id LEFT JOIN ranked r ON r.id=a.id
      WHERE j.name IN('content.analyze','content.extract-body','events.group') AND j.state IN('created','retry')
    ), changed AS (
      UPDATE pgboss.job j SET priority=o.priority FROM ordered o
      WHERE j.id=o.id AND j.state IN('created','retry') AND j.priority<>o.priority RETURNING j.id
    ) SELECT o.admitted,c.id IS NOT NULL AS changed FROM ordered o LEFT JOIN changed c ON c.id=o.id`;
  const [active] = await db<{ count: number }[]>`SELECT count(*)::int AS count FROM pgboss.job
    WHERE name IN('content.analyze','content.extract-body','events.group') AND state='active'`;
  return { eligible: rows.filter(row => row.admitted).length, outside: rows.filter(row => !row.admitted).length,
    activeUntouched: active.count, updated: rows.filter(row => row.changed).length };
}
