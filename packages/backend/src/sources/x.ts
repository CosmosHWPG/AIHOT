// X accounts via SocialData search, newest first. Verified publishers include their own thread
// continuations; other replies stay excluded. Plain accounts share length-bounded search shards.
import { marked } from "marked";
import { searchTweets, tweetMedia, tweetText, type SdArticle, type SdArticleImage, type SdTweet } from "../providers/socialdata.ts";
import { shownAddress } from "@aihot/contracts/addresses";
import { escHtml, sanitizeBody } from "../content/sanitize.ts";
import { X_ARTICLE_LINK } from "../content/posts.ts";
import { ProviderRejectedError } from "../providers/receipts.ts";
import type { XPostData } from "../content/materials.ts";
import { sha256 } from "../lib/ids.ts";
import { isXVideoUrl } from "../lib/video-url.ts";
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
import { xHandle } from "./account.ts";

function avatar(url: string | undefined): string | null {
  // Larger avatar than the default 48px thumbnail.
  return url ? url.replace("_normal.", "_bigger.") : null;
}

export function toXPost(t: SdTweet): XPostData {
  const q = t.quoted_status ?? null;
  return {
    tweetId: t.id_str,
    ...(t.user.id_str ? { authorUserId: t.user.id_str } : {}),
    authorName: t.user.name,
    handle: t.user.screen_name,
    avatarUrl: avatar(t.user.profile_image_url_https),
    text: tweetText(t),
    lang: t.lang ?? null,
    replyTo: t.in_reply_to_status_id_str ?? null,
    media: tweetMedia(t),
    quoted: q
      ? {
        ...(q.id_str ? { tweetId: q.id_str } : {}),
        ...(q.user.id_str ? { authorUserId: q.user.id_str } : {}),
        authorName: q.user.name, handle: q.user.screen_name, text: tweetText(q), url: `https://x.com/${q.user.screen_name}/status/${q.id_str}`, media: tweetMedia(q),
      }
      : null,
  };
}


/** The post links an X Article (long-form text posted on X): its body is fetched before judging. */
export function linksXArticle(text: string | null | undefined): boolean {
  return new RegExp(X_ARTICLE_LINK.source, "i").test(text ?? "");
}

/** Nothing but the article's link: without the article there is nothing to judge (under 30 characters left). */
export function onlyXArticleLink(text: string | null | undefined): boolean {
  return linksXArticle(text) && (text ?? "").replace(X_ARTICLE_LINK, "").trim().length < 30;
}

/**
 * An X Article as plain text with Markdown-like headings, quotes and list marks, for judging and writing
 * (media blocks are left out), and as the page shows it (`html`, xArticleHtml).
 */
export function xArticleText(article: SdArticle, postUrl: string): { title: string; text: string; html: string | null } | null {
  const lines: string[] = [];
  for (const b of article.content_state?.blocks ?? []) {
    const text = (b.text ?? "").trim();
    if (!text || b.type === "atomic") continue;
    const mark = { "header-one": "# ", "header-two": "## ", "header-three": "### ", blockquote: "> ", "unordered-list-item": "- ", "ordered-list-item": "1. " }[b.type ?? ""] ?? "";
    lines.push(mark + text);
  }
  const text = lines.join("\n\n").trim();
  return text ? { title: (article.title ?? "").trim(), text, html: xArticleHtml(article, postUrl) } : null;
}

type ArticleBlock = NonNullable<NonNullable<SdArticle["content_state"]>["blocks"]>[number];
type ArticleEntity = { type?: string; data?: any };

const STYLE_TAGS: Record<string, string> = { Bold: "strong", Italic: "em", Strikethrough: "del" };
const HEADING_TAGS: Record<string, string> = { "header-one": "h2", "header-two": "h3", "header-three": "h4" };

