// X accounts via SocialData search ("from:handle -filter:replies", newest first). Plain account queries
// are read together, about two dozen accounts per search (planXShards); SocialData bills per request.
import { searchTweets, tweetMedia, tweetText, type SdArticle, type SdTweet } from "../providers/socialdata.ts";
import { ProviderRejectedError } from "../providers/receipts.ts";
import type { XPostData } from "../content/materials.ts";
import { sha256 } from "../lib/ids.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { searchXquikTweets, xquikSetting } from "../providers/xquik.ts";
import { birdUserTweets, type BirdTweet } from "../providers/bird.ts";
import { shutdownSignal } from "../lib/shutdown.ts";

export type XProvider = "socialdata" | "xquik" | "bird";
export function xProvider(source: Pick<SourceRow, "config">): XProvider {
  const provider = source.config.provider ?? "socialdata";
  if (provider !== "socialdata" && provider !== "xquik" && provider !== "bird") throw new FetchError("unsupported X provider");
  return provider;
}
export function initialXWatermark(now = Date.now()): string {
  const days = xquikSetting("XQUIK_INITIAL_LOOKBACK_DAYS", 7, 1, 31);
  return String(BigInt(Math.max(0, now - days * 86_400_000 - 1288834974657)) << 22n);
}

function avatar(url: string | undefined): string | null {
  // Larger avatar than the default 48px thumbnail.
  return url ? url.replace("_normal.", "_bigger.") : null;
}

export function toXPost(t: SdTweet): XPostData {
  const q = t.quoted_status ?? null;
  return {
    tweetId: t.id_str,
    authorName: t.user.name,
    handle: t.user.screen_name,
    avatarUrl: avatar(t.user.profile_image_url_https),
    text: tweetText(t),
    lang: t.lang ?? null,
    replyTo: t.in_reply_to_status_id_str ?? null,
    media: tweetMedia(t),
    quoted: q
      ? { authorName: q.user.name, handle: q.user.screen_name, text: tweetText(q), url: `https://x.com/${q.user.screen_name}/status/${q.id_str}`, media: tweetMedia(q) }
      : null,
  };
}

const X_ARTICLE_LINK = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/\d+/gi;

/** The post links an X Article (long-form text posted on X): its body is fetched before judging. */
export function linksXArticle(text: string | null | undefined): boolean {
  return new RegExp(X_ARTICLE_LINK.source, "i").test(text ?? "");
}

/** Nothing but the article's link: without the article there is nothing to judge (under 30 characters left). */
export function onlyXArticleLink(text: string | null | undefined): boolean {
  return linksXArticle(text) && (text ?? "").replace(X_ARTICLE_LINK, "").trim().length < 30;
}

/** An X Article as plain text with Markdown-like headings, quotes and list marks; media blocks are left out. */
export function xArticleText(article: SdArticle): { title: string; text: string } | null {
  const lines: string[] = [];
  for (const b of article.content_state?.blocks ?? []) {
    const text = (b.text ?? "").trim();
    if (!text || b.type === "atomic") continue;
    const mark = { "header-one": "# ", "header-two": "## ", "header-three": "### ", blockquote: "> ", "unordered-list-item": "- ", "ordered-list-item": "1. " }[b.type ?? ""] ?? "";
    lines.push(mark + text);
  }
  const text = lines.join("\n\n").trim();
  return text ? { title: (article.title ?? "").trim(), text } : null;
}

export function tweetToCandidate(t: SdTweet, provider: XProvider = "socialdata", accountProfile = "birdclaw-primary"): Candidate {
  const post = toXPost(t);
  post.provider = provider;
  const bird = provider === "bird" ? (t as BirdTweet).birdContent : undefined;
  if (bird) post.bird = { accountProfile, ...bird };
  const firstLine = post.text.split("\n").find((l) => l.trim()) ?? post.text;
  return {
    url: `https://x.com/${t.user.screen_name}/status/${t.id_str}`,
    identityKey: `x:${t.id_str}`,
    title: firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine,
    author: t.user.screen_name,
    language: t.lang ?? null,
    publishedAt: new Date(t.tweet_created_at),
    bodyText: [post.text, post.quoted ? `\n\n【引用 @${post.quoted.handle}】${post.quoted.text}` : ""].join("").trim(),
    // A linked X Article is the post's real body: extraction fetches it (jobs/content.ts route).
    bodyStatus: linksXArticle(post.text) || bird?.kind === "article" ? "pending" : bird && bird.bodyLevel !== "full" ? "unconfirmed" : "ok",
    xPost: post,
    media: post.media ?? [],
    raw: { favorite: t.favorite_count ?? null, retweet: t.retweet_count ?? null, views: t.views_count ?? null },
  };
}

