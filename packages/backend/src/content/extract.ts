// Article body extraction: readable text from the article page, or "unconfirmed" — never a wrong body.
// Jina Reader is the budgeted fallback for pages that only render in a browser.
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { sql, type Db } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { collapseWhitespace, stripTags } from "../lib/text.ts";
import { jinaRead } from "../providers/jina.ts";
import { BudgetExceededError, completeReceipt } from "../providers/receipts.ts";
import { getArticle } from "../providers/socialdata.ts";
import { getXquikArticle } from "../providers/xquik.ts";
import { getBirdArticleReceipt } from "../providers/bird.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { onlyXArticleLink, xArticleText } from "../sources/x.ts";
import { sanitizeBody, trimTrailingChrome } from "./sanitize.ts";
import { contentHash, type XPostData } from "./materials.ts";
import { markdownBody } from "./markdown.ts";
import { advanceRecoveryExtractionRevision } from "../jobs/processing-recovery.ts";

export interface ExtractedBody {
  html: string;
  text: string;
  images: Array<{ kind: "image"; url: string; width: number | null; height: number | null }>;
  via: "readability" | "jina";
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

export async function extractFromUrl(url: string, opts: { allowJina: boolean; subject: string }): Promise<ExtractedBody | null> {
  try {
    const res = await guardedFetch(url, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024 });
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 200 && /html/.test(type)) {
      const got = readable(res.text(), res.url);
      if (got) return got;
    }
  } catch {
    // fall through to Jina
  }
  if (!opts.allowJina) return null;
  try {
    const page = await jinaRead(url, { purpose: "body_fallback", subject: opts.subject });
    const html = markdownBody(page.markdown, url);
    const text = stripTags(html);
    if (text.length < MIN_BODY_CHARS) return null;
    return { html, text, images: [], via: "jina" };
  } catch (error) {
    if (error instanceof BudgetExceededError) return null;
    throw error;
  }
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
  const [a] = await sql<{ id: string; url: string; body_status: string; revision: number; config: Record<string, any>; x_post: XPostData | null }[]>`
    SELECT a.id, a.url, a.body_status, a.revision, a.x_post, s.config FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ${articleId}`;
  if (!a || a.body_status === "ok") return "skipped";
  // An older material's route is evidence of its acquisition, never today's source setting.
  if (a.x_post?.tweetId) return extractXArticle(a.id, a.x_post.tweetId, a.revision, a.x_post);
  const got = await extractFromUrl(a.url, { allowJina, subject: `article:${a.id}` });
  if (!got) {
    return markUnconfirmed(articleId, a.revision);
  }
  // The body is new content: a new revision, so an analysis of the body-less input counts as stale.
  return sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; excerpt: string | null; content_hash: string | null }[]>`
      SELECT title, excerpt, content_hash FROM articles
      WHERE id = ${articleId} AND revision = ${a.revision} AND body_status <> 'ok' FOR UPDATE`;
    if (!row) return "skipped";
    const hash = contentHash({ title: row.title, bodyText: got.text, excerpt: row.excerpt });
    if (hash === row.content_hash) {
      await tx`UPDATE articles SET body_status = 'ok', updated_at = now() WHERE id = ${articleId}`;
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
    return "ok";
  });
}

async function markUnconfirmed(articleId: string, revision: number, receiptId?: number): Promise<"unconfirmed" | "skipped"> {
  const mark = async (db: Db) => {
    const rows = await db`UPDATE articles SET body_status = 'unconfirmed', updated_at = now()
      WHERE id = ${articleId} AND revision = ${revision} AND body_status <> 'ok' RETURNING id`;
    if (receiptId !== undefined) await completeReceipt(db, receiptId);
    return rows.length ? "unconfirmed" as const : "skipped" as const;
  };
  return receiptId === undefined ? mark(sql) : sql.begin(mark);
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
