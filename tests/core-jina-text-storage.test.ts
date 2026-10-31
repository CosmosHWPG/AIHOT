// Reader text must be JSONB-safe without losing the exact truncated answer or buying it again.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { jinaRead } from "@aihot/backend/providers/jina";

const sourceId = `jina-text-${tag()}`;
const ids: string[] = [];
const body = "# Unicode research report\n\n" + "The publisher describes the experiment and reports substantive measurements. ".repeat(6);
const originalPrivate = config.allowPrivateNetworkFetch;
let mode: "nul" | "truncated-surrogate" | "unicode" = "unicode";
let hits = 0;
let originalAnswer = "";
let responseBytes = 0;
const page = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<html><body><div id='app'></div></body></html>");
});
const jina = http.createServer((req, res) => {
  hits += 1;
  const header = `Title: Unicode research report\nURL Source: ${req.url?.slice(1)}\n\nMarkdown Content:\n`;
  if (mode === "nul") {
    originalAnswer = header + body + "\n\n中\u0000文 retains the article. " + String.raw`The literal escape \u0000 is documentation.`;
  } else if (mode === "truncated-surrogate") {
    // The HTTP response contains a valid emoji; the existing UTF-16 cap splits it in half.
    originalAnswer = header + body + "x".repeat(2_000_000 - header.length - body.length - 1) + "🧠" + " beyond the cap";
  } else {
    originalAnswer = header + body + "\n\n中文，emoji 🧠🚀，combining e\u0301，literal " + String.raw`\u0000`;
  }
  responseBytes = Buffer.byteLength(originalAnswer);
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "x-usage-tokens": "12", "x-request-id": "local-jina-text-request" });
  res.end(originalAnswer);
});
await Promise.all([page, jina].map(server => new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))));
const base = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
process.env.JINA_BASE_URL = `http://127.0.0.1:${(jina.address() as { port: number }).port}`;
process.env.JINA_API_KEY = "test-jina-text-key";
config.allowPrivateNetworkFetch = true;

