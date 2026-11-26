// Supplier changes keep the account's confirmed position, but never recycle an opaque page token.
// This module makes no network calls; history attribution is based only on recorded local evidence.
import { stableJson } from "../lib/ids.ts";
import type { Db } from "../db.ts";

export type XRouteProvider = "socialdata" | "xquik" | "bird";
export type HistoricXProvider = XRouteProvider | "unknown";
export function routeProvider(config: Record<string, unknown>): HistoricXProvider {
  const value = config.provider ?? "socialdata";
  return value === "socialdata" || value === "xquik" || value === "bird" ? value : "unknown";
}

function sharedConfig(config: Record<string, unknown>) {
  // Bootstrap caps do not change an account/query and must not turn a supplier change into history import.
  const { provider: _provider, bird: _bird, _aihot: _bootstrap, ...shared } = config;
  return { ...shared, searchType: shared.searchType ?? "Latest" };
}

/** Bird profile changes also invalidate its supplier-specific continuation state. */
export function xRouteChange(before: Record<string, unknown>, after: Record<string, unknown>): "none" | "provider-only" | "account-route" {
  if (stableJson(sharedConfig(before)) !== stableJson(sharedConfig(after))) return "account-route";
  const changed = routeProvider(before) !== routeProvider(after)
    || (routeProvider(after) === "bird" && stableJson(before.bird ?? {}) !== stableJson(after.bird ?? {}));
  if (!changed) return "none";
  return "provider-only";
}

export function transitionXCursor(cursor: Record<string, unknown> | null, before: Record<string, unknown>, after: Record<string, unknown>, now = new Date()) {
  const change = xRouteChange(before, after);
  if (change === "none") return { change, cursor, archivedBacklog: 0 };
  const old = cursor ?? {};
  const oldBird = old.bird && typeof old.bird === "object" && !Array.isArray(old.bird) ? old.bird as Record<string, unknown> : null;
  const backlog = Array.isArray(old.xBacklog) ? old.xBacklog : [];
  const birdBacklog = Array.isArray(oldBird?.backlog) ? oldBird.backlog : [];
  const archivedBacklog = backlog.length + birdBacklog.length;
  const capturedAt = now.toISOString();
  const validTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const oldGap = oldBird?.gap && typeof oldBird.gap === "object" ? oldBird.gap as Record<string, unknown> : null;
  const previousGap = old.xProviderGap && typeof old.xProviderGap === "object" ? old.xProviderGap as Record<string, unknown> : null;
  const bounds: string[] = [validTime(oldGap?.from), validTime(previousGap?.from)].filter((v): v is string => !!v);
  let unknownLowerBound = false;
  for (const entry of backlog) {
    const query = entry && typeof entry === "object" ? String((entry as Record<string, unknown>).query ?? "") : "";
    const lower = /(?:^|\s)since_id:(\d+)(?:\s|$)/i.exec(query);
    const since = /(?:^|\s)since:(\d{4}-\d{2}-\d{2})(?:\s|$)/i.exec(query);
    let bound: string | null = null;
    if (lower) {
      // The common Snowflake id is portable; the opaque continuation token is not.
      const time = Number((BigInt(lower[1]!) >> 22n) + 1288834974657n);
      if (Number.isFinite(time) && time <= now.getTime() && time >= 1288834974657) bound = new Date(time).toISOString();
    } else if (since) bound = validTime(`${since[1]}T00:00:00Z`);
    if (bound) bounds.push(bound); else unknownLowerBound = true;
  }
  for (const entry of birdBacklog) {
    const bound = entry && typeof entry === "object" ? validTime((entry as Record<string, unknown>).since) : null;
    if (bound) bounds.push(bound); else unknownLowerBound = true;
  }
  if (unknownLowerBound) bounds.push(validTime(old.initializedAt) ?? validTime(old.lastOkAt) ?? capturedAt);
  const from = bounds.length ? bounds.sort()[0]! : validTime(old.lastOkAt) ?? validTime(old.initializedAt) ?? capturedAt;
  const hasGap = archivedBacklog > 0 || !!oldGap || !!old.xProviderGap;
  // A new supplier's recent timeline cannot prove that the old query/backlog has been recovered.
  const gap = hasGap ? { from, to: capturedAt, reason: "provider_switch_backlog" } : null;
  const archive = { schemaVersion: 1, fromProvider: routeProvider(before), toProvider: routeProvider(after), capturedAt,
    lastTweetId: old.lastTweetId ?? null, initializedAt: old.initializedAt ?? null,
    ...(backlog.length ? { backlog } : {}), ...(oldBird ? { bird: oldBird } : {}),
    ...(old.xProviderGap ? { previousGap: old.xProviderGap } : {}), ...(gap ? { gap } : {}) };
  const history = [...(Array.isArray(old.xRouteHistory) ? old.xRouteHistory : []), archive];
  const next: Record<string, unknown> = change === "provider-only" ? { ...old } : {};
  delete next.xBacklog;
  delete next.bird;
  delete next.xProviderGap;
  next.xRouteHistory = history;
  if (gap) next.xProviderGap = gap; // Visible until an operator reviews it; not an executable page token.
  if (routeProvider(after) === "bird") {
    next.bird = { schemaVersion: 1, observedLastTweetId: change === "provider-only" ? old.lastTweetId ?? null : null,
      coverage: gap ? "partial" : "unknown", checkedAt: null, lastTopAt: null, backlog: [], ...(gap ? { gap } : {}) };
  }
  return { change, cursor: next, archivedBacklog };
}

