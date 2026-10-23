// Collection run for one source: fetch listing → filter → store material → enqueue processing.
// A failed fetch never advances the success cursor; the source's health reflects consecutive failures.
import { sql, type Db } from "../db.ts";
import { decideTimeline, identityKeyFor, upsertMaterial } from "../content/materials.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { stableJson } from "../lib/ids.ts";
import { enqueue, QUEUES, shutdownSignal } from "../jobs/queue.ts";
import { queueProcessing } from "../jobs/content.ts";
import { BudgetExceededError, completeReceipt } from "../providers/receipts.ts";
import { fetchRss } from "./rss.ts";
import { allowed, fetchDetail, fetchWebList, type DetailNeed } from "./web-list.ts";
import { unsupportedConfig } from "./config-keys.ts";
import { fetchJsonList } from "./json-list.ts";
import { accountHandle, fetchXSearch, initialXWatermark, planXBootstrap, planXShards, readXSearch, shardHandle, shardQuery, SHARDABLE_SQL, tweetToCandidate, xProvider, type XBacklog, type XProvider } from "./x.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { routeProvider } from "./x-route.ts";

export interface CollectResult {
  sourceId: string;
  status: "ok" | "failed" | "skipped";
  found: number;
  created: number;
  revised: number;
  error?: string;
}

class SourceChangedDuringFetch extends Error {}


export function noiseFiltered(c: Candidate, source: SourceRow): boolean {
  const f = source.config.ingestNoiseFilter;
  const cats: string[] = c.categories ?? [];
  if (source.config.denyCategories?.some((d: string) => cats.includes(d))) return true;
  if (source.config.allowCategories?.length && !source.config.allowCategories.some((a: string) => cats.includes(a))) return true;
  if (!f) return false;
  // Case-insensitive: the exemption "agent" keeps "Agent" (words in the lists are lower case).
  const has = (text: string, words: string[] | undefined) => (words ?? []).some((k) => text.includes(k.toLowerCase()));
  const title = c.title.toLowerCase();
  const hay = `${title}\n${(c.excerpt ?? "").toLowerCase()}`;
  if (has(hay, f.keepIfMatches)) return false;
  return has(title, f.dropMarkersTitleOnly) || has(hay, f.dropMarkers);
}

function rewriteUrl(c: Candidate, source: SourceRow): Candidate {
  const rw = source.config.itemUrlPrefixRewrite;
  if (rw?.from && rw?.to && c.url.startsWith(rw.from)) return { ...c, url: rw.to + c.url.slice(rw.from.length) };
  return c;
}

async function loadSource(id: string): Promise<SourceRow | null> {
  const [s] = await sql<SourceRow[]>`
    SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
    FROM sources WHERE id = ${id}`;
  return s ?? null;
}

type StoredDetail = { title: string; published_at: Date | null };

async function storedDetails(identities: string[]): Promise<Map<string, StoredDetail>> {
  if (identities.length === 0) return new Map();
  const rows = await sql<Array<StoredDetail & { identity_key: string }>>`SELECT identity_key, title, published_at FROM articles WHERE identity_key = ANY(${identities}::text[])`;
  return new Map(rows.map((r) => [r.identity_key, r]));
}

const DAY_MS = 86_400_000;
/** A listing title that is no headline: a label that swallowed its summary, or a call to action. */
const needsTitle = (title: string) => title.length > 100 || /^(read more|learn more|continue reading|more|阅读全文|阅读更多|查看详情|了解更多)$/i.test(title.trim());

async function store(sourceId: string, candidates: Candidate[], backfill: string | null, db?: Db): Promise<{ created: number; revised: number }> {
  let created = 0;
  let revised = 0;
  for (const c of candidates) {
    const material = { ...c, sourceId, via: "fetch" as const, backfill };
    const res = await upsertMaterial(material, db);
    if (res.created) created += 1;
    if (res.revised) revised += 1;
    // Extraction first when the source wants full text and none came with the listing, else analysis.
    if (res.created || res.revised) await queueProcessing(res.articleId, { db });
  }
  return { created, revised };
}

