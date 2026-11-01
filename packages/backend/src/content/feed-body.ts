// Exact-article body lookup in an already approved feed, never a source/list collector.
import { XMLParser } from "fast-xml-parser";
import { guardedFetch } from "../lib/http-fetch.ts";
import { sha256 } from "../lib/ids.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { isTeaser } from "../sources/rss.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";

export interface FeedBodyProof {
  bodySha256: string;
  /** Hash of the final 200 characters of the reviewed, cleaned body. */
  tailSha256: string;
  requiredTerms: readonly string[];
}

export interface FeedBodyRequest {
  originalUrl: string;
  title: string;
  feedUrl: string;
  /** Fixed recovery callers must bind whichever field the publisher actually supplies. */
  requireProof?: boolean;
  /** Optional exact reviewed body binding for content:encoded. */
  bodyProof?: FeedBodyProof;
  /** description is never a body unless this single-article proof is supplied. */
  descriptionProof?: FeedBodyProof;
}

export interface FeedBodyResult {
  body: { html: string; text: string; images: [] };
  evidence: {
    feedUrl: string;
    itemUrl: string;
    field: "content:encoded" | "description";
    bodySha256: string;
    tailSha256: string;
    chars: number;
  };
}

/** This same cleaning order is used when freezing a reviewed body proof. */
export function sanitizeFeedBody(rawHtml: string, originalUrl: string): FeedBodyResult["body"] {
  const html = trimTrailingChrome(sanitizeBody(rawHtml, originalUrl));
  return { html, text: stripTags(html), images: [] };
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text",
  cdataPropName: "#cdata", processEntities: true, htmlEntities: true });
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 4;
type FeedItem = { url: string; title: string; encoded: string; description: string };
const cache = new Map<string, { expires: number; result: Promise<FeedItem[] | null> }>();

function scalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return scalar(obj["#cdata"] ?? obj["#text"]);
  }
  return "";
}
const list = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value];

function plainUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || [...url.searchParams.keys()].some(key => /^(?:token|auth|authorization|api[_-]?key|secret|password|cookie|credential|signature|session)$/i.test(key))) return null;
    return url;
  } catch { return null; }
}

/** Preserve article selectors and fragments. Only known analytics keys are irrelevant to identity. */
function canonical(value: string): string | null {
  const url = plainUrl(value);
  if (!url) return null;
  for (const [key, val] of [...url.searchParams]) {
    if (/^(?:utm_[a-z_]+|fbclid|gclid|mc_cid|mc_eid)$/i.test(key)
      || (key.toLowerCase() === "source" && /^rss[-\w]+$/i.test(val))) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

function titleMatches(expected: string, actual: string): boolean {
  const normalize = (s: string) => collapseWhitespace(stripTags(s)).normalize("NFKC").toLowerCase();
  const a = normalize(expected), b = normalize(actual);
  if (!a || !b) return false;
  if (a === b) return true;
  // A feed may supply the last word omitted by an aggregator (e.g. "worldwide").
  const shorter = a.length < b.length ? a : b, longer = a.length < b.length ? b : a;
  return shorter.length >= 30 && shorter.length / longer.length >= 0.8 && longer.startsWith(shorter + " ");
}

function proofMatches(text: string, proof: FeedBodyProof): boolean {
  if (!/^[a-f0-9]{64}$/i.test(proof.bodySha256) || !/^[a-f0-9]{64}$/i.test(proof.tailSha256)
    || !Array.isArray(proof.requiredTerms) || !proof.requiredTerms.length || proof.requiredTerms.length > 12
    || proof.requiredTerms.some(term => typeof term !== "string" || term.trim().length < 2 || term.length > 100)) return false;
  const lower = text.normalize("NFKC").toLowerCase();
  return sha256(text) === proof.bodySha256.toLowerCase() && sha256(text.slice(-200)) === proof.tailSha256.toLowerCase()
    && proof.requiredTerms.every(term => lower.includes(term.trim().normalize("NFKC").toLowerCase()));
}

async function loadFeed(feedUrl: string): Promise<FeedItem[] | null> {
  const now = Date.now();
  for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
  const cached = cache.get(feedUrl);
  if (cached) return cached.result;
  while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  const result = (async () => {
    try {
      const response = await guardedFetch(feedUrl, { headers: { accept: "application/rss+xml, application/xml;q=0.9" },
        redirectPolicy: "same-origin", timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 });
      if (response.status !== 200 || !plainUrl(response.url) || new URL(response.url).origin !== new URL(feedUrl).origin) return null;
      const raw = response.text();
      // No custom entities, HTML challenge document or permissive fallback parser.
      if (/<!DOCTYPE|<!ENTITY/i.test(raw)) return null;
      const doc = parser.parse(raw);
      const channel = doc.rss?.channel;
      if (!channel || typeof channel !== "object" || Array.isArray(channel)) return null;
      const items = list(channel.item);
      if (items.length > 2000) return null;
      return items.flatMap((value): FeedItem[] => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const item = value as Record<string, unknown>;
        const url = scalar(item.link);
        return url ? [{ url, title: scalar(item.title), encoded: scalar(item["content:encoded"]), description: scalar(item.description) }] : [];
      });
    } catch { return null; }
  })();
  cache.set(feedUrl, { expires: now + CACHE_TTL_MS, result });
  return result;
}

export async function extractFeedBody(input: FeedBodyRequest): Promise<FeedBodyResult | null> {
  const original = plainUrl(input.originalUrl), feed = plainUrl(input.feedUrl);
  const wanted = canonical(input.originalUrl);
  if (!original || !feed || !wanted || !input.title.trim()) return null;
  const items = await loadFeed(feed.href);
  if (!items) return null;
  const matches = items.filter(item => canonical(item.url) === wanted);
  if (matches.length !== 1) return null;
  const item = matches[0]!;
  if (new URL(item.url).origin !== original.origin || !titleMatches(input.title, item.title)) return null;
  const field = item.encoded.trim() ? "content:encoded" : "description";
  const proof = field === "content:encoded" ? input.bodyProof : input.descriptionProof;
  if ((field === "description" || input.requireProof) && !proof) return null;
  const body = sanitizeFeedBody(field === "content:encoded" ? item.encoded : item.description, input.originalUrl);
  if (body.text.length <= 280 || isTeaser(body.text) || (proof && !proofMatches(body.text, proof))) return null;
  return { body, evidence: { feedUrl: feed.href, itemUrl: item.url, field, chars: body.text.length,
    bodySha256: sha256(body.text), tailSha256: sha256(body.text.slice(-200)) } };
}
