// Dajiala (极致了) WeChat official-account data. Paid per request (post_history ¥0.14, article_detail
// ¥0.03); every call goes through receipts and the budget, and the provider's own cost_money is kept
// as the actual cost. Docs: https://s.apifox.cn/410674f9-f451-4b4f-957a-5f54f243bc83
import { credential } from "../config.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { paidRequest, ProviderRejectedError, type CallOutcome } from "./receipts.ts";
import { normalizeUrl } from "../lib/url.ts";

/** Current post_history accepts ghid or a public article URL, not an inferred biz request field. */
export type MpAccountSelector = string | { ghid?: string; articleUrl?: string; biz?: string };

export class MpIdentityError extends ProviderRejectedError {
  constructor(message: string) { super(`dajiala: ${message}`, null, false); }
}

export function mpBizFromUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("dajiala: invalid WeChat article URL"); }
  if (!/^https?:$/.test(url.protocol) || url.hostname !== "mp.weixin.qq.com" || url.username || url.password || url.port
    || !/^\/s(?:\/|$)/.test(url.pathname)) throw new Error("dajiala: expected a public WeChat article URL");
  const biz = url.searchParams.get("__biz");
  if (!biz) return null; // A short link must be resolved by the body service before its account is known.
  const numeric = Buffer.from(biz, "base64").toString("ascii");
  if (!/^\d{8,10}$/.test(numeric) || Buffer.from(numeric).toString("base64") !== biz) throw new Error("dajiala: invalid WeChat biz");
  return biz;
}

export function resolveMpAccountSelector(value: MpAccountSelector): { ghid?: string; articleUrl?: string; biz: string | null } {
  const input = typeof value === "string" ? { ghid: value } : value;
  const ghid = input.ghid?.trim();
  if (ghid && !/^gh_[a-z0-9]+$/i.test(ghid)) throw new Error("dajiala: ghid must be a WeChat original account ID");
  const articleUrl = input.articleUrl?.trim();
  const fromUrl = articleUrl ? mpBizFromUrl(articleUrl) : null;
  if (articleUrl && !fromUrl) throw new Error("dajiala: account selector requires a WeChat long link with biz");
  if (input.biz && (!fromUrl || input.biz !== fromUrl)) throw new Error("dajiala: configured biz and account article URL disagree");
  if (!ghid && !articleUrl) throw new Error("dajiala: account selector is missing");
  return { ...(ghid ? { ghid } : {}), ...(articleUrl ? { articleUrl: normalizeUrl(articleUrl)! } : {}), biz: fromUrl };
}

export interface MpPost {
  position: number;
  url: string;
  title: string;
  post_time: number;
  digest?: string;
  sn?: string;
  cover_url?: string;
  original?: number;
  item_show_type?: number;
}

export interface MpHistory {
  posts: MpPost[];
  nickname: string | null;
  remainMoney: number | null;
  receiptId: number;
  reused: boolean;
  biz: string | null;
  ghid: string | null;
}

export interface MpArticle {
  title: string;
  content: string;
  author: string | null;
  desc: string | null;
  pubtime: string | null;
  receiptId: number;
  url: string | null;
  biz: string | null;
  ghid: string | null;
}

function base(): { url: string; key: string } {
  const key = credential("collectors", "DAJIALA_KEY");
  if (!key) throw new Error("DAJIALA_KEY is not configured");
  return { url: (credential("collectors", "DAJIALA_BASE_URL") ?? "https://www.dajiala.com").replace(/\/$/, ""), key };
}

interface ProviderResponse { code?: number; msg?: string; cost_money?: number }
/** Do not copy the provider's free-form message: it may reflect a request credential. */
function outcomeOf(json: ProviderResponse, label: string): CallOutcome["cost"] {
  const code = Number(json.code);
  if (!Number.isInteger(code)) throw new ProviderRejectedError(`dajiala ${label}: response code missing`, null, false);
  if (code === -1) throw new ProviderRejectedError(`dajiala ${label}: rate limited`, 429, true);
  if ([107, 111, 112, 113, 2003, 2005, 50000].includes(code)) throw new ProviderRejectedError(`dajiala ${label}: temporary provider failure (code ${code})`, code, true);
  if (code === 10002) throw new ProviderRejectedError(`dajiala ${label}: authentication failed (code ${code})`, code, false);
  if (code === 20001) throw new ProviderRejectedError(`dajiala ${label}: insufficient balance (code ${code})`, code, false);
  if (code !== 0) throw new ProviderRejectedError(`dajiala ${label}: rejected (code ${code})`, code, false);
  return actualCost(json);
}

function actualCost(json: ProviderResponse): CallOutcome["cost"] {
  return typeof json.cost_money === "number" && Number.isFinite(json.cost_money) && json.cost_money >= 0
    ? { amount: json.cost_money, currency: "CNY", basis: "actual" } : null;
}

function responseCost(json: ProviderResponse, label: string): CallOutcome["cost"] {
  // The documented 101/104 responses can be billed. Save their answer and actual cost before rejecting
  // the business result, so a repeated check in the same window does not buy the same failure again.
  const cost = actualCost(json);
  if (cost && cost.amount > 0) return cost;
  return outcomeOf(json, label);
}