export async function collectSource(sourceId: string, opts: { force?: boolean; expectedProvider?: XProvider } = {}): Promise<CollectResult> {
  const source = await loadSource(sourceId);
  if (!source) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "missing" };
  // Provider-specific operator commands may wait for capacity. A route changed meanwhile must
  // never turn the already-authorized Bird read into a request to a paid supplier.
  if (opts.expectedProvider && (source.kind !== "x_search" || (source.config.provider ?? "socialdata") !== opts.expectedProvider)) {
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "provider_changed" };
  }
  if (!source.enabled && !opts.force) return { sourceId, status: "skipped", found: 0, created: 0, revised: 0, error: "paused" };
  if (source.kind === "mp_account" || source.kind === "external") {
    // WeChat accounts are reconciled by the mp job; external sources only receive reports.
    return { sourceId, status: "skipped", found: 0, created: 0, revised: 0 };
  }

  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${sourceId}) RETURNING id`;
  const firstImport = !source.cursor?.initializedAt;
  let created = 0;
  let revised = 0;
  let found = 0;
  try {
    // A config entry this kind does not implement fails the run, visibly, instead of being ignored.
    const unsupported = unsupportedConfig(source.kind, source.config);
    if (unsupported.length) throw new FetchError(`unsupported config: ${unsupported.join(", ")}`);
    let candidates: Candidate[];
    let paidReceiptIds: number[] = [];
    let nextCursor: Record<string, unknown> = { ...(source.cursor ?? {}) };
    let nextFetchMinutes = source.interval_minutes;
    let detail: Record<string, unknown> | null = null;
    if (source.kind === "rss") {
      const rss = await fetchRss(source, opts);
      candidates = rss.candidates;
      // The first import has a smaller backfill cap than later runs: allow the next run to read
      // the ordinary window before accepting 304s. Persist validators only after store succeeds.
      if (!firstImport) nextCursor.rss = rss.validator;
      else delete nextCursor.rss;
      if (rss.notModified) detail = { notModified: true, httpStatus: 304 };
    }
    else if (source.kind === "web_list") candidates = await fetchWebList(source);
    else if (source.kind === "json_list") candidates = await fetchJsonList(source);
    else {
      const x = await fetchXSearch(source);
      candidates = x.candidates;
      paidReceiptIds = x.receiptIds;
      if (x.lastId) nextCursor.lastTweetId = x.lastId;
      // A search longer than one run keeps its position for the next runs (shown in the admin).
      if (x.birdCursor) nextCursor.bird = x.birdCursor;
      else if (x.backlog.length) nextCursor.xBacklog = x.backlog;
      else delete nextCursor.xBacklog;
      nextFetchMinutes = x.nextFetchMinutes ?? source.interval_minutes;
      detail = { provider: xProvider(source), pages: x.pages, truncated: x.truncated,
        backlog: x.birdCursor?.backlog.length ?? x.backlog.length, backlogPages: x.backlogPages, dropped: x.dropped,
        ...(x.birdCursor ? { coverage: x.birdCursor.coverage, gap: x.birdCursor.gap ?? null } : {}) };
    }
    found = candidates.length;
    candidates = candidates.filter((c) => allowed(c.url, source)).map((c) => rewriteUrl(c, source)).filter((c) => !noiseFiltered(c, source));
    if (source.config.sortByPublishedAt) candidates.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    // Deduplicate before enrichment and limits: URL aliases must neither buy duplicate detail reads
    // nor crowd other articles out of the window. Use exactly the identity the material will store.
    const unique = new Map<string, Candidate>();
    for (const c of candidates) {
      const identityKey = c.identityKey
        ?? (source.config.preserveUrlFragment === true ? identityKeyForUrl(c.url, { keepFragment: true }) : null)
        ?? identityKeyFor({ ...c, sourceId, via: "fetch" });
      if (!unique.has(identityKey)) unique.set(identityKey, { ...c, identityKey });
    }
    candidates = [...unique.values()];
    // First import of a new source: bounded, and archived by source time (never "today", never pushed).
    const backfillLimit = Number(source.config._aihot?.initialBackfillLimit ?? 30);
    const backfillMonths = Number(source.config._aihot?.initialBackfillMonths ?? 12);
    if (firstImport) {
      const cutoff = Date.now() - backfillMonths * 30 * 86400000;
      if (source.kind === "x_search" && xProvider(source) === "bird" && candidates.length > backfillLimit) {
        throw new FetchError("Bird initialBackfillLimit is smaller than the confirmed page; increase the bounded import limit before retrying");
      }
      candidates = candidates.filter((c) => !c.publishedAt || !Number.isFinite(c.publishedAt.getTime()) || c.publishedAt.getTime() >= cutoff).slice(0, backfillLimit);
    }
    // Process all candidates already returned before advancing the success cursor.

    // Detail pages only for material we have not seen (bounded per run), and only for what the listing lacks.
    const d = source.config.detail;
    const requireDate = d?.requirePublishedAt === true;
    const known = d ? await storedDetails(candidates.map((c) => c.identityKey!)) : new Map<string, StoredDetail>();
    const detailBudget = Number(d?.maxFetches ?? 0);
    let detailUsed = 0;
    // A permanently undated or failing page must not spend the whole budget on every run.
    // Rotate only the detail reads; storage keeps the listing's original order. A changed listing
    // that no longer contains the previous position starts at its head and never drops new links.
    const after = requireDate ? candidates.findIndex((c) => c.identityKey === source.cursor?.detailDateAfterIdentity) : -1;
    const detailCandidates = after < 0 ? candidates : [...candidates.slice(after + 1), ...candidates.slice(0, after + 1)];
    for (const c of detailCandidates) {
      // Listing dates the source marks unreliable are dropped; the detail page's rule decides.
      if (d?.publishedAtAuthoritative === true) c.publishedAt = null;
      const stored = known.get(c.identityKey!);
      if (stored !== undefined) {
        // The title came from the detail page: the listing's own rendering must not revise it back.
        if (d?.titleSelector || d?.titleRegex) c.title = stored.title;
        // An authoritative detail date must survive the next undated listing. Previously seen
        // material without a date can still use this round's detail budget to establish one.
        if (requireDate && stored.published_at && Number.isFinite(stored.published_at.getTime())) c.publishedAt = stored.published_at;
        if (!requireDate || c.publishedAt && Number.isFinite(c.publishedAt.getTime())) continue;
      }
      if (!d || detailUsed >= detailBudget) continue;
      const need: DetailNeed = {
        date: !c.publishedAt || d.upgradeDatePrecision === true,
        title: !!(d.titleSelector || d.titleRegex) && (d.titleAuthoritative === true || needsTitle(c.title)),
        summary: !!d.summarySelector && !c.excerpt,
        body: source.participation_mode === "editorial" && !c.bodyText && (!c.bodyStatus || c.bodyStatus === "pending"),
      };
      if (!need.date && !need.title && !need.summary) continue;
      detailUsed += 1;
      if (requireDate) nextCursor.detailDateAfterIdentity = c.identityKey!;
      try {
        const got = await fetchDetail(c.url, source, need);
        if (got.title) c.title = got.title;
        if (got.summary) c.excerpt = got.summary;
        // The same Readability path as extraction, using bytes already fetched for the detail rules.
        // A confirmed body enters through normal material revisions and skips the redundant fetch job.
        if (got.body) {
          c.bodyHtml = got.body.html;
          c.bodyText = got.body.text;
          c.bodyStatus = "ok";
          if (!c.media?.length) c.media = got.body.images;
        }
        // A date-only listing value gives way to the detail page's time on the same day.
        if (got.publishedAt && (!c.publishedAt || Math.abs(got.publishedAt.getTime() - c.publishedAt.getTime()) < DAY_MS)) c.publishedAt = got.publishedAt;
      } catch {
        // detail is best effort
      }
    }
    // Some sites date articles only on detail pages. Leave unchecked or still-undated links out
    // of storage so later rounds can enrich them, rather than publishing them at discovery time.
    if (requireDate) {
      const discoveredAt = new Date();
      candidates = candidates.filter((c) => decideTimeline(c.publishedAt, discoveredAt).publishedAt !== null);
    }

    // A Jina listing round that was pending when this run started has been received by now.
    delete nextCursor.jinaListingRound;
    if (firstImport && (source.kind !== "x_search" || xProvider(source) === "socialdata" || candidates.length > 0)) nextCursor.initializedAt = new Date().toISOString();
    nextCursor.lastOkAt = new Date().toISOString();
    const complete = async (tx: Db) => {
      await tx`
        UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
          health = 'ok', cursor = ${tx.json(nextCursor as never)}, updated_at = now(),
          next_fetch_at = now() + make_interval(mins => ${nextFetchMinutes})
        WHERE id = ${sourceId}`;
      await tx`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${found}, new_count = ${created},
                  detail = ${detail ? tx.json(detail as never) : null} WHERE id = ${run!.id}`;
      for (const receiptId of paidReceiptIds) await completeReceipt(tx, receiptId);
    };
    if (source.kind === "x_search") {
      // Source switches cannot let an older supplier overwrite the new route's position.
      await sql.begin(async tx => {
        const [current] = await tx<Pick<SourceRow, "kind" | "config" | "cursor" | "enabled">[]>`
          SELECT kind, config, cursor, enabled FROM sources WHERE id=${sourceId} FOR UPDATE`;
        if (!current || current.kind !== source.kind || current.enabled !== source.enabled
          || stableJson(current.config) !== stableJson(source.config) || stableJson(current.cursor) !== stableJson(source.cursor)) {
          throw new SourceChangedDuringFetch("source changed during X fetch; the received page was not acknowledged");
        }
        ({ created, revised } = await store(sourceId, candidates, firstImport ? "first-import" : null, tx));
        await complete(tx);
      });
    } else {
      ({ created, revised } = await store(sourceId, candidates, firstImport ? "first-import" : null));
      await sql.begin(complete);
    }
    return { sourceId, status: "ok", found, created, revised };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    // Attribute unsuccessful runs to the original route snapshot, never to a later source edit.
    // Only the supplier name is recorded; credentials and the rest of the config stay private.
    const failureDetail = source.kind === "x_search" ? { provider: routeProvider(source.config) } : null;
    if (error instanceof SourceChangedDuringFetch) {
      await sql`UPDATE fetch_runs SET status='skipped', finished_at=now(), error=${error.message},
        detail=${failureDetail ? sql.json(failureDetail) : null} WHERE id=${run!.id}`;
      return { sourceId, status: "skipped", found, created: 0, revised: 0, error: error.message };
    }
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const budget = error instanceof BudgetExceededError;
    if (budget && source.kind === "x_search" && xProvider(source) === "bird") {
      const seconds = Math.max(60, error.retryAfterSeconds);
      const detail = { ...failureDetail, deferred: true, reason: "budget_or_profile", retryAt: new Date(Date.now() + seconds * 1000).toISOString() };
      await sql`UPDATE sources SET next_fetch_at=now()+make_interval(secs=>${seconds}),last_error=${message},updated_at=now()
        WHERE id=${sourceId} AND config=${sql.json(source.config)}`;
      await sql`UPDATE fetch_runs SET status='skipped',finished_at=now(),error=${message},detail=${sql.json(detail)} WHERE id=${run!.id}`;
      return { sourceId, status: "skipped", found, created: 0, revised: 0, error: message };
    }
    await sql`
      UPDATE sources SET last_fetch_at = now(),
        fail_count = CASE WHEN ${budget} THEN fail_count ELSE fail_count + 1 END,
        last_error = ${message},
        health = CASE WHEN ${budget} THEN health WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
        next_fetch_at = now() + make_interval(mins => CASE WHEN ${budget} THEN 15 ELSE LEAST(interval_minutes * (fail_count + 2), 360) END),
        updated_at = now()
      WHERE id = ${sourceId} ${source.kind === "x_search" ? sql`AND config=${sql.json(source.config)}` : sql``}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${found}, new_count = ${created}, error = ${message},
      detail=${failureDetail ? sql.json(failureDetail) : null} WHERE id = ${run!.id}`;
    return { sourceId, status: "failed", found, created, revised, error: message };
  }
}

/** X ids begin with their millisecond timestamp (since 2010-11-04): the smallest id of a post made at `ms`. */
const xIdAt = (ms: number) => (BigInt(Math.max(0, ms - 1288834974657)) << 22n);

/**
 * Where an account's posts are known to be read up to. A quiet account's newest post can be months
 * old, but its last successful check read everything up to then; bounding a shard's search by the
 * post alone would re-read months of the other accounts' posts. Ten minutes before the check allows
 * for posts that reach the search late.
 */
function coveredTo(m: SourceRow): bigint {
  const own = BigInt(m.cursor!.lastTweetId);
  const checked = Date.parse(String(m.cursor?.lastOkAt ?? ""));
  if (!Number.isFinite(checked)) return own;
  const byTime = xIdAt(checked - 10 * 60_000);
  return byTime > own ? byTime : own;
}

/** Minutes between reads of a shard: editorial accounts every half hour, hot-signal accounts hourly. */
const X_SHARD_MINUTES: Record<string, number> = { editorial: 30, hot_signal: 60 };
const shardMinutes = (mode: string) => X_SHARD_MINUTES[mode] ?? 60;

/**
 * One search for a shard of X accounts (planXShards). Each post goes to the source whose handle wrote
 * it, and every account keeps its own fetch run, health and cursor. The oldest watermark bounds the
 * search, so no account misses a post (the others only see posts they already have again); afterwards
 * every account is covered up to the newest post the search saw, and the stretches still unread are
 * kept in each account's cursor, so they survive a change of shards.
 */
export async function collectXShard(key: string, sourceIds: string[]): Promise<{ key: string; status: "ok" | "failed" | "skipped"; accounts: number; found: number; created: number; error?: string }> {
  const members = (
    await sql<SourceRow[]>`
      SELECT id, name, kind, config, tier, participation_mode, first_party, interval_minutes, enabled, cursor, fail_count
      FROM sources WHERE id = ANY(${sourceIds}::text[])`
  ).filter((m) => m.enabled && xProvider(m) !== "bird" && (shardHandle(m) || (xProvider(m) === "xquik" && accountHandle(m))))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (members.length === 0) return { key, status: "skipped", accounts: 0, found: 0, created: 0 };
  const provider = xProvider(members[0]!);
  if (members.some(m => xProvider(m) !== provider)) throw new FetchError("mixed X providers in one shard");
  const bootstrap = provider === "xquik" && members.some(m => !m.cursor?.lastTweetId);
  const minutes = shardMinutes(members[0]!.participation_mode);
  const runs = new Map((await sql<{ id: number; source_id: string }[]>`
    INSERT INTO fetch_runs ${sql(members.map(m => ({ source_id: m.id })), "source_id")} RETURNING id, source_id`
  ).map(r => [r.source_id, r.id]));
  let found = 0;
  let created = 0;
  try {
    const since = members.map(m => m.cursor?.lastTweetId ? coveredTo(m) : BigInt(initialXWatermark())).reduce((a, b) => (b < a ? b : a));
    const backlog: XBacklog[] = [];
    const stretches = new Set<string>();
    for (const m of members) {
      for (const b of (Array.isArray(m.cursor?.xBacklog) ? m.cursor.xBacklog : []) as XBacklog[]) {
        if (!stretches.has(`${b.query} ${b.next}`)) backlog.push(b);
        stretches.add(`${b.query} ${b.next}`);
      }
    }
    const query = shardQuery(members.map((m) => accountHandle(m)!));
    const read = await readXSearch(bootstrap ? `${query} since_id:${since}` : query,
      { lastId: bootstrap ? null : String(since), backlog, subject: `x-shard:${key}`, provider });
    const detail = { shard: key, provider, bootstrap, accounts: members.length, pages: read.pages, truncated: read.truncated, backlog: read.backlog.length, backlogPages: read.backlogPages, dropped: read.dropped };
    const counts = new Map<string, { found: number; created: number }>();
    const accounts = await sql.begin(async tx => {
      const current = await tx<Pick<SourceRow, "id" | "kind" | "config" | "cursor" | "enabled">[]>`
        SELECT id,kind,config,cursor,enabled FROM sources WHERE id IN ${tx(members.map(m => m.id))} ORDER BY id FOR UPDATE`;
      const snapshots = new Map(current.map(m => [m.id, m]));
      const unchanged = members.filter(m => {
        const row = snapshots.get(m.id);
        return row?.enabled && row.kind === m.kind && stableJson(row.config) === stableJson(m.config) && stableJson(row.cursor) === stableJson(m.cursor);
      });
      const kept = new Set(unchanged.map(m => m.id));
      for (const m of members) {
        if (!kept.has(m.id)) {
          await tx`UPDATE fetch_runs SET status='skipped',finished_at=now(),error='source changed during X shard fetch' WHERE id=${runs.get(m.id)!}`;
          continue;
        }
        const handle = accountHandle(m)!.toLowerCase();
        const mine = read.tweets.filter(t => t.user.screen_name.toLowerCase() === handle);
        const stored = await store(m.id, mine.map(t => tweetToCandidate(t, provider)).map(c => rewriteUrl(c, m)).filter(c => !noiseFiltered(c, m)),
          provider === "xquik" && !m.cursor?.initializedAt ? "first-import" : null, tx);
        found += mine.length; created += stored.created;
        counts.set(m.id, { found: mine.length, created: stored.created });
        const own = m.cursor?.lastTweetId ? String(m.cursor.lastTweetId) : null;
        const ownPosts = read.tweets.filter(t => t.user.screen_name.toLowerCase() === accountHandle(m)!.toLowerCase());
        const newest = provider === "xquik" ? ownPosts.reduce<string | null>((latest, t) => latest === null || BigInt(t.id_str) > BigInt(latest) ? t.id_str : latest, own) : read.lastId;
        const cursor: Record<string, unknown> = { ...(m.cursor ?? {}), lastOkAt: new Date().toISOString() };
        if (newest) cursor.lastTweetId = newest;
        if (provider !== "xquik" && own && (!newest || BigInt(own) > BigInt(newest))) cursor.lastTweetId = own;
        if (provider === "xquik" && ownPosts.length && !cursor.initializedAt) cursor.initializedAt = new Date().toISOString();
        if (read.backlog.length) cursor.xBacklog = read.backlog;
        else delete cursor.xBacklog;
        await tx`
          UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL,
            health = 'ok', cursor = ${tx.json(cursor as never)}, interval_minutes = ${minutes}, updated_at = now(),
            next_fetch_at = now() + make_interval(mins => ${minutes})
          WHERE id = ${m.id}`;
        const count = counts.get(m.id)!;
        await tx`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${count.found}, new_count = ${count.created},
                    detail = ${tx.json(detail as never)} WHERE id = ${runs.get(m.id)!}`;
      }
      if (unchanged.length) for (const receiptId of read.receiptIds) await completeReceipt(tx, receiptId);
      return unchanged.length;
    });
    return { key, status: accounts ? "ok" : "skipped", accounts, found, created };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const budget = error instanceof BudgetExceededError;
    for (const m of members) {
      await sql`
        UPDATE sources SET last_fetch_at = now(),
          fail_count = CASE WHEN ${budget} THEN fail_count ELSE fail_count + 1 END,
          last_error = ${message},
          health = CASE WHEN ${budget} THEN health WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
          next_fetch_at = now() + make_interval(mins => CASE WHEN ${budget} THEN 15 ELSE LEAST(${minutes} * (fail_count + 2), 360) END),
          updated_at = now()
        WHERE id = ${m.id} AND config=${sql.json(m.config)}`;
      await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), error = ${message}, detail = ${sql.json({ shard: key, accounts: members.length })} WHERE id = ${runs.get(m.id)!}`;
    }
    return { key, status: "failed", accounts: members.length, found, created: 0, error: message };
  }
}

