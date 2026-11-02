// Exact public article endpoints used by the publisher's own dynamic page, never list collection.
import { guardedFetch } from "../lib/http-fetch.ts";
import { sha256 } from "../lib/ids.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { isTeaser } from "../sources/rss.ts";
import { sanitizeFeedBody, type FeedBodyProof } from "./feed-body.ts";

export type NativeBodyAdapter = "mittrchina" | "speechhome";

export interface RoutineNativeBodyRequest {
  adapter: NativeBodyAdapter;
  originalUrl: string;
  title: string;
}

export interface NativeBodyRequest extends RoutineNativeBodyRequest {
  bodyProof: FeedBodyProof;
}

export interface NativeBodyResult {
  body: { html: string; text: string; images: [] };
  evidence: {
    adapter: NativeBodyAdapter;
    endpoint: string;
    itemId: string;
    itemUrl: string;
    field: "content";
    bodySha256: string;
    tailSha256: string;
    chars: number;
  };
}

function target(adapter: NativeBodyAdapter, originalUrl: string): { id: string; endpoint: string; itemUrl: string } | null {
  try {
    const url = new URL(originalUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return null;
    if (adapter === "mittrchina" && ["www.mittrchina.com", "mittrchina.com"].includes(url.hostname)) {
      const match = /^\/news\/detail\/([1-9]\d{0,9})$/.exec(url.pathname);
      if (match) return { id: match[1]!, endpoint: `https://apii.web.mittrchina.com/information/details?id=${match[1]}`, itemUrl: url.href };
    }
    if (adapter === "speechhome" && ["speechhome.com", "www.speechhome.com"].includes(url.hostname)) {
      const match = /^\/(?:post|blogs\/all)\/([1-9]\d{0,24})$/.exec(url.pathname);
      if (match) return { id: match[1]!, endpoint: `https://speechhome.com/api/api/post/detail/${match[1]}`, itemUrl: url.href };
    }
  } catch { /* not one of the reviewed public article routes */ }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function titleMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  const normalize = (value: string) => collapseWhitespace(stripTags(value)).normalize("NFKC").toLowerCase();
  const wanted = normalize(expected);
  return !!wanted && wanted === normalize(actual);
}

function proofMatches(text: string, proof: FeedBodyProof): boolean {
  if (!proof || !/^[a-f0-9]{64}$/i.test(proof.bodySha256) || !/^[a-f0-9]{64}$/i.test(proof.tailSha256)
    || !Array.isArray(proof.requiredTerms) || !proof.requiredTerms.length || proof.requiredTerms.length > 12
    || proof.requiredTerms.some(term => typeof term !== "string" || term.trim().length < 2 || term.length > 100)) return false;
  const lower = text.normalize("NFKC").toLowerCase();
  return sha256(text) === proof.bodySha256.toLowerCase() && sha256(text.slice(-200)) === proof.tailSha256.toLowerCase()
    && proof.requiredTerms.every(term => lower.includes(term.trim().normalize("NFKC").toLowerCase()));
}

/** Shared publisher identity, access and full-field checks; never reads summary or restricted fields. */
function parsePublicBody(adapter: NativeBodyAdapter, raw: string, originalUrl: string, title: string): NativeBodyResult | null {
  const wanted = target(adapter, originalUrl);
  if (!wanted || typeof raw !== "string" || Buffer.byteLength(raw) > 6 * 1024 * 1024) return null;
  let outer: Record<string, unknown> | null;
  try { outer = record(JSON.parse(raw)); } catch { return null; }
  if (!outer) return null;
  let item: Record<string, unknown> | null;
  if (adapter === "mittrchina") {
    item = record(outer.data);
    // The live public item uses 2; the publisher masks is_vip=1. Unknown values are not permission.
    if (outer.code !== 10000 || !item || item.status !== 1 || item.is_vip !== 2
      || !Number.isSafeInteger(item.id) || String(item.id) !== wanted.id || !titleMatches(title, item.name)) return null;
  } else {
    const data = record(outer.data);
    item = record(data?.result);
    // Preserve the observed public success state; never infer permission for another status.
    if (outer.status !== 200 || data?.isSucceed !== true || !item || item.statusCode !== 0
      || typeof item.id !== "string" || item.id !== wanted.id || !titleMatches(title, item.title)) return null;
  }
  if (typeof item.content !== "string") return null;
  const body = sanitizeFeedBody(item.content, wanted.itemUrl);
  const beginning = collapseWhitespace(body.text).slice(0, 1500);
  if (body.text.length < 200 || isTeaser(body.text)
    || /enable javascript and cookies to continue|verify (?:that )?you are human|performing security verification|needs to review the security of your connection before proceeding|登录后(?:阅读|查看)(?:全文|正文)|付费(?:后|会员)(?:阅读|查看)(?:全文|正文)/i.test(beginning)) return null;
  return { body, evidence: { adapter, endpoint: wanted.endpoint, itemId: wanted.id, itemUrl: wanted.itemUrl, field: "content",
    bodySha256: sha256(body.text), tailSha256: sha256(body.text.slice(-200)), chars: body.text.length } };
}

/** Fixed recovery still requires the reviewed whole-body, tail and topic proof. */
export function parseNativeBody(adapter: NativeBodyAdapter, raw: string, originalUrl: string, title: string, proof: FeedBodyProof): NativeBodyResult | null {
  const parsed = parsePublicBody(adapter, raw, originalUrl, title);
  return parsed && proofMatches(parsed.body.text, proof) ? parsed : null;
}

/** Routine extraction trusts only the verified public content field, exact identity and access state. */
export function parseRoutineNativeBody(adapter: NativeBodyAdapter, raw: string, originalUrl: string, title: string): NativeBodyResult | null {
  return parsePublicBody(adapter, raw, originalUrl, title);
}

async function fetchNativeBody(input: RoutineNativeBodyRequest, parse: (raw: string) => NativeBodyResult | null, retryTransient = false): Promise<NativeBodyResult | null> {
  const wanted = target(input.adapter, input.originalUrl);
  if (!wanted) return null;
  try {
    const response = await guardedFetch(wanted.endpoint, { headers: { accept: "application/json" }, redirectPolicy: "same-origin",
      timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    if (retryTransient && (response.status === 408 || response.status === 429 || response.status >= 500)) throw new Error(`Public body endpoint temporarily unavailable: HTTP ${response.status}`);
    if (response.status !== 200 || response.url !== wanted.endpoint || !/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(response.headers.get("content-type") ?? "")) return null;
    return parse(response.text());
  } catch (error) { if (retryTransient) throw error; return null; }
}

export async function extractNativeBody(input: NativeBodyRequest): Promise<NativeBodyResult | null> {
  if (!input.bodyProof) return null;
  return fetchNativeBody(input, raw => parseNativeBody(input.adapter, raw, input.originalUrl, input.title, input.bodyProof));
}

export async function extractRoutineNativeBody(input: RoutineNativeBodyRequest): Promise<NativeBodyResult | null> {
  return fetchNativeBody(input, raw => parseRoutineNativeBody(input.adapter, raw, input.originalUrl, input.title), true);
}
