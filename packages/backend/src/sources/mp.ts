// WeChat official accounts: a read-only local cache or Dajiala's paid list/body service.
import { sql } from "../db.ts";
import { upsertMaterial } from "../content/materials.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { stripTags } from "../lib/text.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { mpArticle, mpHistory, type MpArticle } from "../providers/dajiala.ts";
import { BudgetExceededError, ProviderRejectedError } from "../providers/receipts.ts";
import { readWxCache } from "./wx-cache.ts";
import { unsupportedConfig } from "./config-keys.ts";
import { shutdownSignal } from "../lib/shutdown.ts";

const MAX_NEW_PER_CHECK = 8;
/** Posts older than this on the first check of an account are history, not news. */
const FIRST_CHECK_WINDOW_MS = 7 * 86400_000;
/** A body missing for a passing reason is fetched again on later checks: this often, while the post is this recent. */
const BODY_RETRIES = 3;
const BODY_RETRY_WINDOW_MS = 3 * 86400_000;

/** The article body, and when it is missing for a reason that may pass (rate limit, server error, lost answer), that reason. */
async function fetchBody(url: string, sourceId: string, identity: string): Promise<{ body: MpArticle | null; passing: string | null }> {
  try {
    return { body: await mpArticle(url, { subject: sourceId, identity }), passing: null };
  } catch (error) {
    if (error instanceof BudgetExceededError) throw error;
    const final = error instanceof ProviderRejectedError && !error.retryable;
    return { body: null, passing: final ? null : String(error instanceof Error ? error.message : error).slice(0, 200) };
  }
}

interface MpSource {
  id: string;
  name: string;
  config: Record<string, any>;
  cursor: Record<string, unknown> | null;
  enabled: boolean;
  participation_mode: string;
}

async function checkWxCacheAccount(source: MpSource, reason: "schedule" | "manual") {
  const sourceId = source.id;
  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id, detail) VALUES (${sourceId}, ${sql.json({ reason, transport: "wx_cache" })}) RETURNING id`;
  const firstCheck = !source.cursor?.lastCheckedAt;
  let created = 0;
  let revised = 0;
  try {
    const bad = unsupportedConfig("mp_account", source.config);
    if (bad.length) throw new Error(`unsupported config: ${bad.join(", ")}`);
    // Known entries must not consume the source's new-material cap and starve older unseen entries.
    const read = readWxCache(source, { maxCandidates: 320 });
    const limit = Math.max(1, Math.min(40, Number(source.config.limit) || 8));
    for (const candidate of read.candidates) {
      if (created + revised >= limit) break;
      const result = await upsertMaterial({ ...candidate, sourceId, via: "fetch", backfill: firstCheck ? "first-import" : null });
      created += result.created ? 1 : 0;
      revised += result.revised ? 1 : 0;
      if (result.created || result.revised) await queueProcessing(result.articleId);
    }
    const detail = {
      reason, transport: "wx_cache", cacheUpdatedAt: read.cacheUpdatedAt.toISOString(),
      latestMessageAt: read.latestMessageAt?.toISOString() ?? null, stale: read.stale,
    };
    const cursor = { ...(source.cursor ?? {}), lastCheckedAt: new Date().toISOString(), wxCache: detail };
    const warning = read.stale ? `wx_cache stale: last cache refresh ${detail.cacheUpdatedAt}` : null;
    await sql.begin(async (tx) => {
      await tx`UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = ${warning},
        health = ${read.stale ? "degraded" : "ok"}, cursor = ${tx.json(cursor as never)},
        next_fetch_at = now() + make_interval(mins => interval_minutes), updated_at = now() WHERE id = ${sourceId}`;
      await tx`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${read.candidates.length}, new_count = ${created},
        detail = ${tx.json(detail)} WHERE id = ${run!.id}`;
    });
    return { sourceId, status: "ok" as const, found: read.candidates.length, created, revised, stale: read.stale };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    await sql`UPDATE sources SET last_fetch_at = now(), last_error = ${message}, fail_count = fail_count + 1,
      health = CASE WHEN fail_count + 1 >= 3 THEN 'failing' ELSE 'degraded' END,
      next_fetch_at = now() + make_interval(mins => LEAST(interval_minutes * (fail_count + 2), 360)), updated_at = now()
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed" as const, error: message };
  }
}