/** A block's words with its bold, italic and struck-through ranges and its links (ranges count characters). */
function articleInline(block: ArticleBlock, entities: Map<string, ArticleEntity>): string {
  const chars = Array.from(block.text ?? "");
  const marks = chars.map(() => ({ tags: [] as string[], href: null as string | null }));
  for (const r of block.inlineStyleRanges ?? []) {
    const tag = STYLE_TAGS[r.style ?? ""];
    for (let i = Math.max(0, r.offset); tag && i < Math.min(chars.length, r.offset + r.length); i++) if (!marks[i]!.tags.includes(tag)) marks[i]!.tags.push(tag);
  }
  for (const r of block.entityRanges ?? []) {
    const entity = entities.get(String(r.key));
    const url = entity?.type === "LINK" ? entity.data?.url : null;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    for (let i = Math.max(0, r.offset); i < Math.min(chars.length, r.offset + r.length); i++) marks[i]!.href = url;
  }
  const styled = (from: number, to: number) => {
    let out = "";
    for (let i = from; i < to;) {
      const key = [...marks[i]!.tags].sort().join();
      let j = i + 1;
      while (j < to && [...marks[j]!.tags].sort().join() === key) j++;
      let text = escHtml(chars.slice(i, j).join("")).replace(/\n/g, "<br>");
      for (const tag of ["del", "em", "strong"]) if (marks[i]!.tags.includes(tag)) text = `<${tag}>${text}</${tag}>`;
      out += text;
      i = j;
    }
    return out;
  };
  let html = "";
  for (let i = 0; i < chars.length;) {
    let j = i + 1;
    while (j < chars.length && marks[j]!.href === marks[i]!.href) j++;
    html += marks[i]!.href ? `<a href="${escHtml(marks[i]!.href!)}">${styled(i, j)}</a>` : styled(i, j);
    i = j;
  }
  return html;
}

/**
 * An X Article as its page shows it, from the blocks X sent: the cover, headings, paragraphs with their
 * emphasis and links, lists, quotes, pictures, dividers, tables and code (MARKDOWN blocks), and embedded
 * posts as links. Inline videos keep a playable X rendition when supplied, with the original post as a fallback.
 */
export function xArticleHtml(article: SdArticle, postUrl: string): string | null {
  const blocks = article.content_state?.blocks ?? [];
  const map = article.content_state?.entityMap ?? [];
  const entities = new Map<string, ArticleEntity>(Array.isArray(map) ? map.map((e) => [String(e.key), e.value]) : Object.entries(map));
  const media = new Map((article.media_entities ?? []).map((m) => [String(m.media_id), m.media_info]));
  const size = (image: SdArticleImage | undefined) => image?.original_img_width && image.original_img_height
    ? ` width="${image.original_img_width}" height="${image.original_img_height}"` : "";
  const picture = (image: SdArticleImage | undefined) => image?.original_img_url
    ? `<img src="${escHtml(image.original_img_url)}"${size(image)} alt="">` : "";
  const original = escHtml(postUrl);
  const parts: string[] = [];
  if (article.cover_url) parts.push(`<figure>${picture({ original_img_url: article.cover_url })}</figure>`);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const type = block.type ?? "unstyled";
    if (type === "unordered-list-item" || type === "ordered-list-item") {
      const items: string[] = [];
      for (; i < blocks.length && blocks[i]!.type === type; i++) if ((blocks[i]!.text ?? "").trim()) items.push(`<li>${articleInline(blocks[i]!, entities)}</li>`);
      i--;
      const tag = type === "ordered-list-item" ? "ol" : "ul";
      if (items.length) parts.push(`<${tag}>${items.join("")}</${tag}>`);
    } else if (type === "atomic") {
      for (const range of block.entityRanges ?? []) {
        const entity = entities.get(String(range.key));
        if (entity?.type === "MEDIA") {
          for (const item of entity.data?.mediaItems ?? []) {
            const info = media.get(String(item?.mediaId));
            if (info?.original_img_url) {
              parts.push(`<figure>${picture(info)}</figure>`);
            } else if (info?.preview_image || info?.variants?.length) {
              // The 832 kb/s rendition of the reported demos was 724px wide, close to the reading column.
              const mp4 = (info.variants ?? []).filter((v) => v.content_type === "video/mp4" && typeof v.url === "string" && isXVideoUrl(v.url))
                .sort((a, b) => (a.bit_rate ?? 0) - (b.bit_rate ?? 0));
              const src = (mp4.findLast((v) => (v.bit_rate ?? 0) <= 832_000) ?? mp4[0])?.url;
              const preview = info.preview_image;
              const poster = preview?.original_img_url ? ` poster="${escHtml(preview.original_img_url)}"` : "";
              const label = "在 X 查看原视频";
              parts.push(src
                ? `<figure><video src="${escHtml(src)}"${poster}${size(preview)}></video><a href="${original}">${label}</a></figure>`
                : `<figure><a href="${original}">${picture(preview)}${label}</a></figure>`);
            }
          }
        } else if (entity?.type === "DIVIDER") {
          parts.push("<hr>");
        } else if (entity?.type === "TWEET" && /^\d+$/.test(String(entity.data?.tweetId ?? ""))) {
          const url = `https://x.com/i/status/${entity.data.tweetId}`;
          parts.push(`<p><a href="${url}">${escHtml(shownAddress(url))}</a></p>`);
        } else if (entity?.type === "MARKDOWN" && typeof entity.data?.markdown === "string") {
          parts.push(marked.parse(entity.data.markdown, { async: false, gfm: true }));
        }
      }
    } else if ((block.text ?? "").trim()) {
      const words = articleInline(block, entities);
      const heading = HEADING_TAGS[type];
      parts.push(heading ? `<${heading}>${words}</${heading}>` : type === "blockquote" ? `<blockquote><p>${words}</p></blockquote>` : `<p>${words}</p>`);
    }
  }
  return sanitizeBody(parts.join("")) || null;
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
/**
 * How long a stretch left over stays worth reading. A run reads ten of its pages, so a search still not
 * caught up after days is stuck (or its accounts moved between shards); what is left in it is older than
 * the site's archive window anyway, and every further page buys posts that are already stored.
 */
