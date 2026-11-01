// Negative evidence for one article/URL, never a provider retry grant or a publication decision.
import { sql, type Db } from "../db.ts";
import { audit } from "../audit.ts";
import { sha256 } from "../lib/ids.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { parseJinaText } from "../providers/jina.ts";
import { ReceiptBusyError, ReceiptUnknownError } from "../providers/receipts.ts";
import { markdownBody } from "./markdown.ts";

export type BodyFailureReason = 'short_body' | 'target_http_error' | 'verification_interstitial' | 'audited_body_mismatch';
export interface BodyFailure {
  id: number; articleId: string; url: string; reason: BodyFailureReason;
  receiptId: number; bodyHash: string; createdAt: Date;
}
type FailureInput = { articleId: string; url: string; reason: BodyFailureReason; receiptId: number; bodyHash: string };
type ResolutionInput = { articleId: string; url: string; revision: number; bodyHash: string;
  via: 'readability' | 'jina' | 'rss' | 'structured' | 'history' };
interface FailureRow { id: number; article_id: string; url: string; reason: BodyFailureReason; receipt_id: number; body_sha256: string; created_at: Date }
const failure = (r: FailureRow): BodyFailure => ({ id: r.id,articleId: r.article_id,url: r.url,reason: r.reason,
  receiptId: r.receipt_id,bodyHash: r.body_sha256,createdAt: r.created_at });
function validateScope(articleId: string,url: string) {
  if (!articleId || !url) throw new Error('Body failure requires an exact article and URL');
  const u = new URL(url);
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new Error('Body failure requires an HTTP(S) URL without credentials');
}
function cleaned(raw: string,url: string) { return stripTags(markdownBody(parseJinaText(raw).markdown,url)); }

/** Same text normalization and precise rejection predicates as the formal extractor. */
export function classifyJinaBodyFailure(raw: string,url: string): { reason: Exclude<BodyFailureReason,'audited_body_mismatch'>; bodyHash: string } | null {
  const page = parseJinaText(raw);
  const text = cleaned(raw,url);
  const bodyHash = sha256(text);
  const metadataEnd = /\r?\nMarkdown Content:\r?\n/.exec(raw)?.index;
  const metadata = metadataEnd === undefined ? '' : raw.slice(0,metadataEnd);
  if (/^Warning:\s*Target URL returned error\s+([45]\d{2})\b/im.test(metadata)) return { reason: 'target_http_error',bodyHash };
  const beginning = collapseWhitespace(text).slice(0,1500);
  const verificationTitle = /^Just a moment(?:\.{3}|…)$/i.test(page.title?.trim() ?? '');
  const verificationBody = /enable javascript and cookies to continue|performing security verification|verify (?:that )?you are human|verifying you are human|needs to review the security of your connection before proceeding/i.test(beginning);
  const reddit = /^Reddit - Prove your humanity$/i.test(page.title?.trim() ?? '')
    && /\bprove your humanity\b/i.test(beginning) && /\bcomplete the challenge\b/i.test(beginning);
  const youtube = /(^|\.)youtube\.com$|^youtu\.be$/i.test(new URL(url).hostname)
    && /^Before you continue to YouTube$/i.test(page.title?.trim() ?? '');
  const consent = collapseWhitespace(text).slice(0,5000);
  if ((verificationTitle && verificationBody) || reddit || (youtube && /\bcookies\b/i.test(consent)
    && /\bAccept all\b/i.test(consent) && /\bReject all\b/i.test(consent))) return { reason: 'verification_interstitial',bodyHash };
  return text.length < 200 ? { reason: 'short_body',bodyHash } : null;
}
async function transaction<T>(db: Db,run: (tx: Db) => Promise<T>): Promise<T> {
  return ('begin' in db ? await (db as typeof sql).begin(run) : await run(db)) as T;
}
async function lockArticle(articleId: string,url: string,db: Db) {
  const [row] = await db<{ revision: number; body_status: string; body_text: string | null }[]>`
    SELECT revision,body_status,body_text FROM articles WHERE id=${articleId} AND url=${url} FOR UPDATE`;
  return row;
}
async function authorized(articleId: string,url: string,bodyHash: string,db: Db): Promise<boolean> {
  const [row] = await db`SELECT 1 FROM audit_log WHERE subject=${'content:' + articleId} AND action='content.body-rejection-authorized'
    AND after->>'url'=${url} AND after->>'bodySha256'=${bodyHash} LIMIT 1`;
  return !!row;
}
async function evidence(input: FailureInput,db: Db) {
  const [r] = await db<{ status: string; response: { text?: unknown; status?: unknown } | null }[]>`SELECT status,response FROM receipts
    WHERE id=${input.receiptId} AND service='jina' AND purpose='body_fallback' AND status IN ('received','completed')
      AND substring(subject from '^article:([^@:#]+)')=${input.articleId} AND request->>'url'=${input.url}`;
  if (!r || typeof r.response?.text !== 'string' || r.response.status !== 200) throw new Error('Body failure requires a saved matching Jina answer');
  const hash = sha256(cleaned(r.response.text,input.url));
  if (hash !== input.bodyHash) throw new Error('Body failure evidence hash mismatch');
  const classified = classifyJinaBodyFailure(r.response.text,input.url);
  if (input.reason === 'audited_body_mismatch') {
    if (!(await authorized(input.articleId,input.url,hash,db))) throw new Error('Body mismatch requires exact audited evidence');
  } else if (classified?.reason !== input.reason) throw new Error('Body failure reason does not match the saved answer');
}
async function save(input: FailureInput,db: Db,resolutionId?: number): Promise<BodyFailure> {
  if (resolutionId !== undefined) {
    const [old] = await db<FailureRow[]>`SELECT id,article_id,url,reason,receipt_id,body_sha256,created_at FROM article_body_failure_cache
      WHERE article_id=${input.articleId} AND url_sha256=${sha256(input.url)} AND url=${input.url} AND event_kind='failure'
        AND receipt_id=${input.receiptId} AND body_sha256=${input.bodyHash} AND reason=${input.reason} AND resolved_at IS NOT NULL ORDER BY id DESC LIMIT 1`;
    if (old) return failure(old);
  }
  const [row] = await db<FailureRow[]>`INSERT INTO article_body_failure_cache(article_id,url,url_sha256,event_kind,reason,receipt_id,body_sha256,resolved_at)
    VALUES(${input.articleId},${input.url},${sha256(input.url)},'failure',${input.reason},${input.receiptId},${input.bodyHash},
      (SELECT created_at FROM article_body_failure_cache WHERE id=${resolutionId ?? null}))
    ON CONFLICT(article_id,url_sha256,receipt_id,body_sha256,reason) WHERE event_kind='failure' AND resolved_at IS NULL
    DO UPDATE SET reason=EXCLUDED.reason RETURNING id,article_id,url,reason,receipt_id,body_sha256,created_at`;
  if (row!.url !== input.url) throw new Error('Body failure URL hash collision');
  return failure(row!);
}

