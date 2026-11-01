// Exact public article endpoints used by the publisher's own dynamic page, never list collection.
import { guardedFetch } from "../lib/http-fetch.ts";
import { sha256 } from "../lib/ids.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { isTeaser } from "../sources/rss.ts";
import { sanitizeFeedBody, type FeedBodyProof } from "./feed-body.ts";

export type NativeBodyAdapter = "mittrchina" | "speechhome";

export interface NativeBodyRequest {
  adapter: NativeBodyAdapter;
  originalUrl: string;
  title: string;
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
    if (adapter === "speechhome" && url.hostname === "speechhome.com") {
      const match = /^\/post\/([1-9]\d{0,24})$/.exec(url.pathname);
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

/** Parses only the publisher's normal anonymous response and the exact reviewed public field. */
export function parseNativeBody(adapter: NativeBodyAdapter, raw: string, originalUrl: string, title: string, proof: FeedBodyProof): NativeBodyResult | null {
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
  if (body.text.length < 200 || isTeaser(body.text) || !proofMatches(body.text, proof)
    || /enable javascript and cookies to continue|verify (?:that )?you are human|performing security verification|needs to review the security of your connection before proceeding|登录后(?:阅读|查看)(?:全文|正文)|付费(?:后|会员)(?:阅读|查看)(?:全文|正文)/i.test(beginning)) return null;
  return { body, evidence: { adapter, endpoint: wanted.endpoint, itemId: wanted.id, itemUrl: wanted.itemUrl, field: "content",
    bodySha256: sha256(body.text), tailSha256: sha256(body.text.slice(-200)), chars: body.text.length } };
}

export async function extractNativeBody(input: NativeBodyRequest): Promise<NativeBodyResult | null> {
  const wanted = target(input.adapter, input.originalUrl);
  if (!wanted) return null;
  try {
    const response = await guardedFetch(wanted.endpoint, { headers: { accept: "application/json" }, redirectPolicy: "same-origin",
      timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    if (response.status !== 200 || response.url !== wanted.endpoint || !/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(response.headers.get("content-type") ?? "")) return null;
    return parseNativeBody(input.adapter, response.text(), input.originalUrl, input.title, input.bodyProof);
  } catch { return null; }
}