const MAX_BACKLOG_AGE_MS = 3 * 86_400_000;
/** The oldest instant a post id can name (the id scheme starts 2010-11-04); an invented id names none. */
const ID_TIME_FLOOR_MS = Date.parse("2011-01-01T00:00:00Z");

/** Where a newest-first search stopped at the page limit: the same query continues from `next`. */
export interface XBacklog {
  query: string;
  next: string;
  /** When it was first left over; missing from cursors kept before this was recorded. */
  at?: string;
}

/** When a stretch was left over: its recorded creation, else the instant its since_id names. */
function stretchSince(stretch: XBacklog): number | null {
  const recorded = Date.parse(stretch.at ?? "");
  if (Number.isFinite(recorded)) return recorded;
  const sinceId = /since_id:(\d+)/.exec(stretch.query)?.[1];
  if (!sinceId) return null;
  const instant = Number((BigInt(sinceId) >> 22n) + 1288834974657n);
  return instant >= ID_TIME_FLOOR_MS ? instant : null;
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
  /** Stretches given up (too many, too old, or the provider refused to continue one): posts in them may be missing. */
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
  // One stretch per query, and none left over for days. A shard's stretches travel with its accounts, so
  // regrouping can leave copies of the same query at different positions in several shards, each of them
  // buying the same pages again; a stretch the page limit never catches up with only buys archived posts.
  let dropped = 0;
  const stretches = new Set<string>();
  const now = Date.now();
  const backlog = opts.backlog
    .filter((b) => {
      if (stretches.has(b.query)) return false;
      stretches.add(b.query);
      const since = stretchSince(b);
      if (since !== null && now - since > MAX_BACKLOG_AGE_MS) {
        dropped += 1;
        return false;
      }
      return true;
    })
    .map((b) => ({ ...b }));
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
      backlog.push({ query, next: cursor, at: new Date().toISOString() });
      break;
    }
    pages += 1;
    receiptIds.add(res.receiptId);
    all.push(...res.tweets);
    if (!res.nextCursor) break;
    if (!lastId && provider !== "xquik") break;
    if (visited.has(res.nextCursor) || res.nextCursor === cursor) {
      truncated = true;
      backlog.push({ query, next: res.nextCursor, at: new Date().toISOString() });
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

/**
 * One account's own search (its first fetch, a query of its own, or a manual run from the admin), from
 * its watermark or from an earlier post (`since`).
 */
export async function fetchXSearch(source: SourceRow, since?: string): Promise<XFetch> {
  const handle = selfThreadHandle(source);
  let base = handle ? `from:${handle} (-filter:replies OR filter:self_threads)` : String(source.config.query ?? "");
  if (!base) throw new FetchError("query missing");
  const provider = xProvider(source);
  if (provider === "bird") {
    if (since) throw new FetchError("Bird uses a bounded author timeline; per-post search replay is unsupported");
    return fetchBirdTimeline(source);
  }
  if (provider === "xquik" && !source.cursor?.lastTweetId) base += ` since_id:${initialXWatermark()}`;
  const { tweets, ...read } = await readXSearch(base, {
    lastId: since ?? source.cursor?.lastTweetId ?? null,
    backlog: Array.isArray(source.cursor?.xBacklog) ? source.cursor.xBacklog : [],
    subject: `source:${source.id}`,
    type: source.config.searchType ?? "Latest",
    provider,
    limit: !source.cursor?.initializedAt ? Number(source.config._aihot?.initialBackfillLimit ?? 30) : undefined,
  });
  return { candidates: tweets.map(t => tweetToCandidate(t, provider)), ...read };
}

// Shards: plain account queries read together. One search per account overran the SocialData budget on
// production's first day (2026-09-28).

/** A query that can share a search: exactly "from:handle -filter:replies", newest first. */
const SHARDABLE = /^from:[A-Za-z0-9_]{1,15} -filter:replies$/i;
/** The same test in SQL, for the schedulers. */
export const SHARDABLE_SQL = "^from:[A-Za-z0-9_]{1,15} -filter:replies$";
/** SocialData refuses queries over 512 characters; the since_id watermark takes about 30 of them. */
const SHARD_QUERY_MAX = 470;
const SHARD_MAX_ACCOUNTS = 24;

/** The account a source reads, when it can share a search: a plain query and a watermark already set. */
export function shardHandle(s: Pick<SourceRow, "kind" | "config" | "cursor">): string | null {
  if (s.kind !== "x_search" || s.config.provider === "bird" || (s.config.searchType ?? "Latest") !== "Latest" || !s.cursor?.lastTweetId) return null;
  return SHARDABLE.test(String(s.config.query ?? "")) ? xHandle(s.config) : null;
}

export function accountHandle(s: Pick<SourceRow, "kind" | "config">): string | null {
  if (s.kind !== "x_search" || (s.config.searchType ?? "Latest") !== "Latest") return null;
  return SHARDABLE.test(String(s.config.query ?? "")) ? xHandle(s.config) : null;
}

/** Verified publisher identity permits its own announcement thread, not conversations with others. */
export function selfThreadHandle(s: Pick<SourceRow, "config">): string | null {
  if (s.config.publisherRole !== "organization" && s.config.publisherRole !== "person") return null;
  return SHARDABLE.test(String(s.config.query ?? "")) ? xHandle(s.config) : null;
}

export function shardQuery(handles: string[], selfThreads: string[] = []): string {
  const posts = `(${handles.map((h) => `from:${h}`).join(" OR ")}) -filter:replies`;
  const own = handles.filter((h) => selfThreads.includes(h));
  return own.length ? `(${posts} OR (${own.map((h) => `from:${h}`).join(" OR ")}) filter:self_threads)` : posts;
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
  const byMode = new Map<string, Array<{ id: string; handle: string; selfThread: boolean }>>();
  for (const s of sources) {
    if (s.config.provider === "bird") continue;
    const handle = shardHandle(s);
    const provider = xProvider(s);
    const group = provider === "socialdata" ? s.participation_mode : `${s.participation_mode}:xquik`;
    if (handle) byMode.set(group, [...(byMode.get(group) ?? []), { id: s.id, handle, selfThread: !!selfThreadHandle(s) }]);
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
      if (current.length >= SHARD_MAX_ACCOUNTS || shardQuery([...current, s].map((c) => c.handle), [...current, s].filter((c) => c.selfThread).map((c) => c.handle)).length > SHARD_QUERY_MAX) close();
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