/** Half-hour receipt window: a retried fetch in the same window reuses the paid response. */
function windowKey(now = Date.now()): string {
  return new Date(Math.floor(now / 1_800_000) * 1_800_000).toISOString();
}

/** Pages of new posts read per run after a watermark; a longer search continues in later runs. */
const MAX_PAGES = 10;
/** Pages per run spent on older stretches left over from earlier runs. */
const MAX_BACKLOG_PAGES = 10;
/** Stretches kept per source; beyond this the oldest is given up and reported. */
const MAX_BACKLOG = 5;

/** Where a newest-first search stopped at the page limit: the same query continues from `next`. */
export interface XBacklog {
  query: string;
  next: string;
}

export interface XRead {
  tweets: SdTweet[];
  /** Paid search pages whose business effects must be committed before their receipts complete. */
  receiptIds: number[];
  lastId: string | null;
  /** Stretches still to read, oldest first (kept in the source cursor). */
  backlog: XBacklog[];
  pages: number;
  /** The new-post search stopped at the page limit; the rest joined the backlog. */
  truncated: boolean;
  backlogPages: number;
  /** Stretches given up (too many, or the provider refused to continue one): posts in them may be missing. */
  dropped: number;
}

export interface XFetch extends Omit<XRead, "tweets"> {
  candidates: Candidate[];
  birdCursor?: BirdCursor;
  nextFetchMinutes?: number;
}

export interface BirdBacklog {
  next: string;
  lowerId: string | null;
  since: string;
}
export interface BirdCursor {
  schemaVersion: 1;
  observedLastTweetId: string | null;
  coverage: "complete" | "partial" | "unknown";
  checkedAt: string;
  lastTopAt: string | null;
  backlog: BirdBacklog[];
  gap?: { from: string; to: string; reason: string };
}