export async function checkMpAccount(sourceId: string, reason: "schedule" | "manual") {
  const [source] = await sql<MpSource[]>`SELECT id, name, config, cursor, enabled, participation_mode FROM sources WHERE id = ${sourceId} AND kind = 'mp_account'`;
  if (!source) return { sourceId, status: "missing" as const };
  if (!source.enabled && reason !== "manual") return { sourceId, status: "paused" as const };
  if (source.config.transport === "wx_cache") return checkWxCacheAccount(source, reason);
  if (source.config.transport && source.config.transport !== "dajiala") throw new Error("unsupported WeChat transport");
  const ghid = source.config.ghid ?? source.config.wxid;
  if (!ghid) return { sourceId, status: "unconfigured" as const };
  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id, detail) VALUES (${sourceId}, ${sql.json({ reason })}) RETURNING id`;
  const firstCheck = !source.cursor?.lastCheckedAt;
  let created = 0;
  try {
    // One paid list call per account per 10-minute window, whoever asks.
    const window = `${reason === "schedule" ? "s" : "m"}:${Math.floor(Date.now() / 600_000)}`;
    const history = await mpHistory(ghid, { subject: sourceId, window });
    const posts = [...history.posts].sort((a, b) => b.post_time - a.post_time);
    let fetched = 0;
    for (const p of posts) {
      if (!p.url || !p.title || fetched >= MAX_NEW_PER_CHECK) continue;
      const publishedAt = p.post_time ? new Date(p.post_time * 1000) : null;
      if (firstCheck && publishedAt && Date.now() - publishedAt.getTime() > FIRST_CHECK_WINDOW_MS) continue;
      // Same identity rule as every entrance: the long link without tracking parameters. A known post is
      // skipped, unless its body failed for a passing reason: then it is tried again a few times.
      const key = identityKeyForUrl(p.url);
      const [known] = key
        ? await sql<{ id: string; body_status: string; discovered_at: Date; retry: { attempts: number } | null }[]>`
            SELECT id, body_status, discovered_at, raw->'dajiala'->'bodyRetry' AS retry FROM articles WHERE identity_key = ${key} LIMIT 1`
        : [];
      const retryBody = !!known?.retry && known.body_status === "none" && known.retry.attempts < BODY_RETRIES && Date.now() - known.discovered_at.getTime() < BODY_RETRY_WINDOW_MS;
      if (known && !retryBody) continue;
      fetched += 1;
      // Without a body the post is listed anyway; analysis works from title and digest.
      const { body, passing } = await fetchBody(p.url, sourceId, p.sn ?? p.url);
      if (known && !body?.content) {
        const retry = passing ? sql`jsonb_set(raw, '{dajiala,bodyRetry}', ${sql.json({ attempts: known.retry!.attempts + 1, error: passing })})` : sql`raw #- '{dajiala,bodyRetry}'`;
        await sql`UPDATE articles SET raw = ${retry} WHERE id = ${known.id}`;
        continue;
      }
      // Mode 1 bodies are light HTML (paragraphs and image tags).
      const html = body?.content ? sanitizeBody(body.content, p.url) : null;
      const text = body?.content ? stripTags(body.content.replace(/<\/p>|<br\s*\/?>/gi, "\n")).replace(/\n{3,}/g, "\n\n").trim() : null;
      const res = await upsertMaterial({
        sourceId,
        url: p.url,
        title: p.title,
        author: body?.author ?? null,
        language: "zh",
        publishedAt,
        excerpt: p.digest ?? body?.desc ?? null,
        bodyHtml: html,
        bodyText: text || null,
        bodyStatus: text ? "ok" : "none",
        via: "fetch",
        backfill: firstCheck ? "first-import" : null,
        raw: {
          dajiala: {
            position: p.position, sn: p.sn ?? null, original: p.original ?? null, itemShowType: p.item_show_type ?? null, cover: p.cover_url ?? null,
            ...(passing ? { bodyRetry: { attempts: 1, error: passing } } : {}),
          },
        },
      });
      // A body fetched again arrives as a new revision (analysed again); stop retrying it.
      if (known) await sql`UPDATE articles SET raw = raw #- '{dajiala,bodyRetry}' WHERE id = ${known.id}`;
      if (res.created || res.revised) {
        created += res.created ? 1 : 0;
        await queueProcessing(res.articleId);
      }
    }
    const cursor = { ...(source.cursor ?? {}), lastCheckedAt: new Date().toISOString(), lastPostTime: posts[0]?.post_time ?? source.cursor?.lastPostTime ?? null, remainMoney: history.remainMoney };
    await sql`
      UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL, health = 'ok', cursor = ${sql.json(cursor as never)},
        next_fetch_at = now() + make_interval(mins => interval_minutes), updated_at = now()
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${posts.length}, new_count = ${created} WHERE id = ${run!.id}`;
    return { sourceId, status: "ok" as const, found: posts.length, created, reused: history.reused };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    const soft = error instanceof BudgetExceededError || (error instanceof ProviderRejectedError && error.retryable);
    await sql`
      UPDATE sources SET last_fetch_at = now(), last_error = ${message},
        fail_count = CASE WHEN ${soft} THEN fail_count ELSE fail_count + 1 END,
        health = CASE WHEN ${soft} THEN health WHEN fail_count + 1 >= 3 THEN 'failing' ELSE 'degraded' END,
        next_fetch_at = now() + make_interval(mins => CASE WHEN ${soft} THEN 15 ELSE LEAST(interval_minutes * (fail_count + 2), 360) END), updated_at = now()
      WHERE id = ${sourceId}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), new_count = ${created}, error = ${message} WHERE id = ${run!.id}`;
    if (soft) throw error; // retried by the queue
    return { sourceId, status: "failed" as const, error: message };
  }
}

/** Each enabled account is checked when due; failed transports keep their backoff. */
export async function scheduleMpReconcile(now = new Date()) {
  const rows = await sql<{ id: string; last: string | null; interval_minutes: number }[]>`
    SELECT id, cursor->>'lastCheckedAt' AS last, interval_minutes FROM sources WHERE kind = 'mp_account' AND enabled
      AND (next_fetch_at IS NULL OR next_fetch_at <= ${now})`;
  let enqueued = 0;
  for (const s of rows) {
    const since = s.last ? now.getTime() - Date.parse(s.last) : Infinity;
    if (since <= s.interval_minutes * 60_000) continue;
    await enqueue(QUEUES.mpCheck, { sourceId: s.id, reason: "schedule" }, { singletonKey: `mp:${s.id}` });
    await sql`UPDATE sources SET next_fetch_at = ${now}::timestamptz + interval '10 minutes' WHERE id = ${s.id}`;
    enqueued += 1;
  }
  return { enqueued };
}