interface RouteAudit { created_at: Date | string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
/** Exact receipt attribution wins. Conflicting suppliers or gaps in route history stay unknown. */
export function historicXProvider(currentConfig: Record<string, unknown>, discoveredAt: Date, audits: RouteAudit[], receiptProviders: string[]): HistoricXProvider {
  const evidence = new Set(receiptProviders.filter(p => p === "socialdata" || p === "xquik" || p === "bird"));
  if (evidence.size) return evidence.size === 1 ? [...evidence][0] as XRouteProvider : "unknown";
  let config = currentConfig;
  for (const row of [...audits].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())) {
    if (new Date(row.created_at).getTime() <= discoveredAt.getTime()) break;
    if (!row.after || !Object.hasOwn(row.after, "config")) continue;
    if (!row.before || !Object.hasOwn(row.before, "config")) return "unknown";
    const prior = row.before.config;
    const next = row.after.config;
    if (!prior || typeof prior !== "object" || Array.isArray(prior) || !next || typeof next !== "object" || Array.isArray(next)
      || stableJson(next) !== stableJson(config)) return "unknown";
    config = prior as Record<string, unknown>;
  }
  // An opaque automatic route rewrite omitted the old config; do not infer a billable provider.
  return routeProvider(config);
}

/** The caller holds the source row lock; these metadata writes commit with the route change. */
export async function bindHistoricXProviders(db: Db, source: { id: string; config: Record<string, unknown> }) {
  const audits = await db<RouteAudit[]>`SELECT created_at, before, after FROM audit_log
    WHERE subject=${`source:${source.id}`} AND (before ? 'config' OR after ? 'config') ORDER BY created_at DESC,id DESC`;
  const [opaque] = await db<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM audit_log
    WHERE subject=${`source:${source.id}`} AND action='source.route-upgrade' AND after->'changedFields' ? 'config') AS exists`;
  const missing = await db<{ id: string; discovered_at: Date; evidence: string[] }[]>`
    SELECT a.id,a.discovered_at,coalesce(e.providers,ARRAY[]::text[]) AS evidence FROM articles a
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT r.service) AS providers FROM receipts r
      WHERE r.service IN ('socialdata','xquik','bird') AND r.status IN ('received','completed')
        AND (r.subject=${'article:'} || a.id OR r.request->>'article'=a.x_post->>'tweetId'
          OR (r.subject=${'source:'} || ${source.id} AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.response->'tweets')='array' THEN r.response->'tweets' ELSE '[]'::jsonb END) t
            WHERE coalesce(t->>'id_str',t->>'id')=a.x_post->>'tweetId')))
    ) e ON true
    WHERE a.source_id=${source.id} AND a.x_post IS NOT NULL AND nullif(a.x_post->>'provider','') IS NULL
    ORDER BY a.id FOR UPDATE OF a`;
  const counts = { socialdata: 0, xquik: 0, bird: 0, unknown: 0 };
  for (const article of missing) {
    const provider = opaque!.exists && !article.evidence.length ? "unknown"
      : historicXProvider(source.config, article.discovered_at, audits, article.evidence);
    await db`UPDATE articles SET x_post=jsonb_set(x_post,'{provider}',to_jsonb(${provider}::text),true) WHERE id=${article.id}`;
    counts[provider] += 1;
  }
  return counts;
}