/** Each CLI call reads one page; opaque timeline cursors are used only to recover older stretches. */
export async function fetchBirdTimeline(source: SourceRow, readPage = birdUserTweets, now = Date.now()): Promise<XFetch> {
  const handle = accountHandle(source);
  if (!handle) throw new FetchError("Bird requires a plain Latest account query");
  const options = source.config.bird ?? {};
  const accountProfile = String(options.accountProfile ?? process.env.BIRD_ACCOUNT_PROFILE ?? "birdclaw-primary");
  const hours = Number(options.initialLookbackHours ?? 48);
  const maximumPages = source.cursor?.initializedAt ? Number(options.maxPagesPerRound ?? 1) : 1;
  if (!Number.isInteger(hours) || hours < 1 || hours > 48 || !Number.isInteger(maximumPages) || maximumPages < 1 || maximumPages > 5) {
    throw new FetchError("Invalid Bird lookback or page limit");
  }
  const previous = source.cursor?.bird as Partial<BirdCursor> | undefined;
  const backlog: BirdBacklog[] = (Array.isArray(previous?.backlog) ? previous.backlog : []).map(b => {
    if (!b || typeof b.next !== "string" || !b.next || !Number.isFinite(Date.parse(b.since))) throw new FetchError("Invalid Bird backlog");
    return { ...b };
  });
  let gap = previous?.gap;
  let lastTopAt = previous?.lastTopAt ?? null;
  const oldLastId = source.cursor?.lastTweetId ? String(source.cursor.lastTweetId) : null;
  if (oldLastId && !/^\d+$/.test(oldLastId)) throw new FetchError("Invalid X watermark");
  const lastTop = Date.parse(lastTopAt ?? "");
  const recover = backlog.length > 0 && Number.isFinite(lastTop) && now - lastTop < source.interval_minutes * 60_000;
  const checked = Date.parse(lastTopAt ?? String(source.cursor?.lastOkAt ?? ""));
  const horizon = now - hours * 3_600_000;
  const floor = Math.max(horizon, Number.isFinite(checked) ? checked - 10 * 60_000 : 0);
  if (!gap && Number.isFinite(checked) && checked < horizon) {
    gap = { from: new Date(checked).toISOString(), to: new Date(horizon).toISOString(), reason: "lookback_limit" };
  }
  const persistentGap = () => gap?.reason === "provider_switch_backlog" || gap?.reason === "lookback_limit";
  let active: { next: string | null; lowerId: string | null; since: string } = recover ? backlog.shift()!
    : { next: null, lowerId: oldLastId, since: new Date(floor).toISOString() };
  const markGap = (reason: string, from = active.since) => {
    // A former provider's unread query may cover much older data than this bounded timeline scan.
    if (!persistentGap()) gap = { from, to: new Date(now).toISOString(), reason };
  };
  const all: BirdTweet[] = [];
  const receipts: number[] = [];
  let pages = 0, backlogPages = 0, dropped = 0;
  let coverage: BirdCursor["coverage"] = "partial";
  const visited = new Set<string>();
  for (;;) {
    let page: Awaited<ReturnType<typeof birdUserTweets>>;
    try {
      page = await readPage(handle, { purpose: "source_fetch", subject: `source:${source.id}`, window: windowKey(now),
        cursor: active.next, accountProfile, signal: shutdownSignal.signal });
    } catch (error) {
      if (shutdownSignal.signal.aborted) throw error;
      if (pages === 0) throw error;
      if (active.next) backlog.push({ ...active, next: active.next });
      markGap("later_page_failed");
      break;
    }
    pages += 1;
    if (recover) backlogPages += 1;
    receipts.push(page.receiptId);
    const mine = page.tweets.filter(t => t.user.screen_name.toLowerCase() === handle.toLowerCase() && !t.retweeted_status && !t.birdContent?.isRepost);
    const since = Date.parse(active.since);
    // Pinned old posts and another author's reposts do not mean the recent range was exhausted.
    const ordered = mine.filter(t => !t.birdContent?.pinned);
    // The CLI may omit pin metadata; an old outlier preceding newer posts is not a coverage boundary.
    const descending = ordered.every((t, i) => i === 0 || Date.parse(ordered[i - 1]!.tweet_created_at) >= Date.parse(t.tweet_created_at));
    const reachedFloor = descending && ordered.length > 0 && Date.parse(ordered.at(-1)!.tweet_created_at) < since;
    all.push(...mine.filter(t => !t.in_reply_to_status_id_str && Date.parse(t.tweet_created_at) >= since));
    if (!recover) lastTopAt = new Date(now).toISOString();
    if (reachedFloor) {
      coverage = "complete";
      if (gap && !persistentGap() && since <= Date.parse(gap.from) && now >= Date.parse(gap.to)) gap = undefined;
      break;
    }
    if (!page.nextCursor) {
      // The CLI drops the bottom cursor on empty/duplicate pages. Its absence alone proves no range.
      coverage = "unknown";
      markGap(page.tweets.length ? "cli_cursor_missing" : "empty_page_without_cursor");
      break;
    }
    if (page.nextCursor === active.next || visited.has(page.nextCursor)) {
      markGap("repeated_cursor");
      backlog.push({ ...active, next: page.nextCursor });
      break;
    }
    visited.add(page.nextCursor);
    active = { ...active, next: page.nextCursor };
    if (pages >= maximumPages) { backlog.push({ ...active, next: page.nextCursor }); break; }
  }
  while (backlog.length > MAX_BACKLOG) { backlog.shift(); dropped += 1; }
  if (dropped) markGap("backlog_limit", new Date(now - hours * 3_600_000).toISOString());
  const unique = new Map(all.map(t => [t.id_str, t]));
  const tweets = [...unique.values()];
  const lastId = tweets.reduce<string | null>((last, t) => last === null || BigInt(t.id_str) > BigInt(last) ? t.id_str : last, oldLastId);
  if (backlog.length || gap) coverage = coverage === "unknown" ? coverage : "partial";
  const birdCursor: BirdCursor = { schemaVersion: 1, observedLastTweetId: lastId, coverage,
    checkedAt: new Date(now).toISOString(), lastTopAt, backlog, ...(gap ? { gap } : {}) };
  return { candidates: tweets.map(t => tweetToCandidate(t, "bird", accountProfile)), receiptIds: receipts, lastId,
    backlog: [], pages, truncated: coverage !== "complete", backlogPages, dropped, birdCursor,
    nextFetchMinutes: backlog.length ? Math.min(source.interval_minutes, 5) : source.interval_minutes };
}

/**
 * New posts since the watermark. The search is bounded by since_id, so every further page holds older
 * posts that are still new to us. A search longer than one run's pages (a long outage) moves the
 * watermark to the newest post and keeps its position; later runs read on from there until it reaches
 * the old watermark, so nothing in between is skipped. Without a watermark (a source's very first
 * fetch) one page is read: its import is bounded anyway.
 */
