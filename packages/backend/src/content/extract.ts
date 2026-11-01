// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { sql, type Db } from "../db.ts";
import { audit } from "../audit.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { sha256 } from "../lib/ids.ts";
import { jinaRead } from "../providers/jina.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { getArticle } from "../providers/socialdata.ts";
import { getXquikArticle } from "../providers/xquik.ts";
import { getBirdArticleReceipt } from "../providers/bird.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";
import { contentHash, type XPostData } from "./materials.ts";
import { markdownBody } from "./markdown.ts";
import { advanceRecoveryExtractionRevision, getRecoveryRssBodyPolicy, RECOVERY_BATCH_PREFIX } from "../jobs/processing-recovery.ts";
import { extractFeedBody, type FeedBodyResult } from "./feed-body.ts";
import { classifyJinaBodyFailure, getBodyFailure, recordBodyFailure, resolveBodyFailure, type BodyFailureReason } from "./body-failure-cache.ts";

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jina" | "rss";
}

interface UrlExtraction {
  body: ExtractedBody | null;
  /** Settle the paid answer with the material decision, including an empty or obsolete answer. */
  receiptId?: number;
  /** Exact cleaned text, only for removing this same rejected answer from an older material. */
  rejectedText?: string;
  reason?: string;
  failure?: { reason: BodyFailureReason; bodyHash: string; url: string };
}

const MIN_BODY_CHARS = 200;

export function readable(html: string, url: string): ExtractedBody | null {
  const { document } = parseHTML(html);
  try {
    const base = document.createElement("base");
    base.setAttribute("href", url);
    document.head?.appendChild(base);
  } catch {
    // no head
  }
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0], { charThreshold: MIN_BODY_CHARS, keepClasses: false }).parse();
  if (!article?.content) return null;
  const clean = trimTrailingChrome(sanitizeBody(article.content, url));
  const text = stripTags(clean);
  if (text.length < MIN_BODY_CHARS) return null;
  const images: ExtractedBody["images"] = [];
  for (const m of clean.matchAll(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)) {
    const w = /\bwidth="(\d+)"/.exec(m[0]);
    const h = /\bheight="(\d+)"/.exec(m[0]);
    images.push({ kind: "image", url: m[1]!.replace(/&amp;/g, "&"), width: w ? Number(w[1]) : null, height: h ? Number(h[1]) : null });
    if (images.length >= 12) break;
  }
  return { html: clean, text, images, via: "readability" };
}

