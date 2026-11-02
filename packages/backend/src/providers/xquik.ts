// Read-only Xquik REST routes, matching the official Python SDK 0.8.0 contract.
// No monitor, webhook, account provisioning or X write endpoint is exposed.
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { paidRequest, ProviderRejectedError } from "./receipts.ts";
import type { SdArticle, SdTweet, SearchResult } from "./socialdata.ts";

type Json = Record<string, any>;
const value = (row: Json, ...keys: string[]) => keys.map(k => row[k]).find(v => v !== undefined && v !== null);

export function xquikSetting(name: string, fallback: number, min = 1, max = 10_000_000): number {
  const configured = credential("collectors", name);
  const number = configured === null ? fallback : Number(configured);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}`);
  return number;
}

function auth() {
  const key = credential("collectors", "X_TWITTER_SCRAPER_API_KEY");
  if (!key) throw new Error("X_TWITTER_SCRAPER_API_KEY is not configured");
  return { "x-api-key": key, accept: "application/json" };
}
function base() {
  return (credential("collectors", "XQUIK_BASE_URL") ?? "https://xquik.com/api/v1").replace(/\/$/, "");
}

async function read(route: string): Promise<Json | null> {
  const response = await guardedFetch(`${base()}${route}`, {
    headers: auth(), timeoutMs: 60_000, maxBytes: 12 * 1024 * 1024,
    // Egress preserves the configured local proxy; origin-bound auth never crosses a redirect.
    redirectPolicy: "same-origin",
  });
  if (response.status === 404) return null;
  if (response.status !== 200) {
    // Provider bodies can contain secret request echoes; only record status and safe category.
    throw new ProviderRejectedError(`xquik HTTP ${response.status}`, response.status, response.status === 429 || response.status >= 500);
  }
  const parsed = JSON.parse(response.text());
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("xquik invalid response object");
  return parsed;
}

/** Free account read, also useful for an operator's bounded authentication check. */
export async function xquikAccountBalance(): Promise<number> {
  const account = await read("/account");
  const raw = account ? value(account, "creditInfo", "credit_info", "credits") : null;
  const balance = Number(raw?.balance ?? account?.balance);
  if (!Number.isSafeInteger(balance) || balance < 0) throw new Error("xquik account credit balance unavailable");
  return balance;
}

function creditBudget(maximum: number) {
  return {
    maximum, dailyLimit: xquikSetting("XQUIK_DAILY_CREDIT_LIMIT", 250),
    reserve: xquikSetting("XQUIK_CREDIT_RESERVE", 100, 0), availableCredits: xquikAccountBalance,
  };
}

/** Preserve long Note Tweet text, exact actor, source time and optional quote context. */
export function normalizeXquikTweet(row: Json, depth = 0): SdTweet {
  const id = String(value(row, "id", "id_str") ?? "");
  const author = row.author ?? row.user ?? {};
  const handle = String(value(author, "username", "screen_name", "screenName") ?? "").replace(/^@/, "");
  const createdAt = String(value(row, "createdAt", "created_at", "tweet_created_at") ?? "");
  if (!/^\d+$/.test(id) || !/^[A-Za-z0-9_]{1,15}$/.test(handle) || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("xquik tweet missing valid id, actor or original date");
  }
  const note = value(row, "noteTweet", "note_tweet");
  let text = String(note?.text ?? value(row, "text", "fullText", "full_text") ?? "");
  const article = row.article;
  if (article?.id && !/https?:\/\/(?:x|twitter)\.com\/i\/article\//i.test(text)) text += `\nhttps://x.com/i/article/${article.id}`;
  const media = (Array.isArray(row.media) ? row.media : []).flatMap((m: Json) => {
    const url = value(m, "mediaUrl", "media_url", "media_url_https");
    if (!url || !["photo", "video", "animated_gif"].includes(m.type)) return [];
    return [{ type: m.type, media_url_https: String(url), original_info: { width: Number(m.width) || 0, height: Number(m.height) || 0 } }];
  });
  const nested = (raw: Json | undefined): SdTweet | null => {
    if (!raw || depth >= 2) return null;
    try { return normalizeXquikTweet(raw, depth + 1); } catch { return null; }
  };
  const entities = note?.entities ?? row.entities;
  return {
    id_str: id, tweet_created_at: new Date(createdAt).toISOString(), full_text: text, lang: row.lang ?? null,
    user: { screen_name: handle, name: String(author.name ?? handle), profile_image_url_https: value(author, "profileImageUrl", "profile_image_url", "profile_image_url_https") },
    in_reply_to_status_id_str: value(row, "inReplyToId", "in_reply_to_id") ?? null,
    quoted_status: nested(value(row, "quotedTweet", "quoted_tweet")),
    retweeted_status: nested(value(row, "retweetedTweet", "retweeted_tweet")),
    entities: { urls: (Array.isArray(entities?.urls) ? entities.urls : []).map((u: Json) => ({ url: String(u.url ?? ""), expanded_url: String(value(u, "expandedUrl", "expanded_url") ?? u.url ?? "") })) },
    extended_entities: { media }, favorite_count: Number(value(row, "likeCount", "like_count")) || 0,
    retweet_count: Number(value(row, "retweetCount", "retweet_count")) || 0,
    reply_count: Number(value(row, "replyCount", "reply_count")) || 0,
    quote_count: Number(value(row, "quoteCount", "quote_count")) || 0,
    views_count: Number(value(row, "viewCount", "view_count")) || 0,
  };
}