export async function readXSearch(base: string, opts: { lastId: string | null; backlog: XBacklog[]; subject: string; type?: "Latest" | "Top"; provider?: XProvider; limit?: number }): Promise<XRead> {
  const { lastId } = opts;
  const provider = opts.provider ?? "socialdata";
  if (provider === "bird") throw new FetchError("Bird account timelines cannot use paid OR search shards");
  const maximumPages = provider === "xquik" ? xquikSetting("XQUIK_MAX_PAGES", 2, 1, 10) : MAX_PAGES;
  const backlog = opts.backlog.map((b) => ({ ...b }));
  const window = windowKey();
  const search = (query: string, cursor: string | null) =>
    provider === "xquik"
      ? searchXquikTweets(query, { purpose: "source_fetch", subject: opts.subject, window, type: opts.type ?? "Latest", cursor, limit: opts.limit })
      : searchTweets(query, { purpose: "source_fetch", subject: opts.subject, window, type: opts.type ?? "Latest", cursor });
  const all: SdTweet[] = [];
  const receiptIds = new Set<number>();
  const query = lastId ? `${base} since_id:${lastId}` : base;
  let cursor: string | null = null;
  let pages = 0;
  let truncated = false;
  const visited = new Set<string>();
  for (;;) {
    let res: Awaited<ReturnType<typeof search>>;
    try {
      res = await search(query, cursor);
    } catch (error) {
      // A later page failing keeps the pages already read; the search goes on from there next run.
      if (!cursor) throw error;
      truncated = true;
      backlog.push({ query, next: cursor });
      break;
    }
    pages += 1;
    receiptIds.add(res.receiptId);
    all.push(...res.tweets);
    if (!res.nextCursor) break;
    if (!lastId && provider !== "xquik") break;
    if (visited.has(res.nextCursor) || res.nextCursor === cursor) {
      truncated = true;
      backlog.push({ query, next: res.nextCursor });
      break;
    }
    if (!lastId || pages >= maximumPages) {
      truncated = true;
      backlog.push({ query, next: res.nextCursor });
      break;
    }
    visited.add(res.nextCursor);
    cursor = res.nextCursor;
  }

  // Older stretches, oldest first. Budget, account or passing trouble leaves them for the next run; a
  // position the provider refuses as a bad request (an expired cursor) is given up.
  let dropped = 0;
  while (backlog.length > MAX_BACKLOG) {
    backlog.shift();
    dropped += 1;
  }
  let backlogPages = 0;
  const backlogVisited = new Set<string>();
  while (backlog.length > 0 && backlogPages < (provider === "xquik" ? maximumPages : MAX_BACKLOG_PAGES)
    && (provider !== "xquik" || lastId !== null)) {
    const stretch = backlog[0]!;
    let res: Awaited<ReturnType<typeof search>>;
    try {
      res = await search(stretch.query, stretch.next);
    } catch (error) {
      if (error instanceof ProviderRejectedError && (error.status === 400 || error.status === 422)) {
        backlog.shift();
        dropped += 1;
        continue;
      }
      break;
    }
    backlogPages += 1;
    receiptIds.add(res.receiptId);
    all.push(...res.tweets);
    if (!res.nextCursor) backlog.shift();
    else {
      const key = `${stretch.query}\n${res.nextCursor}`;
      if (res.nextCursor === stretch.next || backlogVisited.has(key)) break;
      backlogVisited.add(key);
      stretch.next = res.nextCursor;
    }
  }

  const seen = new Set<string>();
  const tweets = all.filter((t) => !t.retweeted_status && !seen.has(t.id_str) && !!seen.add(t.id_str));
  const maxId = tweets.reduce<string | null>((m, t) => (m === null || BigInt(t.id_str) > BigInt(m) ? t.id_str : m), lastId);
  return { tweets, receiptIds: [...receiptIds], lastId: maxId, backlog, pages, truncated, backlogPages, dropped };
}

/** One account's own search (its first fetch, a query of its own, or a manual run from the admin). */
export async function fetchXSearch(source: SourceRow): Promise<XFetch> {
  let base = String(source.config.query ?? "");
  if (!base) throw new FetchError("query missing");
  const provider = xProvider(source);
  if (provider === "bird") return fetchBirdTimeline(source);
  if (provider === "xquik" && !source.cursor?.lastTweetId) base += ` since_id:${initialXWatermark()}`;
  const { tweets, ...read } = await readXSearch(base, {
    lastId: source.cursor?.lastTweetId ?? null,
    backlog: Array.isArray(source.cursor?.xBacklog) ? source.cursor.xBacklog : [],
    subject: `source:${source.id}`,
    type: source.config.searchType ?? "Latest",
    provider,
    limit: !source.cursor?.initializedAt ? Number(source.config._aihot?.initialBackfillLimit ?? 30) : undefined,
  });
  return { candidates: tweets.map(t => tweetToCandidate(t, provider)), ...read };
}

