// Public WeChat article records; transport diagnostics never become article bodies.
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { parseLooseDate } from "./web-list.ts";
import { FetchError, type Candidate } from "./types.ts";

function rows(value: unknown, depth = 0): Record<string, unknown>[] | null {
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.filter((item) => item !== null && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown>[];
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const key of ["articles", "items", "list", "data", "results"]) {
    if (obj[key] !== undefined) {
      const found = rows(obj[key], depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function first(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) if (typeof row[key] === "string" && (row[key] as string).trim()) return (row[key] as string).trim();
  return "";
}

/** wx timestamps are seconds or milliseconds; unzoned printed dates are mainland China time. */
export function wxPublishedAt(row: Record<string, unknown>): Date | null {
  for (const key of ["timestamp", "time_ts", "recv_time", "create_time"]) {
    if (row[key] === null || row[key] === undefined || row[key] === "") continue;
    const value = Number(row[key]);
    if (!Number.isFinite(value) || value <= 0) continue;
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    if (Number.isFinite(date.getTime())) return date;
  }
  const printed = first(row, ["time", "recv_time_str", "publish_time", "published", "datetime"]);
  return parseLooseDate(/^\d{4}-\d{2}-\d{2}$/.test(printed) ? `${printed}T00:00:00+08:00` : printed, "+08:00");
}

/** Invalid output is an error; a recognized empty JSON array is a successful empty check. */
export function parseWxArticles(stdout: string, account: string): Candidate[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.trim()); }
  catch { throw new FetchError("wechat: output is not JSON"); }
  const articles = rows(parsed);
  if (articles === null) throw new FetchError("wechat: article list missing");
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const article of articles) {
    const title = collapseWhitespace(stripTags(first(article, ["title", "name"])));
    const original = first(article, ["url", "link", "article_url"]);
    if (!title || !original) continue;
    let url: URL;
    try { url = new URL(original); }
    catch { continue; }
    // WeChat collection must not turn an arbitrary linked page into another source's article.
    if (!/^https?:$/.test(url.protocol) || url.hostname.toLowerCase() !== "mp.weixin.qq.com" || !/^\/s(?:\/|$)/.test(url.pathname)) continue;
    if (seen.has(url.toString())) continue;
    seen.add(url.toString());
    const excerpt = collapseWhitespace(stripTags(first(article, ["digest", "summary", "desc"]))).slice(0, 2000) || null;
    const content = first(article, ["content", "body_html", "body"]);
    const bodyHtml = content ? sanitizeBody(content, url.toString()) : null;
    const bodyText = bodyHtml ? stripTags(bodyHtml) : null;
    const cover = first(article, ["cover_url", "cover"]);
    candidates.push({
      url: url.toString(), title,
      author: first(article, ["author", "account"]) || account,
      language: "zh", publishedAt: wxPublishedAt(article), excerpt,
      bodyHtml, bodyText: bodyText || null, bodyStatus: bodyText ? "ok" : "pending",
      ...(cover && /^https?:\/\//.test(cover) ? { media: [{ kind: "image", url: cover }] } : {}),
      raw: { wechat: { account, accountUsername: first(article, ["account_username"]) || null } },
    });
  }
  if (articles.length && !candidates.length) throw new FetchError("wechat: no valid WeChat article records");
  return candidates;
}