export async function searchXquikTweets(query: string, opts: { purpose: string; subject: string; window: string; type?: "Latest" | "Top"; cursor?: string | null; limit?: number }): Promise<SearchResult> {
  auth();
  const limit = Math.min(opts.limit ?? 100, xquikSetting("XQUIK_PAGE_LIMIT", 5, 1, 100));
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid xquik search limit");
  const type = opts.type ?? "Latest";
  const result = await paidRequest({
    service: "xquik", purpose: opts.purpose, subject: opts.subject, requireBudget: true, creditBudget: creditBudget(limit),
    identity: { query, type, cursor: opts.cursor ?? null, limit, window: opts.window }, requestSummary: { query, type, limit },
  }, async () => {
    const params = new URLSearchParams({ q: query, queryType: type, limit: String(limit) });
    if (opts.cursor) params.set("cursor", opts.cursor);
    const response = await read(`/x/tweets/search?${params}`);
    if (!response || !Array.isArray(response.tweets)) throw new Error("xquik search response missing tweets");
    // Validate before saving a reusable answer; a malformed actor must never advance a watermark.
    response.tweets.map((row: Json) => normalizeXquikTweet(row));
    return { response, usage: { tweets: response.tweets.length, credits: response.tweets.length },
      cost: { amount: response.tweets.length, currency: "CREDITS", basis: "estimated" as const } };
  });
  const response = result.response as Json;
  const next = value(response, "next_cursor", "nextCursor");
  const more = value(response, "has_next_page", "hasNextPage", "has_more", "hasMore");
  return { tweets: response.tweets.map((row: Json) => normalizeXquikTweet(row)), nextCursor: more === false ? null : next ? String(next) : null,
    receiptId: result.receiptId, reused: result.reused };
}

export async function getXquikArticle(tweetId: string, opts: { purpose: string; subject: string }): Promise<SdArticle | null> {
  if (!/^\d+$/.test(tweetId)) throw new Error("Invalid X post id");
  auth();
  const result = await paidRequest({ service: "xquik", purpose: opts.purpose, subject: opts.subject,
    identity: { article: tweetId }, requestSummary: { article: tweetId }, requireBudget: true, creditBudget: creditBudget(5),
  }, async () => {
    const response = await read(`/x/articles/${tweetId}`);
    return { response, usage: { articles: response?.article ? 1 : 0, credits: response?.article ? 5 : 0 },
      cost: { amount: response?.article ? 5 : 0, currency: "CREDITS", basis: "estimated" as const } };
  });
  const article = (result.response as Json | null)?.article;
  if (!article) return null;
  const blocks = value(article, "contents", "content_blocks", "contentBlocks");
  const body = value(article, "bodyText", "body_text");
  const textBlocks = Array.isArray(blocks) ? blocks.filter((b: Json) => !["media", "divider", "atomic"].includes(b.type) && b.text)
    .map((b: Json) => ({ type: b.type, text: String(b.text) })) : [];
  return { title: String(article.title ?? ""), content_state: { blocks: textBlocks.length ? textBlocks
    : body ? [{ type: "unstyled", text: String(body) }] : [] } };
}
