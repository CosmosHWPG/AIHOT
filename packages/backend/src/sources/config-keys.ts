// The config keys each kind of source implements. Anything else is refused: a key a collector does not
// know would otherwise fall back silently to the generic parse (menus and sentence fragments as
// articles, dates never found).
import type { SourceRow } from "./types.ts";

// Rules applied in collect.ts to every kind read through collectSource.
const PUBLISHER = ["publisherRole", "publisherUrlPrefixes", "publisherRequiresDiscovery"];
const COLLECTED = [...PUBLISHER, "_aihot", "allowUrlPrefixes", "denyUrlPrefixes", "ingestNoiseFilter", "itemUrlPrefixRewrite", "sortByPublishedAt", "detail", "fetchPublicContent", "publishedAfter", "acceptLanguage"];

const KEYS: Record<SourceRow["kind"], string[]> = {
  rss: [...COLLECTED, "feedUrl", "summaryIsBody", "preserveUrlFragment", "allowCategories", "denyCategories", "publishedAtUtcOffset"],
  web_list: [
    ...COLLECTED, "url", "baseUrl", "parseMode", "adapter", "cacheToleranceSeconds", "linksStartLine", "preserveUrlFragment",
    "itemSelector", "linkSelector", "titleSelector", "summarySelector", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset",
    "itemUrlPattern", "minTitleLength", "requirePublishedAt", "sameOrigin",
  ],
  json_list: [
    ...COLLECTED, "url", "mode", "method", "headers", "bodyJson", "jsonKey", "windowVar", "itemsPath", "itemsObjectValues",
    "titlePaths", "summaryPaths", "summaryIsBody", "authorPaths", "publishedAtPath", "publishedAtUnit", "publishedAtUtcOffset", "externalIdPath",
    "urlTemplate", "urlTemplateFallback", "publishedAtForFallbackUrl", "rawDropKeys", "requireBoolean", "minNumeric",
  ],
  x_search: [...PUBLISHER, "_aihot", "ingestNoiseFilter", "itemUrlPrefixRewrite", "query", "searchType", "xUserId", "provider", "bird"],
  mp_account: [...PUBLISHER, "wxid", "ghid", "nickname", "transport", "account", "limit", "lookbackDays", "cacheDirectoryEnv", "fetchPublicContent", "articleUrl", "biz"],
  external: [...PUBLISHER],
};

// Objects with fixed keys (headers and bodyJson are request data, free-form).
const NESTED: Record<string, string[]> = {
  bird: ["accountProfile", "strategy", "initialLookbackHours", "maxPagesPerRound"],
  _aihot: ["initialBackfillLimit", "initialBackfillMonths"],
  ingestNoiseFilter: ["dropMarkers", "dropMarkersTitleOnly", "keepIfMatches"],
  itemUrlPrefixRewrite: ["from", "to"],
  requireBoolean: ["path", "equals"],
  minNumeric: ["path", "min"],
  detail: [
    "maxFetches", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset", "publishedAtAuthoritative", "upgradeDatePrecision", "requirePublishedAt",
    "titleSelector", "titleRegex", "titleAuthoritative", "summarySelector", "preserve", "bodyUrlSuffix",
  ],
};

/** Article widgets to preserve (PreserveRule in content/extract.ts): { selector, as: "pre" | "table" }, a code block's `code` and `caption` parts. */
const preserveRules = (value: unknown) => Array.isArray(value) && value.every((rule) => {
  if (!rule || typeof rule !== "object") return false;
  const selector = (key: string) => typeof rule[key] === "string" && rule[key].trim() !== "";
  const parts = rule.as === "pre" ? ["code", "caption"] : rule.as === "table" ? [] : null;
  return parts !== null && selector("selector") && Object.keys(rule).every((key) => key === "selector" || key === "as" || parts.includes(key) && selector(key));
});

const VALUES: Record<string, string[]> = {
  publisherRole: ["organization", "person"],
  adapter: ["mimo_home", "article_links"],
  parseMode: ["html", "markdown", "docusaurus_changelog", "dated_sections", "markdown_changelog", "intercom_changelog"],
  provider: ["socialdata", "xquik", "bird"],
  transport: ["dajiala", "wx_cache"],
};