export async function extractFromUrl(url: string, opts: { allowJina: boolean; subject: string }): Promise<UrlExtraction> {
  try {
    const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /html/.test(type)) {
      const got = readable(res.text(), res.url);
      if (got) return { body: got };
    }
  } catch {
    // fall through to Jina
  }
  const articleId = /^article:([^@:#]+)/.exec(opts.subject)?.[1];
  if (articleId) {
    const cached = await getBodyFailure(articleId, url);
    if (cached) {
      const [current] = await sql<{ body_text: string | null }[]>`SELECT body_text FROM articles WHERE id=${articleId} AND url=${url}`;
      return { body: null, receiptId: cached.receiptId,
        rejectedText: current?.body_text && sha256(current.body_text) === cached.bodyHash ? current.body_text : undefined,
        reason: `Cached Jina body failure ${cached.id}: ${cached.reason}` };
    }
    if ((await getRecoveryRssBodyPolicy(articleId)).denyJina) return { body: null, reason: "Audited article policy prohibits Jina" };
  }
  if (!opts.allowJina) return { body: null };
  // Capacity and unknown outcomes are not an empty body; let the caller retain retryable evidence.
  const page = await jinaRead(url, { purpose: "body_fallback", subject: opts.subject });
  const html = markdownBody(page.markdown, url);
  const text = stripTags(html);
  const failed = classifyJinaBodyFailure(page.raw, url);
  const failure = failed ? { ...failed, url } : undefined;
  // Reader can return HTTP 200 while explicitly reporting the target's error in its metadata.
  // Inspect only that section: a real article may discuss CAPTCHA or quote an HTTP error.
  const metadataEnd = /\r?\nMarkdown Content:\r?\n/.exec(page.raw)?.index;
  const metadata = metadataEnd === undefined ? "" : page.raw.slice(0, metadataEnd);
  const targetError = /^Warning:\s*Target URL returned error\s+([45]\d{2})\b/im.exec(metadata);
  if (targetError) return { body: null, receiptId: page.receiptId, rejectedText: text,
    reason: `Jina Reader explicitly reported target HTTP ${targetError[1]}`, failure };
  const verificationTitle = /^Just a moment(?:\.{3}|…)$/i.test(page.title?.trim() ?? "");
  const beginning = collapseWhitespace(text).slice(0, 1500);
  const verificationBody = /enable javascript and cookies to continue|performing security verification|verify (?:that )?you are human|verifying you are human|needs to review the security of your connection before proceeding/i.test(beginning);
  const redditVerificationTitle = /^Reddit - Prove your humanity$/i.test(page.title?.trim() ?? "");
  const redditVerificationBody = /\bprove your humanity\b/i.test(beginning) && /\bcomplete the challenge\b/i.test(beginning);
  if ((verificationTitle && verificationBody) || (redditVerificationTitle && redditVerificationBody)) return { body: null, receiptId: page.receiptId, rejectedText: text,
    reason: "Jina Reader returned a security verification interstitial", failure };
  const youtubeTarget = /(^|\.)youtube\.com$|^youtu\.be$/i.test(new URL(url).hostname);
  const youtubeConsentTitle = /^Before you continue to YouTube$/i.test(page.title?.trim() ?? "");
  const consentBeginning = collapseWhitespace(text).slice(0, 5000);
  if (youtubeTarget && youtubeConsentTitle && /\bcookies\b/i.test(consentBeginning)
    && /\bAccept all\b/i.test(consentBeginning) && /\bReject all\b/i.test(consentBeginning)) return { body: null, receiptId: page.receiptId, rejectedText: text,
    reason: "Jina Reader returned a YouTube cookie consent interstitial", failure };
  return { receiptId: page.receiptId, failure,
    body: text.length < MIN_BODY_CHARS ? null : { html, text, images: [], via: "jina" } };
}

/** Pages extraction can fetch: ordinary web pages (X posts and WeChat articles arrive whole or not at all). */
export function pageFetchable(url: string, sourceKind: string): boolean {
  if (sourceKind === "x_search" || sourceKind === "mp_account") return false;
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && !/(^|\.)(x\.com|twitter\.com|mp\.weixin\.qq\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** Fetches and stores the body of one article. Unconfirmed bodies are recorded as such. */
export async function extractArticleBody(articleId: string, allowJina = process.env.JINA_BODY_FALLBACK !== "false"): Promise<"ok" | "unconfirmed" | "skipped"> {
  const [a] = await sql<{ id: string; url: string; title: string; body_status: string; revision: number; config: Record<string, any>; x_post: XPostData | null }[]>`
    SELECT a.id, a.url, a.title, a.body_status, a.revision, a.x_post, s.config FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  // An older material's route is evidence of its acquisition, never today's source setting.
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId, a.revision, a.x_post);
  const rssPolicy = await getRecoveryRssBodyPolicy(articleId);
  let rss: FeedBodyResult | null = null;
  if (rssPolicy.strategy) {
    // Seed the existing failed paid answer without another provider request; the RSS result may resolve it.
    await getBodyFailure(articleId, a.url);
    rss = await extractFeedBody({ originalUrl: a.url, title: a.title, ...rssPolicy.strategy, requireProof: true });
  }
  const extraction: UrlExtraction = rss ? { body: { ...rss.body, via: "rss" } }
    : rssPolicy.strategy ? { body: null, reason: "The fixed feed item no longer matches its reviewed proof" }
    : await extractFromUrl(a.url, { allowJina: allowJina && !rssPolicy.denyJina, subject: `article:${a.id}` });
  const { body: got, receiptId, rejectedText, reason, failure } = extraction;
  if (!got) {
    return markUnconfirmed(articleId, a.revision, receiptId,
      rejectedText !== undefined && reason ? { text: rejectedText, reason, url: a.url } : undefined, failure);
  }
  if (got.via === "jina" && receiptId !== undefined) {
    const [rejection] = await sql<{ id: number }[]>`SELECT id FROM audit_log
      WHERE subject=${`content:${articleId}`} AND action='content.body-rejection-authorized'
        AND after->>'url'=${a.url} AND after->>'bodySha256'=${sha256(got.text)} ORDER BY id DESC LIMIT 1`;
    if (rejection) return markUnconfirmed(articleId, a.revision, receiptId,
      { text: got.text, reason: `Jina body rejection authorized by audit ${rejection.id}`, url: a.url },
      { reason: 'audited_body_mismatch', bodyHash: sha256(got.text), url: a.url });
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  return sql.begin(async (tx) => {
    if (rss) await tx`SELECT s.id FROM sources s JOIN articles a ON a.source_id=s.id WHERE a.id=${articleId} FOR SHARE OF s`;
    const [row] = await tx<{ title: string; excerpt: string | null; content_hash: string | null }[]>`
      SELECT title, excerpt, content_hash FROM articles
      WHERE id = ${articleId} AND revision = ${a.revision} AND url=${a.url} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) {
      if (receiptId !== undefined) await completeReceipt(tx, receiptId);
      return "skipped";
    }
    if (rss) {
      await tx`SELECT key FROM settings WHERE key=${RECOVERY_BATCH_PREFIX + rssPolicy.strategy!.batchId} FOR UPDATE`;
      const current = await getRecoveryRssBodyPolicy(articleId, tx);
      if (!current.strategy || current.strategy.batchDigest !== rssPolicy.strategy!.batchDigest) return "skipped";
    }
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt });
    if (hash === row.content_hash) {
      await tx`UPDATE articles SET body_status = 'ok', updated_at = now() WHERE id = ${articleId}`;
      await resolveBodyFailure({ articleId, url: a.url, revision: a.revision, bodyHash: sha256(got.text), via: got.via }, tx);
      if (receiptId !== undefined) await completeReceipt(tx, receiptId);
      return "ok";
    }
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET body_html = ${got.html}, body_text = ${got.text}, body_status = 'ok',
        media = CASE WHEN jsonb_array_length(media) = 0 THEN ${tx.json(got.images as never)}::jsonb ELSE media END,
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${row.title}, ${got.text})`;
    await advanceRecoveryExtractionRevision(articleId, a.revision, r!.revision, tx);
    await resolveBodyFailure({ articleId, url: a.url, revision: r!.revision, bodyHash: sha256(got.text), via: got.via }, tx);
    if (rss) await audit('content-extraction', 'content.body-restored', `content:${articleId}`,
      'Verified exact feed item restored the body without Jina', { revision: a.revision },
      { revision: r!.revision, via: 'rss', batchId: rssPolicy.strategy!.batchId, allowJina: false, ...rss.evidence }, { db: tx });
    if (receiptId !== undefined) await completeReceipt(tx, receiptId);
    return "ok";
  });
}

async function markUnconfirmed(articleId: string, revision: number, receiptId?: number,
  rejected?: { text: string; reason: string; url?: string }, failure?: { reason: BodyFailureReason; bodyHash: string; url: string }): Promise<"unconfirmed" | "skipped"> {
  const mark = async (db: Db) => {
    if (failure && receiptId !== undefined) {
      const [current] = await db`SELECT id FROM articles WHERE id=${articleId} AND revision=${revision} AND url=${failure.url} AND body_status<>'ok' FOR UPDATE`;
      if (current) await recordBodyFailure({ articleId, ...failure, receiptId }, db);
    }
    if (rejected) {
      const [row] = await db<{ title: string; excerpt: string | null; body_text: string | null; body_status: string }[]>`
        SELECT title,excerpt,body_text,body_status FROM articles
        WHERE id=${articleId} AND revision=${revision} AND body_status<>'ok'
          AND (${rejected.url ?? null}::text IS NULL OR url=${rejected.url ?? null}) FOR UPDATE`;
      if (row && row.body_text === rejected.text) {
        // A prior extractor may have confirmed this exact error page. Preserve every other
        // partial body/summary, and retain the removed answer in the existing revision history.
        const hash = contentHash({ title: row.title, bodyText: null, excerpt: row.excerpt });
        const [next] = await db<{ revision: number }[]>`
          UPDATE articles SET body_html=NULL,body_text=NULL,body_status='unconfirmed',revision=revision+1,
            content_hash=${hash},processing_state='new',updated_at=now() WHERE id=${articleId} RETURNING revision`;
        await db`INSERT INTO article_revisions(article_id,revision,content_hash,title,body_text)
          VALUES(${articleId},${next!.revision},${hash},${row.title},NULL)`;
        await advanceRecoveryExtractionRevision(articleId, revision, next!.revision, db);
        await audit("content-extraction", "content.body-rejected", `content:${articleId}`, rejected.reason,
          { revision, bodyStatus: row.body_status, bodyChars: rejected.text.length, receiptId: receiptId ?? null },
          { revision: next!.revision, bodyStatus: "unconfirmed", bodyChars: 0, receiptId: receiptId ?? null }, { db });
        if (receiptId !== undefined) await completeReceipt(db, receiptId);
        return "unconfirmed" as const;
      }
    }
    const rows = await db`UPDATE articles SET body_status = 'unconfirmed', updated_at = now()
      WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok'
        AND (${rejected?.url ?? null}::text IS NULL OR url=${rejected?.url ?? null}) RETURNING id`;
    if (receiptId !== undefined) await completeReceipt(db, receiptId);
    return rows.length ? "unconfirmed" as const : "skipped" as const;
  };
  return receiptId === undefined && !rejected ? mark(sql) : sql.begin(mark);
}

/**
 * The X Article a post published (SocialData, paid, by the post's own id). The article joins the
 * post's body as a new revision; a post that is only the article's link takes the article's title.
 * No article (the link points at someone else's, or X has none) leaves the post "unconfirmed", and
 * the judging steps are told the article was not fetched.
 */
async function extractXArticle(articleId: string, tweetId: string, revision: number, post: XPostData): Promise<"ok" | "unconfirmed" | "skipped"> {
  const provider = post.provider;
  let found;
  let birdReceiptId: number | undefined;
  const opts = { purpose: "x_article", subject: `article:${articleId}` };
  if (provider === "bird") {
    const receipt = await getBirdArticleReceipt(tweetId, { ...opts, accountProfile: post.bird?.accountProfile, signal: shutdownSignal.signal });
    found = receipt.article;
    birdReceiptId = receipt.receiptId;
  } else if (provider === "xquik") found = await getXquikArticle(tweetId, opts);
  else if (provider === "socialdata") found = await getArticle(tweetId, opts);
  else return markUnconfirmed(articleId, revision);
  const got = found ? xArticleText(found) : null;
  if (!got) {
    return markUnconfirmed(articleId, revision, birdReceiptId);
  }
  const evidence = { ...got, ...(birdReceiptId === undefined ? {} : { provider: "bird", receiptId: birdReceiptId }) };
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; body_text: string | null; x_post: { text?: string } | null; x_article: { title?: string | null; text?: string } | null }[]>`
      SELECT title, excerpt, body_text, x_post, x_article FROM articles
      WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) {
      if (birdReceiptId !== undefined) await completeReceipt(tx, birdReceiptId);
      return "skipped";
    }
    const block = (a: { title?: string | null; text?: string } | null) => (a ? [a.title ? `# ${a.title}` : "", a.text ?? ""].filter(Boolean).join("\n\n") : "");
    // The post's own text, without an article appended by an earlier extraction (an admin re-run
    // extracts again from the post; appending once more would repeat the article).
    const previous = block(row.x_article);
    let base = row.body_text ?? "";
    if (previous && base.endsWith(previous)) base = base.slice(0, -previous.length).replace(/\s+$/, "");
    const metadataArticle = post.bird?.kind === "article" && post.bird.bodyLevel !== "full";
    const title = got.title && (onlyXArticleLink(row.x_post?.text) || metadataArticle) ? got.title : row.title;
    const alreadyFull = provider === "bird" && post.bird?.bodyLevel === "full" && base.includes(got.text);
    const bodyText = alreadyFull ? base : [base, block(got)].filter(Boolean).join("\n\n");
    if (bodyText === row.body_text && title === row.title) {
      // The same article again: nothing new, no new revision.
      await tx`UPDATE articles SET body_status = 'ok', x_article = ${tx.json(evidence as never)},
        x_post=CASE WHEN x_post->>'provider'='bird' THEN jsonb_set(x_post,'{bird,bodyLevel}','"full"'::jsonb) ELSE x_post END,
        updated_at = now() WHERE id = ${articleId}`;
      if (birdReceiptId !== undefined) await completeReceipt(tx, birdReceiptId);
      return "ok";
    }
    const hash = contentHash({ title, bodyText, excerpt: row.excerpt });
    const [r] = await tx<{ revision: number }[]>`
      UPDATE articles SET title = ${title}, body_text = ${bodyText}, x_article = ${tx.json(evidence as never)}, body_status = 'ok',
        x_post=CASE WHEN x_post->>'provider'='bird' THEN jsonb_set(x_post,'{bird,bodyLevel}','"full"'::jsonb) ELSE x_post END,
        revision = revision + 1, content_hash = ${hash}, processing_state = 'new', updated_at = now()
      WHERE id = ${articleId} RETURNING revision`;
    await tx`INSERT INTO article_revisions (article_id, revision, content_hash, title, body_text)
             VALUES (${articleId}, ${r!.revision}, ${hash}, ${title}, ${bodyText})`;
    await advanceRecoveryExtractionRevision(articleId, revision, r!.revision, tx);
    if (birdReceiptId !== undefined) await completeReceipt(tx, birdReceiptId);
    return "ok";
  });
}

export { collapseWhitespace };
