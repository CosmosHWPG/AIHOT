import type { SdArticle, SdMedia, SdTweet } from "./socialdata.ts";
import { ProviderRejectedError } from "./receipts.ts";

type Json = Record<string, any>;
export interface BirdTweet extends SdTweet {
  birdContent: {
    kind: "tweet" | "note" | "article"; bodyLevel: "full" | "preview" | "unknown";
    articleTitle?: string; articleId?: string; authorId?: string; pinned?: boolean;
    conversationId?: string; quotedTweetId?: string; repostedTweetId?: string; isRepost?: boolean;
  };
}
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const count = (value: unknown): number | undefined => { const n = Number(value); return value !== undefined && value !== null && Number.isSafeInteger(n) && n >= 0 ? n : undefined; };
function unwrap(raw: Json): Json { return object(raw.tweet ?? raw); }
function protectedAuthor(input: unknown): boolean {
  const row = object(input); const raw = unwrap(object(row._raw ?? row));
  const userResult = object(raw.core?.user_results?.result ?? raw.user_results?.result ?? raw.user);
  const user = object(userResult.user ?? userResult);
  return row.author?.protected === true || row.author?.isProtected === true
    || user.legacy?.protected === true || user.protected === true;
}

/** Remove protected quote/GraphQL subtrees before a raw response is saved in any receipt. */
export function sanitizeBirdPublicPayload(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new ProviderRejectedError("Bird public response nesting exceeds its limit", null, false);
  if (Array.isArray(value)) return value.map(item => sanitizeBirdPublicPayload(item, depth + 1)).filter(item => item !== undefined);
  if (!value || typeof value !== "object") return value;
  const row = object(value);
  if (protectedAuthor(row) || row.legacy?.protected === true || row.protected === true) return undefined;
  return Object.fromEntries(Object.entries(row).flatMap(([key, item]) => {
    const safe = sanitizeBirdPublicPayload(item, depth + 1); return safe === undefined ? [] : [[key, safe]];
  }));
}
function rawAsBird(rawInput: Json): Json {
  const raw = unwrap(rawInput); const legacy = object(raw.legacy); const user = object(raw.core?.user_results?.result);
  const article = object(raw.article?.article_results?.result ?? raw.article);
  return { id: raw.rest_id, text: legacy.full_text, createdAt: legacy.created_at, authorId: user.rest_id,
    author: { username: user.core?.screen_name ?? user.legacy?.screen_name, name: user.core?.name ?? user.legacy?.name },
    replyCount: legacy.reply_count, retweetCount: legacy.retweet_count, likeCount: legacy.favorite_count,
    conversationId: legacy.conversation_id_str, inReplyToStatusId: legacy.in_reply_to_status_id_str,
    ...(Object.keys(article).length ? { article: { title: article.title, previewText: article.preview_text } } : {}), _raw: raw };
}