// An Accept-Language value: language ranges with optional weights, e.g. "en-US,en;q=0.9".
const LANGUAGE_RANGE = String.raw`(?:[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*|\*)(?:;q=(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?))?`;
const ACCEPT_LANGUAGE = new RegExp(`^${LANGUAGE_RANGE}(?: *, *${LANGUAGE_RANGE})*$`);

function utcInstant(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === (value.includes(".") ? value : value.replace(/Z$/, ".000Z"));
}

/** The config entries a source of this kind would ignore or cannot run, e.g. ["adapter=site_cards", "detail.titleFoo"]. */
export function unsupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): string[] {
  const allowed = new Set(KEYS[kind] ?? []);
  const out: string[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!allowed.has(key)) out.push(key);
    else if (key === "publisherRequiresDiscovery" && (typeof value !== "boolean"
      || value && (!Array.isArray(config.publisherUrlPrefixes) || config.publisherUrlPrefixes.length === 0))) out.push(key);
    else if (key === "xUserId" && (typeof value !== "string" || !/^\d+$/.test(value))) out.push(key);
    else if (key === "publishedAfter" && !utcInstant(value)) out.push(key);
    else if (key === "publishedAtForFallbackUrl" && (typeof value !== "boolean"
      || value && (!config.urlTemplate || !config.urlTemplateFallback || !config.publishedAtPath))) out.push(key);
    else if (key === "acceptLanguage" && (typeof value !== "string" || !ACCEPT_LANGUAGE.test(value))) out.push(key);
    else if (key === "publisherUrlPrefixes" && (!Array.isArray(value) || !value.every((v) => {
      if (typeof v !== "string") return false;
      try { const u = new URL(v); return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
    }))) out.push(key);
    else if (VALUES[key] && !VALUES[key]!.includes(String(value))) out.push(`${key}=${String(value)}`);
    else if (NESTED[key] && value && typeof value === "object") {
      for (const sub of Object.keys(value)) if (!NESTED[key]!.includes(sub)) out.push(`${key}.${sub}`);
      if (key === "detail" && "preserve" in value && !preserveRules((value as { preserve: unknown }).preserve)) out.push("detail.preserve");
    }
  }
  const detail = config.detail as Record<string, unknown> | undefined;
  if (detail?.requirePublishedAt !== undefined && typeof detail.requirePublishedAt !== "boolean") out.push("detail.requirePublishedAt");
  if (kind === "x_search" && config.provider === "bird") {
    const bird = config.bird as Record<string, unknown> | undefined;
    if (bird !== undefined && (!bird || typeof bird !== "object" || Array.isArray(bird))) out.push("bird");
    else if (bird) {
      if (bird.strategy !== undefined && bird.strategy !== "user_tweets") out.push("bird.strategy");
      if (bird.accountProfile !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(bird.accountProfile))) out.push("bird.accountProfile");
      if (bird.initialLookbackHours !== undefined && (!Number.isInteger(bird.initialLookbackHours) || Number(bird.initialLookbackHours) < 1 || Number(bird.initialLookbackHours) > 48)) out.push("bird.initialLookbackHours");
      if (bird.maxPagesPerRound !== undefined && (!Number.isInteger(bird.maxPagesPerRound) || Number(bird.maxPagesPerRound) < 1 || Number(bird.maxPagesPerRound) > 5)) out.push("bird.maxPagesPerRound");
    }
    if (!/^from:[A-Za-z0-9_]{1,15} -filter:replies$/i.test(String(config.query ?? ""))) out.push("bird.query");
    if (config.searchType !== undefined && config.searchType !== "Latest") out.push("bird.searchType");
  } else if (kind === "x_search" && config.bird !== undefined) out.push("bird requires provider=bird");
  return out;
}

export class UnsupportedConfig extends Error {
  readonly statusCode = 400;
}

/** Refuses a config with entries its kind does not implement (admin create, edit and preview). */
export function assertSupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): void {
  const bad = unsupportedConfig(kind, config);
  if (bad.length) throw new UnsupportedConfig(`不支持的配置项：${bad.join("、")}`);
}