/** A negative cache cannot hide an unresolved request or turn it into an empty answer. */
export async function getBodyFailure(articleId: string,url: string,db: Db = sql): Promise<BodyFailure | null> {
  validateScope(articleId,url);
  return transaction(db,async tx => {
    const article = await lockArticle(articleId,url,tx);
    if (!article) return null;
    const [unresolved] = await tx<{ id: number; status: string }[]>`SELECT id,status FROM receipts
      WHERE service='jina' AND purpose='body_fallback' AND status IN ('pending','unknown')
        AND (request->>'url'=${url} OR substring(subject from '^article:([^@:#]+)')=${articleId})
      ORDER BY CASE WHEN status='unknown' THEN 0 ELSE 1 END,id LIMIT 1`;
    if (unresolved?.status === 'unknown') throw new ReceiptUnknownError(unresolved.id,`Receipt ${unresolved.id} has an unknown body outcome`);
    if (unresolved) throw new ReceiptBusyError(`Receipt ${unresolved.id} is in flight`);
    if (article.body_status === 'ok') return null;
    const [cached] = await tx<FailureRow[]>`SELECT id,article_id,url,reason,receipt_id,body_sha256,created_at FROM article_body_failure_cache
      WHERE article_id=${articleId} AND url_sha256=${sha256(url)} AND url=${url} AND event_kind='failure' AND resolved_at IS NULL
      ORDER BY id DESC LIMIT 1`;
    const [settled] = await tx<{ id: number; response: { text?: unknown; status?: unknown } | null }[]>`SELECT r.id,r.response FROM receipts r
      WHERE r.service='jina' AND r.purpose='body_fallback' AND r.status='completed'
        AND substring(r.subject from '^article:([^@:#]+)')=${articleId} AND r.request->>'url'=${url}
        AND NOT EXISTS(SELECT 1 FROM article_body_failure_cache c WHERE c.article_id=${articleId} AND c.url_sha256=${sha256(url)}
          AND c.url=${url} AND c.event_kind='resolution' AND c.created_at>=coalesce(
            (SELECT t.started_at FROM receipt_attempts t WHERE t.receipt_id=r.id AND t.attempt=r.attempts),r.created_at))
      ORDER BY coalesce((SELECT t.started_at FROM receipt_attempts t WHERE t.receipt_id=r.id AND t.attempt=r.attempts),r.created_at) DESC,r.id DESC LIMIT 1`;
    if (!settled || typeof settled.response?.text !== 'string' || settled.response.status !== 200) return cached ? failure(cached) : null;
    const bodyHash = sha256(cleaned(settled.response.text,url));
    const classified = classifyJinaBodyFailure(settled.response.text,url);
    const reason = await authorized(articleId,url,bodyHash,tx) ? 'audited_body_mismatch' : classified?.reason;
    if (!reason) {
      // A completed newer request (or a new answer of the same receipt) is a changed signal.
      // Keep the negative history; only formal normal-body persistence resolves its rows.
      if (!cached) return null;
      const settledId = BigInt(settled.id), cachedId = BigInt(cached.receipt_id);
      if (settledId > cachedId || (settledId === cachedId && bodyHash !== cached.body_sha256)) return null;
      return failure(cached);
    }
    if (cached) return failure(cached);
    return save({ articleId,url,receiptId: settled.id,bodyHash,reason },tx);
  });
}