/** Exact IDs and actor/date evidence are mandatory; a malformed row cannot advance source coverage. */
export function normalizeBirdTweet(input: unknown, context: "timeline" | "read" = "timeline", depth = 0): BirdTweet {
  const row = object(input); const raw = unwrap(object(row._raw)); const legacy = object(raw.legacy);
  if (protectedAuthor(row)) throw new ProviderRejectedError("Bird target is not public", 404, false);
  const id = text(row.id); const actor = object(row.author); const handle = text(actor.username).replace(/^@/, "");
  const createdAt = text(row.createdAt);
  if (!/^\d+$/.test(id) || !/^[A-Za-z0-9_]{1,15}$/.test(handle) || !Number.isFinite(Date.parse(createdAt))) {
    throw new ProviderRejectedError("Bird tweet missing valid id, actor or original date", null, false);
  }
  const article = object(row.article); const rawArticle = object(raw.article?.article_results?.result ?? raw.article);
  const articleTitle = text(article.title ?? rawArticle.title).trim();
  const articleId = text(rawArticle.rest_id ?? rawArticle.id ?? article.id);
  const note = object(raw.note_tweet?.note_tweet_results?.result);
  let body = text(note.text ?? note.richtext?.text ?? note.rich_text?.text ?? row.text ?? legacy.full_text).trim();
  let bodyLevel: BirdTweet["birdContent"]["bodyLevel"] = body ? "full" : "unknown";
  const hasArticle = Boolean(articleTitle || Object.keys(rawArticle).length);
  if (hasArticle) {
    const fullBlocks: string = Array.isArray(rawArticle.content_state?.blocks)
      ? rawArticle.content_state.blocks.map((block: Json) => text(block.text)).filter(Boolean).join("\n\n") : "";
    const plain = text(rawArticle.plain_text).trim() || text(rawArticle.body?.text).trim();
    if (plain || fullBlocks) body = [articleTitle, plain || fullBlocks].filter(Boolean).join("\n\n");
    // A read response's mapped text can still be the author's comment and a link after Article
    // fallback failed. Only the raw Article body fields prove that the Article itself was received.
    const bodyEvidence = (plain || fullBlocks).split(/\r?\n/)
      .filter(line => line.trim().replace(/^#{1,6}\s+/, "") !== articleTitle).join("\n").trim();
    bodyLevel = bodyEvidence ? "full" : "preview";
  }
  const nested = (value: unknown): BirdTweet | null => {
    if (!value || depth >= 2) return null;
    const nestedRow = object(value);
    try { return normalizeBirdTweet(nestedRow.id ? nestedRow : rawAsBird(nestedRow), context, depth + 1); } catch { return null; }
  };
  const quote = nested(row.quotedTweet ?? raw.quoted_status_result?.result);
  const repostRaw = row.retweetedTweet ?? raw.retweeted_status_result?.result ?? legacy.retweeted_status_result?.result;
  const repost = nested(repostRaw);
  const quotedTweetId = text(row.quotedStatusId ?? legacy.quoted_status_id_str ?? quote?.id_str);
  const repostedTweetId = text(row.retweetedStatusId ?? object(repostRaw).id ?? object(repostRaw).rest_id ?? repost?.id_str);
  const entities = object(note.entity_set ?? note.entities ?? legacy.entities);
  const urls = (Array.isArray(entities.urls) ? entities.urls : []).flatMap((u: Json) => {
    const url = text(u.url); const expanded = text(u.expanded_url ?? u.expandedUrl);
    return url && expanded && /^https?:\/\//i.test(expanded) ? [{ url, expanded_url: expanded }] : [];
  });
  const media: SdMedia[] = (Array.isArray(row.media) ? row.media : []).flatMap((m: Json) => {
    const url = text(m.url); if (!["photo", "video", "animated_gif"].includes(m.type) || !/^https?:\/\//i.test(url)) return [];
    return [{ type: m.type, media_url_https: url }];
  });
  return { id_str: id, tweet_created_at: new Date(createdAt).toISOString(), full_text: body,
    user: { screen_name: handle, name: text(actor.name) || handle, profile_image_url_https: text(actor.profileImageUrl) || undefined },
    in_reply_to_status_id_str: text(row.inReplyToStatusId ?? legacy.in_reply_to_status_id_str) || null,
    quoted_status: quote, retweeted_status: repost, is_quote_status: Boolean(quotedTweetId || quote), entities: { urls }, extended_entities: { media },
    favorite_count: count(row.likeCount ?? legacy.favorite_count), retweet_count: count(row.retweetCount ?? legacy.retweet_count),
    reply_count: count(row.replyCount ?? legacy.reply_count), quote_count: count(legacy.quote_count), views_count: count(raw.views?.count),
    birdContent: { kind: hasArticle ? "article" : Object.keys(note).length ? "note" : "tweet", bodyLevel,
      ...(articleTitle ? { articleTitle } : {}), ...(articleId ? { articleId } : {}), ...(row.authorId ? { authorId: String(row.authorId) } : {}),
      ...(row.pinned === true ? { pinned: true } : {}), ...(row.conversationId ? { conversationId: String(row.conversationId) } : {}),
      ...(quotedTweetId ? { quotedTweetId } : {}), ...(repostedTweetId ? { repostedTweetId } : {}),
      ...(repostRaw ? { isRepost: true } : {}) },
  };
}

export function decodeBirdTweets(payload: unknown, context: "timeline" | "read" = "timeline"): { tweets: BirdTweet[]; nextCursor: string | null } {
  const container = object(payload); const items = Array.isArray(payload) ? payload : container.tweets;
  if (!Array.isArray(items)) throw new ProviderRejectedError("Bird timeline response is missing tweets", null, false);
  const cursor = container.nextCursor;
  if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || cursor.length > 8192)) {
    throw new ProviderRejectedError("Bird returned an invalid pagination cursor", null, false);
  }
  return { tweets: items.map(row => normalizeBirdTweet(row, context)), nextCursor: cursor || null };
}
export function birdTweetArticle(tweet: BirdTweet | null): SdArticle | null {
  if (!tweet || tweet.birdContent.kind !== "article" || tweet.birdContent.bodyLevel !== "full") return null;
  const title = tweet.birdContent.articleTitle ?? "";
  const textBody = (tweet.full_text ?? "").trim();
  const body = title && textBody.startsWith(title) ? textBody.slice(title.length).trim() : textBody;
  if (!body) return null;
  return { title, content_state: { blocks: [{ type: "unstyled", text: body }] } };
}

export function parseBirdWhoami(stdout: string): { id?: string; username: string; name?: string } {
  const username = /@([A-Za-z0-9_]{1,15})\b/.exec(stdout)?.[1];
  if (!username) throw new ProviderRejectedError("Bird whoami did not report a valid authenticated username", null, false);
  const id = stdout.split(/\r?\n/).map(line => /(?:🪪|user_?id:?)[^\d]*(\d{2,})/i.exec(line)?.[1]
    ?? (!/[A-Za-z@]/.test(line) ? /^\D*(\d{2,})\D*$/.exec(line)?.[1] : undefined)).find(Boolean);
  const name = /@[A-Za-z0-9_]{1,15}\s*\(([^)]+)\)/.exec(stdout)?.[1]?.trim();
  return { username, ...(id ? { id } : {}), ...(name ? { name } : {}) };
}