// --- Shards: plain account queries read together ------------------------------------------------

/** A query that can share a search: exactly "from:handle -filter:replies", newest first. */
const SHARDABLE = /^from:([A-Za-z0-9_]{1,15}) -filter:replies$/i;
/** The same test in SQL, for the schedulers. */
export const SHARDABLE_SQL = "^from:[A-Za-z0-9_]{1,15} -filter:replies$";
/** SocialData refuses queries over 512 characters; the since_id watermark takes about 30 of them. */
const SHARD_QUERY_MAX = 470;
const SHARD_MAX_ACCOUNTS = 24;

/** The account a source reads, when it can share a search: a plain query and a watermark already set. */
export function shardHandle(s: Pick<SourceRow, "kind" | "config" | "cursor">): string | null {
  if (s.kind !== "x_search" || s.config.provider === "bird" || (s.config.searchType ?? "Latest") !== "Latest" || !s.cursor?.lastTweetId) return null;
  return SHARDABLE.exec(String(s.config.query ?? ""))?.[1] ?? null;
}

export function accountHandle(s: Pick<SourceRow, "kind" | "config">): string | null {
  if (s.kind !== "x_search" || (s.config.searchType ?? "Latest") !== "Latest") return null;
  return SHARDABLE.exec(String(s.config.query ?? ""))?.[1] ?? null;
}

export function shardQuery(handles: string[]): string {
  return `(${handles.map((h) => `from:${h}`).join(" OR ")}) -filter:replies`;
}

export interface XShard {
  key: string;
  mode: string;
  provider: XProvider;
  sourceIds: string[];
}

/**
 * Accounts that can share a search, per participation mode, in a stable order (by source id) and
 * packed into queries under the length limit. The same sources give the same shards, so a shard's
 * accounts stay together between runs; a source added or removed shifts only the shards after it.
 */
export function planXShards(sources: Array<Pick<SourceRow, "id" | "kind" | "config" | "cursor" | "participation_mode">>): XShard[] {
  const byMode = new Map<string, Array<{ id: string; handle: string }>>();
  for (const s of sources) {
    if (s.config.provider === "bird") continue;
    const handle = shardHandle(s);
    const provider = xProvider(s);
    const group = provider === "socialdata" ? s.participation_mode : `${s.participation_mode}:xquik`;
    if (handle) byMode.set(group, [...(byMode.get(group) ?? []), { id: s.id, handle }]);
  }
  const shards: XShard[] = [];
  for (const [mode, list] of [...byMode].sort(([a], [b]) => a.localeCompare(b))) {
    const provider: XProvider = mode.endsWith(":xquik") ? "xquik" : "socialdata";
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let current: typeof list = [];
    const close = () => {
      if (current.length) shards.push({ mode: mode.split(":")[0]!, provider, sourceIds: current.map((c) => c.id), key: `${mode}:${sha256(current.map((c) => c.id).join(",")).slice(0, 12)}` });
      current = [];
    };
    for (const s of list) {
      if (current.length >= SHARD_MAX_ACCOUNTS || shardQuery([...current, s].map((c) => c.handle)).length > SHARD_QUERY_MAX) close();
      current.push(s);
    }
    close();
  }
  return shards;
}

/** Only Xquik bootstraps in small batches; an absent actor never receives a fabricated watermark. */
export function planXBootstrap(sources: Array<Pick<SourceRow, "id" | "kind" | "config" | "cursor" | "participation_mode">>): XShard[] {
  const eligible = sources.filter(s => xProvider(s) === "xquik" && !s.cursor?.lastTweetId && accountHandle(s))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const shards: XShard[] = [];
  for (const mode of [...new Set(eligible.map(s => s.participation_mode))].sort()) {
    const members = eligible.filter(s => s.participation_mode === mode);
    for (let index = 0; index < members.length; index += 3) {
      const ids = members.slice(index, index + 3).map(s => s.id);
      shards.push({ mode, provider: "xquik", sourceIds: ids, key: `${mode}:xquik-bootstrap:${sha256(ids.join(",")).slice(0, 12)}` });
    }
  }
  return shards;
}