/** Latest posts of one account (first page, newest first). `window` buckets the receipt identity. */
export async function mpHistory(account: MpAccountSelector, opts: { subject: string; window: string }): Promise<MpHistory> {
  const selector = resolveMpAccountSelector(account);
  const { url, key } = base();
  const receipt = await paidRequest(
    { service: "dajiala", purpose: "mp_history", subject: opts.subject,
      identity: selector.biz ? { biz: selector.biz, window: opts.window } : { ghid: selector.ghid, window: opts.window },
      requestSummary: { ghid: selector.ghid ?? null, articleUrl: selector.articleUrl ?? null, biz: selector.biz } },
    async () => {
      const res = await guardedFetch(`${url}/fbmain/monitor/v3/post_history`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...(selector.ghid ? { ghid: selector.ghid } : { url: selector.articleUrl }), offset: "", key, verifycode: "" }),
        timeoutMs: 30_000,
        route: "direct",
      });
      if (res.status === 429 || res.status >= 500) throw new ProviderRejectedError(`dajiala HTTP ${res.status}`, res.status, true);
      const json = JSON.parse(res.text()) as { code?: number; msg?: string; cost_money?: number };
      const cost = responseCost(json, "post_history");
      return { response: json, cost, usage: { posts: Array.isArray((json as { data?: unknown[] }).data) ? (json as { data: unknown[] }).data.length : 0 } };
    },
  );
  const json = receipt.response as ProviderResponse & { data?: MpPost[]; nickname?: string; ghid?: string; remain_money?: number };
  outcomeOf(json, "post_history");
  if (!Array.isArray(json.data)) throw new ProviderRejectedError("dajiala post_history: article list missing", null, false);
  if (selector.biz) for (const post of json.data) {
    const actual = mpBizFromUrl(post.url);
    if (actual && actual !== selector.biz) throw new MpIdentityError("post_history account biz mismatch");
  }
  if (selector.ghid && json.ghid && json.ghid !== selector.ghid) throw new MpIdentityError("post_history original account ID mismatch");
  return { posts: json.data, nickname: json.nickname ?? null, remainMoney: json.remain_money ?? null, receiptId: receipt.receiptId,
    reused: receipt.reused, biz: selector.biz, ghid: json.ghid ?? selector.ghid ?? null };
}

/** Plain-text body of one article (mode 1: text with image markers). */
export async function mpArticle(articleUrl: string, opts: { subject: string; identity: string; expectedBiz?: string | null }): Promise<MpArticle> {
  if (opts.expectedBiz) {
    const actual = mpBizFromUrl(articleUrl);
    if (actual && actual !== opts.expectedBiz) throw new MpIdentityError("article_detail input account biz mismatch");
  }
  const { url, key } = base();
  const receipt = await paidRequest(
    { service: "dajiala", purpose: "mp_article", subject: opts.subject, identity: { article: opts.identity }, requestSummary: { url: articleUrl } },
    async () => {
      const res = await guardedFetch(`${url}/fbmain/monitor/v3/article_detail?${new URLSearchParams({ url: articleUrl, key, mode: "1", verifycode: "" })}`, {
        redirectPolicy: "same-origin",
        headers: { accept: "application/json" },
        timeoutMs: 30_000,
        maxBytes: 8 * 1024 * 1024,
        route: "direct",
      });
      if (res.status === 429 || res.status >= 500) throw new ProviderRejectedError(`dajiala HTTP ${res.status}`, res.status, true);
      const json = JSON.parse(res.text()) as { code?: number; msg?: string; cost_money?: number };
      const cost = responseCost(json, "article_detail");
      return { response: json, cost, usage: { chars: String((json as { content?: string }).content ?? "").length } };
    },
  );
  const j = receipt.response as ProviderResponse & { title?: string; content?: string; author?: string; desc?: string; pubtime?: string; url?: string; biz?: string; user_name?: string };
  outcomeOf(j, "article_detail");
  if (opts.expectedBiz) {
    let inputBiz: string | null;
    let returnedBiz: string | null;
    try { inputBiz = mpBizFromUrl(articleUrl); returnedBiz = j.url ? mpBizFromUrl(j.url) : null; }
    catch { throw new MpIdentityError("article_detail response is not a public WeChat article URL"); }
    if ((j.biz && j.biz !== opts.expectedBiz) || (returnedBiz && returnedBiz !== opts.expectedBiz)) throw new MpIdentityError("article_detail response account biz mismatch");
    if (!inputBiz && !returnedBiz) throw new MpIdentityError("article_detail short-link account identity unresolved");
    if (inputBiz && returnedBiz && normalizeUrl(articleUrl) !== normalizeUrl(j.url!)) throw new MpIdentityError("article_detail response article identity mismatch");
  }
  return { title: j.title ?? "", content: j.content ?? "", author: j.author || null, desc: j.desc || null, pubtime: j.pubtime ?? null,
    receiptId: receipt.receiptId, url: j.url ? normalizeUrl(j.url) : null, biz: j.biz ?? null, ghid: j.user_name ?? null };
}
