// The config keys each kind of source implements. Anything else is refused: a key a collector does not
// know would otherwise fall back silently to the generic parse (menus and sentence fragments as
// articles, dates never found).
import type { SourceRow } from "./types.ts";

// Rules applied in collect.ts to every kind read through collectSource.
const COLLECTED = ["_aihot", "allowUrlPrefixes", "denyUrlPrefixes", "ingestNoiseFilter", "itemUrlPrefixRewrite", "sortByPublishedAt", "detail", "fetchPublicContent"];

const KEYS: Record<SourceRow["kind"], string[]> = {
  rss: [...COLLECTED, "feedUrl", "summaryIsBody", "preserveUrlFragment", "allowCategories", "denyCategories"],
  web_list: [
    ...COLLECTED, "url", "baseUrl", "parseMode", "adapter", "cacheToleranceSeconds", "linksStartLine", "preserveUrlFragment",
    "itemSelector", "linkSelector", "titleSelector", "summarySelector", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset",
    "itemUrlPattern", "minTitleLength", "requirePublishedAt", "sameOrigin",
  ],
  json_list: [
    ...COLLECTED, "url", "mode", "method", "headers", "bodyJson", "jsonKey", "windowVar", "itemsPath", "itemsObjectValues",
    "titlePaths", "summaryPaths", "summaryIsBody", "authorPaths", "publishedAtPath", "publishedAtUnit", "publishedAtUtcOffset", "externalIdPath",
    "urlTemplate", "urlTemplateFallback", "rawDropKeys", "requireBoolean", "minNumeric",
  ],
  // X accounts are mostly read in shards, which apply only these.
  x_search: ["_aihot", "ingestNoiseFilter", "itemUrlPrefixRewrite", "query", "searchType", "provider", "bird"],
  mp_account: ["wxid", "ghid", "nickname", "transport", "account", "limit", "lookbackDays", "cacheDirectoryEnv", "fetchPublicContent", "articleUrl", "biz"],
  external: [],
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
    "maxFetches", "publishedAtSelector", "publishedAtRegex", "publishedAtUtcOffset", "publishedAtAuthoritative", "upgradeDatePrecision",
    "titleSelector", "titleRegex", "titleAuthoritative", "summarySelector",
  ],
};

const VALUES: Record<string, string[]> = {
  adapter: ["mimo_home", "article_links"],
  parseMode: ["html", "markdown", "docusaurus_changelog", "dated_sections"],
  provider: ["socialdata", "xquik", "bird"],
  transport: ["dajiala", "wx_cache"],
};

/** The config entries a source of this kind would ignore or cannot run, e.g. ["adapter=site_cards", "detail.titleFoo"]. */
export function unsupportedConfig(kind: SourceRow["kind"], config: Record<string, unknown>): string[] {
  const allowed = new Set(KEYS[kind] ?? []);
  const out: string[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!allowed.has(key)) out.push(key);
    else if (VALUES[key] && !VALUES[key]!.includes(String(value))) out.push(`${key}=${String(value)}`);
    else if (NESTED[key] && value && typeof value === "object") {
      for (const sub of Object.keys(value)) if (!NESTED[key]!.includes(sub)) out.push(`${key}.${sub}`);
    }
  }
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