/** X accounts read by shard: a plain query and a watermark (the first fetch of an account is its own). */
const sharded = () => sql`kind = 'x_search' AND config->>'query' ~* ${SHARDABLE_SQL} AND coalesce(config->>'searchType', 'Latest') = 'Latest'
  AND coalesce(config->>'provider', 'socialdata') IN ('socialdata','xquik')
  AND (cursor->>'lastTweetId' IS NOT NULL OR config->>'provider' = 'xquik')`;

/** Every minute: a shard is read when any of its accounts is due, all of them at once. */
async function scheduleXShards(): Promise<number> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "kind" | "config" | "cursor" | "participation_mode"> & { due: boolean }>>`
    SELECT id, kind, config, cursor, participation_mode, (next_fetch_at IS NULL OR next_fetch_at <= now()) AS due
    FROM sources WHERE enabled AND ${sharded()}`;
  const due = new Set(rows.filter((r) => r.due).map((r) => r.id));
  let enqueued = 0;
  for (const shard of [...planXShards(rows), ...planXBootstrap(rows)]) {
    if (!shard.sourceIds.some((id) => due.has(id))) continue;
    await enqueue(QUEUES.fetchXShard, { key: shard.key, sourceIds: shard.sourceIds }, { singletonKey: shard.key });
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id IN ${sql(shard.sourceIds)}`;
    enqueued += 1;
  }
  return enqueued;
}

/** One due author per tick, without spending a fetch run on a known account/budget deferral. */
async function scheduleBirdSource(): Promise<number> {
  if (!["true", "1"].includes(process.env.BIRD_ENABLED ?? "false")) return 0;
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('corescope:bird-schedule'))`;
    const [budget] = await tx<{ enabled: boolean; per_minute: number; per_hour: number; per_day: number }[]>`
      SELECT enabled,per_minute,per_hour,per_day FROM budgets WHERE service='bird'`;
    if (!budget) return 0;
    if (budget.enabled) {
      if (budget.per_minute <= 0 || budget.per_hour <= 0 || budget.per_day <= 0) return 0;
      const [counts] = await tx<{ minute: number; hour: number; day: number }[]>`
        SELECT count(*) FILTER(WHERE started_at>now()-interval '1 minute')::int AS minute,
          count(*) FILTER(WHERE started_at>now()-interval '1 hour')::int AS hour,count(*)::int AS day
        FROM receipt_attempts WHERE service='bird' AND origin='live' AND started_at>now()-interval '1 day'`;
      if (counts!.minute >= budget.per_minute || counts!.hour >= budget.per_hour || counts!.day >= budget.per_day) return 0;
    }
    const [queued] = await tx<{ exists: boolean }[]>`SELECT EXISTS(
      SELECT 1 FROM pgboss.job j JOIN sources s ON s.id=j.data->>'sourceId'
      WHERE j.name=${QUEUES.fetchSource} AND j.state IN ('created','retry','active') AND s.enabled AND s.kind='x_search' AND s.config->>'provider'='bird'
    ) AS exists`;
    if (queued!.exists) return 0;
    const [source] = await tx<{ id: string }[]>`
      SELECT s.id FROM sources s JOIN bird_profile_gate g
        ON g.profile=coalesce(s.config->'bird'->>'accountProfile',${process.env.BIRD_ACCOUNT_PROFILE ?? "birdclaw-primary"})
      WHERE s.enabled AND s.kind='x_search' AND s.config->>'provider'='bird'
        AND (s.next_fetch_at IS NULL OR s.next_fetch_at<=now()) AND g.verified_at IS NOT NULL
        AND (g.cooldown_until IS NULL OR g.cooldown_until<=now()) AND (g.lease_until IS NULL OR g.lease_until<=now())
      ORDER BY s.last_ok_at NULLS FIRST,s.next_fetch_at NULLS FIRST,s.id LIMIT 1 FOR UPDATE OF s`;
    if (!source) return 0;
    const job = await enqueue(QUEUES.fetchSource, { sourceId: source.id }, { singletonKey: source.id }, tx);
    if (!job) return 0;
    await tx`UPDATE sources SET next_fetch_at=now()+interval '10 minutes' WHERE id=${source.id}`;
    return 1;
  });
}

