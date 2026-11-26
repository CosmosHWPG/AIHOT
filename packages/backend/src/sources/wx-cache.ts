// Read only the public-account tables of an already decrypted wx cache. No daemon, decryption,
// shared-cache write or V2 code is involved; CoreScope owns its material and success cursor.
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import { credential } from "../config.ts";
import { FetchError, type Candidate, type SourceRow } from "./types.ts";
import { parseWxArticles } from "./wx-articles.ts";

const xml = new XMLParser({ ignoreAttributes: false, textNodeName: "#text", cdataPropName: "#cdata", processEntities: true, htmlEntities: true });
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const STALE_MS = 48 * 3600_000;

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") return text((value as Record<string, unknown>)["#cdata"] ?? (value as Record<string, unknown>)["#text"]);
  return "";
}

/** Only a public-account mmreader item is an article; ordinary app messages are not candidates. */
export function parseWxCacheMessage(content: string, createdAt: number, account: string): Candidate[] {
  const start = content.indexOf("<msg");
  if (start < 0 || Buffer.byteLength(content) > MAX_CONTENT_BYTES) return [];
  let doc: Record<string, any>;
  try { doc = xml.parse(content.slice(start)); }
  catch { return []; }
  const category = doc.msg?.appmsg?.mmreader?.category;
  const categories = category ? Array.isArray(category) ? category : [category] : [];
  const records: Record<string, unknown>[] = [];
  for (const group of categories) {
    const items = group.item ? Array.isArray(group.item) ? group.item : [group.item] : [];
    for (const item of items) {
      if (Number(text(item.del_flag)) > 0) continue;
      const published = Number(text(item.pub_time ?? item.publish_time));
      records.push({
        title: text(item.title) || text(item.title_v2), url: text(item.url) || text(item.longurl) || text(item.shorturl), digest: text(item.digest) || text(item.summary), cover_url: text(item.cover),
        timestamp: Number.isFinite(published) && published > 0 ? published : null,
        account,
      });
    }
  }
  if (!records.length) return [];
  try {
    return parseWxArticles(JSON.stringify(records), account).map((candidate) => ({
      ...candidate,
      raw: { wxCache: { account, messageCreatedAt: createdAt, transport: "read_only_cache" } },
    }));
  } catch { return []; }
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!(value instanceof Uint8Array)) return "";
  const bytes = Buffer.from(value);
  if (bytes.length > MAX_CONTENT_BYTES) return "";
  // WCDB stores text as Zstandard; plain UTF-8 blobs also occur in older cache versions.
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfd2fb528) {
    try { return zstdDecompressSync(bytes, { maxOutputLength: MAX_CONTENT_BYTES }).toString("utf8"); }
    catch { return ""; }
  }
  return bytes.toString("utf8");
}

function openReadonly(file: string): DatabaseSync {
  let db: DatabaseSync;
  try { db = new DatabaseSync(file, { readOnly: true, timeout: 1500, allowExtension: false }); }
  catch { throw new FetchError("wx_cache: decrypted cache database is unreadable"); }
  db.exec("PRAGMA query_only = ON");
  return db;
}

export interface WxCacheRead {
  candidates: Candidate[];
  accountUsername: string;
  cacheUpdatedAt: Date;
  latestMessageAt: Date | null;
  stale: boolean;
}

/** Fixed schema and exact public-account identity; arbitrary SQL and private chat enumeration are refused. */
export function readWxCache(source: Pick<SourceRow, "config">, opts: { now?: Date; directory?: string; maxCandidates?: number } = {}): WxCacheRead {
  const account = String(source.config.account ?? "").trim();
  if (!account || account.length > 200) throw new FetchError("wx_cache: account missing or invalid");
  const envKey = String(source.config.cacheDirectoryEnv ?? "WX_CACHE_DIRECTORY");
  if (!/^WX_[A-Z0-9_]+$/.test(envKey)) throw new FetchError("wx_cache: cacheDirectoryEnv must name a WX_ collector setting");
  const directory = opts.directory ?? credential("collectors", envKey);
  if (!directory) throw new FetchError("wx_cache: cache directory is not configured");
  let files: string[];
  try { files = readdirSync(directory).filter((name) => /^[a-f0-9]{32}\.db$/i.test(name)).sort().slice(0, 64).map((name) => path.join(directory, name)); }
  catch { throw new FetchError("wx_cache: cache directory is unavailable"); }
  const now = opts.now ?? new Date();
  const lookbackDays = Math.max(1, Math.min(31, Number(source.config.lookbackDays) || 7));
  const limit = Math.max(1, Math.min(40, Number(source.config.limit) || 8));
  const maxCandidates = Math.max(limit, Math.min(320, opts.maxCandidates ?? limit));
  const cutoff = Math.floor((now.getTime() - lookbackDays * 86400_000) / 1000);
  let username: string | null = null;
  for (const file of files) {
    const db = openReadonly(file);
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contact'").get();
      if (!table) continue;
      const hasBiz = !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'biz_info'").get();
      const matches = db.prepare(`SELECT DISTINCT c.username FROM contact c ${hasBiz ? "LEFT JOIN biz_info b ON b.username = c.username" : ""}
        WHERE coalesce(c.delete_flag, 0) = 0 AND (c.username = ? OR c.alias = ? OR c.nick_name = ?)
          AND (${hasBiz ? "b.username IS NOT NULL OR " : ""}c.username GLOB 'gh_*') LIMIT 2`).all(account, account, account) as Array<{ username: string }>;
      if (matches.length > 1) throw new FetchError("wx_cache: ambiguous public account; configure its exact username");
      if (matches[0]) {
        if (username && username !== matches[0].username) throw new FetchError("wx_cache: conflicting public account identities");
        username = matches[0].username;
      }
    } finally { db.close(); }
  }
  if (!username) throw new FetchError("wx_cache: public account is not present in the authorized cache");
  const table = `Msg_${createHash("md5").update(username).digest("hex")}`;
  const candidates: Candidate[] = [];
  let latest = 0;
  let updated = 0;
  let matched = false;
  for (const file of files) {
    const db = openReadonly(file);
    try {
      if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
      matched = true;
      updated = Math.max(updated, statSync(file).mtimeMs);
      const last = db.prepare(`SELECT max(create_time) AS latest FROM "${table}"`).get() as { latest: number | null };
      latest = Math.max(latest, Number(last.latest) || 0);
      const messages = db.prepare(`SELECT create_time, message_content, compress_content FROM "${table}"
        WHERE create_time >= ? ORDER BY create_time DESC, local_id DESC LIMIT ?`).all(cutoff, limit * 8);
      for (const message of messages) {
        let found = parseWxCacheMessage(contentText(message.message_content), Number(message.create_time), account);
        if (!found.length) found = parseWxCacheMessage(contentText(message.compress_content), Number(message.create_time), account);
        for (const candidate of found) candidates.push(candidate);
      }
    } finally { db.close(); }
  }
  if (!matched) throw new FetchError("wx_cache: public account message table is not present");
  const unique = new Map<string, Candidate>();
  candidates.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  for (const candidate of candidates) if (!unique.has(candidate.url)) unique.set(candidate.url, candidate);
  return {
    candidates: [...unique.values()].slice(0, maxCandidates), accountUsername: username,
    cacheUpdatedAt: new Date(updated), latestMessageAt: latest ? new Date(latest * 1000) : null,
    stale: now.getTime() - updated > STALE_MS,
  };
}