/** Call in the formal material-decision transaction; received is safe because that transaction settles it. */
export async function recordBodyFailure(input: FailureInput,db: Db = sql): Promise<BodyFailure> {
  validateScope(input.articleId,input.url);
  return transaction(db,async tx => {
    const article = await lockArticle(input.articleId,input.url,tx);
    if (!article) throw new Error('Body failure cannot replace a changed material');
    await evidence(input,tx);
    const [resolution] = await tx<{ id: number }[]>`SELECT c.id FROM article_body_failure_cache c JOIN receipts r ON r.id=${input.receiptId}
      WHERE c.article_id=${input.articleId} AND c.url_sha256=${sha256(input.url)} AND c.url=${input.url} AND c.event_kind='resolution'
        AND c.created_at>=coalesce((SELECT t.started_at FROM receipt_attempts t WHERE t.receipt_id=r.id AND t.attempt=r.attempts),r.created_at)
      ORDER BY c.id DESC LIMIT 1`;
    if (resolution) return save(input,tx,resolution.id);
    if (article.body_status === 'ok') throw new Error('Body failure cannot replace a confirmed material');
    return save(input,tx);
  });
}

/** A verified current normal body resolves failures, including when no negative row existed yet. */
export async function resolveBodyFailure(input: ResolutionInput,db: Db = sql): Promise<number> {
  validateScope(input.articleId,input.url);
  return transaction(db,async tx => {
    const article = await lockArticle(input.articleId,input.url,tx);
    if (!article || article.revision !== input.revision || article.body_status !== 'ok' || !article.body_text
      || article.body_text.length < 200 || sha256(article.body_text) !== input.bodyHash) return 0;
    const [knownBad] = await tx`SELECT 1 FROM article_body_failure_cache WHERE article_id=${input.articleId}
      AND url_sha256=${sha256(input.url)} AND url=${input.url} AND event_kind='failure'
      AND resolved_at IS NULL AND body_sha256=${input.bodyHash} LIMIT 1`;
    if (knownBad) return 0;
    const [marker] = await tx<{ id: number }[]>`INSERT INTO article_body_failure_cache(article_id,url,url_sha256,event_kind,body_sha256,revision,via)
      VALUES(${input.articleId},${input.url},${sha256(input.url)},'resolution',${input.bodyHash},${input.revision},${input.via}) RETURNING id`;
    const resolved = await tx`UPDATE article_body_failure_cache SET resolved_at=(SELECT created_at FROM article_body_failure_cache WHERE id=${marker!.id})
      WHERE article_id=${input.articleId} AND url_sha256=${sha256(input.url)} AND url=${input.url}
        AND event_kind='failure' AND resolved_at IS NULL RETURNING id`;
    await audit('content-extraction','content.body-failure-resolved','content:' + input.articleId,'Verified current normal body resolved cached Jina failures',null,
      { revision: input.revision,bodyHash: input.bodyHash,via: input.via,resolved: resolved.length },{ db: tx });
    return resolved.length;
  });
}
