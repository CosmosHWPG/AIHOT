// Jina Reader (r.jina.ai): browser-rendered page text. Paid per request, reached through the egress
// proxy, always behind receipts and the per-minute/hour/day budget (any zero stops it).
import { randomUUID } from "node:crypto";
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { assertAccepted, paidRequest, ProviderRejectedError, receiptState, type ReceiptRequest } from "./receipts.ts";
import { jinaDeniedPublisher } from "../content/body-route.ts";

/** Operator policy is checked before credentials, receipt lookup, budget or HTTP dispatch. */
export class JinaPublisherPolicyError extends ProviderRejectedError {
  constructor() {
    super("Jina is disabled for this publisher; use its approved public body route", null, false);
    this.name = "JinaPublisherPolicyError";
  }
}
import { assertPageContent, contentDocument, UnavailablePageError } from "../lib/page-content.ts";

export interface JinaPage {
  title: string | null;
  url: string | null;
  publishedTime: string | null;
  markdown: string;
}

export function parseJinaText(text: string): JinaPage {
  const separator = CONTENT.exec(text);
  const header = separator ? text.slice(0, separator.index) : text;
  const body = separator ? text.slice(separator.index + separator[0].length) : text;
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(header)?.[1]?.trim() ?? null;
  return { title: field("Title"), url: field("URL Source"), publishedTime: field("Published Time"), markdown: body.trim() };
}

/** A source address read through Jina: this prefix, then the page's own address. */
export const JINA_PREFIX = "https://r.jina.ai/";

/** Jina's answer starts with header lines (Title, URL Source, Published Time); the page follows this line. */
const CONTENT = /\r?\nMarkdown Content:\r?\n/;

/**
 * Reads a page through Jina: `raw` is the whole answer, `markdown` the page after its header lines.
 * The receipt key is the target URL plus the day, so a same-day retry of an article's body or detail
 * reuses it. A listing is read afresh on every fetch (`perRead`): with the day key every later fetch saw
 * the morning's page. Each such read has a receipt of its own, so after one whose outcome is unknown the
 * next fetch pays for a new read instead of waiting on it. A caller that reads on rounds of its own keys the
 * read by its `round`: a retry of the round reuses it, the next round reads afresh.
 */
export async function jinaRead(
  targetUrl: string,
  opts: { purpose: string; subject: string; format?: "markdown" | "html"; cacheToleranceSeconds?: number; perRead?: boolean; round?: string; removeSelector?: string; acceptUnavailable?: boolean },
): Promise<JinaPage & { raw: string; receiptId: number }> {
  if (jinaDeniedPublisher(targetUrl)) throw new JinaPublisherPolicyError();
  const key = credential("collectors", "JINA_API_KEY");
  if (!key) throw new Error("JINA_API_KEY is not configured");
  const base = (credential("collectors", "JINA_BASE_URL") ?? "https://r.jina.ai").replace(/\/$/, "");
  // A listing whose freshness matters (xAI news) caps how old Jina's cached rendering may be.
  const tolerance: Record<string, string> = Number.isInteger(opts.cacheToleranceSeconds) && opts.cacheToleranceSeconds! >= 0 ? { "x-cache-tolerance": String(opts.cacheToleranceSeconds) } : {};
  const remove: Record<string, string> = opts.removeSelector ? { "x-remove-selector": opts.removeSelector } : {};
  const day = new Date().toISOString().slice(0, 10);
  // A per-read listing is keyed by an ID of its own, not the clock: two reads can see the same clock reading.
  const read = opts.round ? { round: opts.round } : opts.perRead ? { read: randomUUID() } : {};
  const identity = { url: targetUrl, day, format: opts.format ?? "markdown", ...read };
  const request: ReceiptRequest = { service: "jina", model: null, purpose: opts.purpose, subject: opts.subject,
    identity: { ...identity, ...remove }, requestSummary: { url: targetUrl } };
  // Older audited body reads omitted the chrome selector. Keep their same-day logical key,
  // including an in-flight or unknown receipt, rather than buying the page again.
  const legacy = { ...request, identity };
  const reuseLegacy = opts.purpose === "body_fallback" && !!opts.removeSelector
    && !(await receiptState(request)) && !!(await receiptState(legacy));
  const receipt = await paidRequest(
    reuseLegacy ? legacy : request,
    async () => {
      const res = await guardedFetch(`${base}/${targetUrl}`, {
        headers: { authorization: `Bearer ${key}`, "x-return-format": opts.format ?? "markdown", accept: "text/plain", ...tolerance, ...remove },
        timeoutMs: 60_000,
        maxBytes: 6 * 1024 * 1024,
      });
      assertAccepted("jina", res.status, res.text());
      // A body receipt must preserve the original UTF-8 response before the page decoder replaces NUL.
      const decoded = opts.purpose === "body_fallback" ? new TextDecoder().decode(res.body) : res.text();
      const originalText = decoded.slice(0, 2_000_000);
      // JSONB rejects NUL and lone surrogates (including a pair split by the existing cap).
      // Preserve the exact truncated UTF-16 units separately only when text needs repair.
      const text = originalText.toWellFormed().replace(/\u0000/g, "");
      const original = text === originalText ? {} : {
        originalText: { encoding: "utf16le", base64: Buffer.from(originalText, "utf16le").toString("base64") },
      };
      // Billed in tokens; estimated at about ¥0.36 per million. Without the usage header nothing is guessed.
      const tokens = Number(res.headers.get("x-usage-tokens")) || null;
      const cost = tokens ? { amount: (tokens / 1e6) * 0.36, currency: "CNY", basis: "estimated" as const } : null;
      return { response: { text, status: res.status, ...original }, requestId: res.headers.get("x-request-id"), usage: { bytes: res.body.length, tokens }, cost };
    },
  );
  const raw = String((receipt.response as { text?: string })?.text ?? "");
  const page = parseJinaText(raw);
  // The renderer has been paid even when the target failed. Validate after saving its receipt,
  // and only read protocol warnings before Markdown Content (an article may quote the same words).
  if (!opts.acceptUnavailable && opts.format === "html") contentDocument(raw);
  else if (!opts.acceptUnavailable) {
    const at = CONTENT.exec(raw)?.index;
    const header = at === undefined ? "" : raw.slice(0, at);
    const failure = /^Warning:.*(?:Target URL returned error [45]\d\d\b|requiring CAPTCHA).*$/im.exec(header);
    if (failure) throw new UnavailablePageError(failure[0]);
    assertPageContent(at === undefined ? "" : page.title ?? "", page.markdown);
  }
  return { ...page, raw, receiptId: receipt.receiptId };
}