/** Every minute: enqueue due sources (enabled, not WeChat/external), oldest due first; X accounts by shard. */
export async function scheduleDueSources(limit = Number(process.env.FETCH_SCHEDULE_BATCH || 40)): Promise<{ enqueued: number; shards: number }> {
  const kinds: string[] = (process.env.COLLECT_KINDS || "rss,web_list,json_list,x_search").split(",");
  // Listings fetched through Jina Reader are paid; development can leave them out.
  const skipJina = process.env.COLLECT_SKIP_JINA === "true";
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM sources
    WHERE enabled AND kind IN ${sql(kinds)} AND (next_fetch_at IS NULL OR next_fetch_at <= now()) AND NOT (${sharded()})
      AND NOT(kind='x_search' AND coalesce(config->>'provider','socialdata')='bird')
      ${skipJina ? sql`AND config::text NOT LIKE '%r.jina.ai%'` : sql``}
    ORDER BY next_fetch_at NULLS FIRST LIMIT ${limit}`;
  for (const r of rows) {
    await enqueue(QUEUES.fetchSource, { sourceId: r.id }, { singletonKey: r.id });
    await sql`UPDATE sources SET next_fetch_at = now() + interval '10 minutes' WHERE id = ${r.id}`;
  }
  const shards = kinds.includes("x_search") ? await scheduleXShards() : 0;
  const bird = kinds.includes("x_search") ? await scheduleBirdSource() : 0;
  return { enqueued: rows.length + bird, shards };
}

/**
 * Daily: adapt each source's interval to its recent output (active 15 min … quiet 120 min).
 * hot_signal sources are allowed to be slower.
 */
export async function adaptIntervals(): Promise<{ updated: number }> {
  const rows = await sql<Array<Pick<SourceRow, "id" | "participation_mode" | "kind" | "config" | "cursor"> & { paid_listing: boolean; per_day: number }>>`
    SELECT s.id, s.participation_mode, s.kind, s.config, s.cursor, coalesce(s.config->>'url', '') LIKE 'https://r.jina.ai/%' AS paid_listing,
      (SELECT count(*) FROM articles a WHERE a.source_id = s.id AND a.discovered_at > now() - interval '7 days' AND NOT a.backfill) / 7.0 AS per_day
    FROM sources s WHERE s.enabled AND s.kind IN ('rss', 'web_list', 'json_list', 'x_search')`;
  let updated = 0;
  for (const r of rows) {
    // A Bird author's explicit capacity plan cannot be replaced by paid-shard pacing.
    if (r.kind === "x_search" && r.config.provider === "bird") continue;
    const perDay = Number(r.per_day);
    // Editorial sites and feeds are looked at hourly at least (they cost nothing);
    // editorial X and listings read through Jina stop at two hours (paid per call, within their budgets);
    // hot signals may wait longer.
    const max = r.participation_mode === "hot_signal" ? 180 : r.kind === "x_search" || r.paid_listing ? 120 : 60;
    // Listings read through Jina are not looked at more than hourly: busy ones would outrun its daily budget.
    const min = r.paid_listing ? 60 : 15;
    // X accounts read by shard follow the shard's pace, whatever their own volume.
    const target = shardHandle(r) ? shardMinutes(r.participation_mode) : perDay <= 0.15 ? max : Math.round(Math.min(max, Math.max(min, (24 * 60) / (perDay * 3))));
    const res = await sql`UPDATE sources SET interval_minutes = ${target} WHERE id = ${r.id} AND interval_minutes <> ${target}`;
    updated += res.count;
  }
  return { updated };
}