let savedBudget: { enabled: boolean; per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  [savedBudget] = await sql`SELECT enabled,per_minute,per_hour,per_day FROM budgets WHERE service='jina'`;
  assert.ok(savedBudget);
  await sql`UPDATE budgets SET enabled=true,per_minute=1000000,per_hour=1000000,per_day=1000000 WHERE service='jina'`;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${sourceId},'Offline Jina text storage','rss',${sql.json({ fetchPublicContent: true })})`;
});
after(async () => {
  await Promise.all([page, jina].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  await sql`DELETE FROM articles WHERE source_id=${sourceId}`;
  await sql`DELETE FROM sources WHERE id=${sourceId}`;
  await sql`DELETE FROM receipts WHERE service='jina' AND subject=ANY(${ids.map(id => 'article:' + id)}::text[])`;
  if (savedBudget) await sql`UPDATE budgets SET enabled=${savedBudget.enabled},per_minute=${savedBudget.per_minute},
    per_hour=${savedBudget.per_hour},per_day=${savedBudget.per_day} WHERE service='jina'`;
  config.allowPrivateNetworkFetch = originalPrivate;
  await closeDb();
});
async function material() {
  const url = `${base}/${tag()}`;
  const { articleId } = await upsertMaterial({ sourceId, url, title: "Unicode research report", publishedAt: new Date(), via: "fetch" });
  ids.push(articleId);
  return { articleId, url, opts: { purpose: "body_fallback", subject: `article:${articleId}` } };
}
interface StoredResponse { text: string; status: number; originalText?: { encoding: string; base64: string } }
async function receipt(id: number) {
  const [row] = await sql<{ id: number; status: string; attempts: number; response: StoredResponse; usage: { bytes: number; tokens: number }; cost: number; currency: string; cost_basis: string }[]>`
    SELECT id,status,attempts,response,usage,cost,currency,cost_basis FROM receipts WHERE id=${id}`;
  return row!;
}

for (const kind of ["nul", "truncated-surrogate"] as const) test(`Jina ${kind} text persists safely, retains exact UTF-16 evidence and reuses one paid answer for the body`, async () => {
  mode = kind;
  const { articleId, url, opts } = await material();
  const beforeHits = hits;
  const result = await jinaRead(url, opts);
  const truncated = originalAnswer.slice(0, 2_000_000);
  const expected = truncated.toWellFormed().replace(/\u0000/g, "");
  const saved = await receipt(result.receiptId);
  assert.equal(saved.status, "received");
  assert.equal(saved.attempts, 1);
  assert.ok(saved.response.text === expected, "the stored parsing text must match the safe truncated answer");
  assert.ok(result.raw === expected);
  assert.ok(result.raw.isWellFormed());
  assert.equal(result.raw.includes("\u0000"), false);
  assert.ok(result.markdown.isWellFormed());
  assert.equal(result.markdown.includes("\u0000"), false);
  assert.equal(saved.response.originalText?.encoding, "utf16le");
  const restoredBytes = Buffer.from(saved.response.originalText!.base64, "base64");
  assert.ok(restoredBytes.equals(Buffer.from(truncated, "utf16le")), "base64 must retain every original truncated code unit");
  const restored = restoredBytes.toString("utf16le");
  assert.ok(restored === truncated, "the original answer must be reversible even with NUL or a lone surrogate");
  if (kind === "nul") {
    assert.ok(restored.includes("\u0000"));
    assert.ok(result.raw.includes(String.raw`\u0000`), "a literal backslash escape is not a NUL character");
  } else {
    assert.equal(restored.length, 2_000_000);
    assert.equal(restored.charCodeAt(restored.length - 1), 0xd83e);
    assert.equal(result.raw.charCodeAt(result.raw.length - 1), 0xfffd);
  }
  assert.deepEqual(saved.usage, { bytes: responseBytes, tokens: 12 });
  assert.equal(Number(saved.cost), 0.000004); // Existing numeric(14,6) storage precision.
  assert.equal(saved.currency, "CNY");
  assert.equal(saved.cost_basis, "estimated");
  assert.equal(await extractArticleBody(articleId, true), "ok");
  const [article] = await sql<{ body_status: string; body_text: string; revision: number }[]>`SELECT body_status,body_text,revision FROM articles WHERE id=${articleId}`;
  assert.equal(article!.body_status, "ok");
  assert.equal(article!.revision, 2);
  assert.ok(article!.body_text.isWellFormed());
  assert.equal(article!.body_text.includes("\u0000"), false);
  const reused = await jinaRead(url, opts);
  assert.equal(reused.receiptId, result.receiptId);
  assert.ok(reused.raw === expected);
  assert.equal((await receipt(result.receiptId)).status, "completed");
  assert.equal((await receipt(result.receiptId)).attempts, 1);
  assert.equal(hits, beforeHits + 1);
  assert.equal((await sql`SELECT id FROM receipt_attempts WHERE receipt_id=${result.receiptId}`).length, 1);
});

test("normal Unicode retains the original response structure, code units and receipt reuse", async () => {
  mode = "unicode";
  const { articleId, url, opts } = await material();
  const beforeHits = hits;
  const result = await jinaRead(url, opts);
  const saved = await receipt(result.receiptId);
  assert.deepEqual(saved.response, { text: originalAnswer, status: 200 });
  assert.equal(result.raw, originalAnswer);
  assert.ok(result.markdown.includes("中文，emoji 🧠🚀，combining e\u0301"));
  assert.equal(saved.response.originalText, undefined);
  assert.equal(await extractArticleBody(articleId, true), "ok");
  assert.equal((await jinaRead(url, opts)).receiptId, result.receiptId);
  assert.equal((await receipt(result.receiptId)).status, "completed");
  assert.equal((await receipt(result.receiptId)).attempts, 1);
  assert.equal(hits, beforeHits + 1);
});
