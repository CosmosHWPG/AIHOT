// A listing read through Jina is a paid request of its own on every fetch, with its own receipt: a read
// whose outcome is unknown is never sent again and is left to ops.recover, the next fetch reads the
// listing afresh, and a page received before a storage failure stays on its receipt. A read keyed by its
// caller's round is paid once a round. A JSON listing
// embedded in a page that blocks our addresses (Hark's Cloudflare) is read from Jina's rendered HTML.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { autoReleaseUnknownReceipts } from "@aihot/backend/operations/recover";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { jinaRead } from "@aihot/backend/providers/jina";
import { collectSource } from "@aihot/backend/sources/collect";
import { previewStoredSource } from "@aihot/backend/admin/sources";

const T = tag();
const SOURCE = `test-jina-listing-${T}`;

// Jina, answered here: in "drop" mode the connection closes after the request arrived, so whether it
// was billed is unknown.
let mode: "drop" | "page" = "drop";
let hits = 0;
const jina = http.createServer((req, res) => {
  if (req.url?.endsWith("/nul-response")) {
    hits += 1;
    res.writeHead(200, { "content-type": "text/plain", "x-request-id": "nul-fixture", "x-usage-tokens": "100" });
    return void res.end("Title: 原文\n\nMarkdown Content:\n正文\0内容😀\n");
  }
  if (req.headers["x-return-format"] === "html" && req.url?.endsWith("/articles")) {
    res.writeHead(200, { "content-type": "text/plain" });
    const items = [{ _key: "k1", slug: `embedded-${T}`, title: `Embedded ${T}`, publicationDate: "2026-09-24", tags: ["product"] }];
    return void res.end(`Title: Articles\n\nMarkdown Content:\n<html><body><script>self.__next_f.push([1,${JSON.stringify(`3:["$","main",null,{"items":${JSON.stringify(items)}}]\n`)}])</script></body></html>`);
  }
  if (req.headers["x-return-format"] === "html") {
    res.writeHead(200, { "content-type": "text/plain" });
    return void res.end(`<html><body><article><a href="/blog/rendered-${T}"><time datetime="2026-09-23">September 23, 2026</time><h2>Rendered ${T}</h2></a></article></body></html>`);
  }
  hits += 1;
  if (mode === "drop") return void req.socket.destroy();
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`Title: News\nURL Source: https://example.org/news/\n\nMarkdown Content:\n# [Post ${hits} ${T}](https://example.org/news/post-${hits}-${T})\n`);
});
await new Promise<void>((resolve) => jina.listen(0, "127.0.0.1", () => resolve()));
process.env.JINA_BASE_URL = `http://127.0.0.1:${(jina.address() as { port: number }).port}`;
process.env.JINA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

before(async () => {
  // These reads come faster than the per-minute Jina budget the migrations seed.
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 1000, per_day = 1000 WHERE service = 'jina'`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, config, cursor)
    VALUES (${SOURCE}, 'Jina listing', 'web_list', 'T2', 'editorial', '2100-01-01',
            ${sql.json({ url: "https://r.jina.ai/https://example.org/news/", allowUrlPrefixes: ["https://example.org/news/"] })},
            ${sql.json({ initializedAt: new Date().toISOString() })})`;
});
after(async () => {
  jina.close();
  await stopBoss();
  await closeDb();
});

const receipts = () => sql<{ status: string; attempts: number; text: string | null }[]>`
  SELECT status, attempts, response->>'text' AS text FROM receipts WHERE subject = ${`source:${SOURCE}`} ORDER BY id`;

test("an unknown listing waits for its authorized release, then later rounds read afresh", async () => {
  const lost = await collectSource(SOURCE, { force: true });
  assert.equal(lost.status, "failed");
  assert.equal(hits, 1);
  assert.deepEqual((await receipts()).map((r) => r.status), ["unknown"]);

  mode = "page";
  const held = await collectSource(SOURCE, { force: true });
  assert.equal(held.status, "failed");
  assert.match(held.error ?? "", /unknown outcome/);
  assert.equal(hits, 1);
  // Only the ordinary release permits retrying this same receipt.
  await autoReleaseUnknownReceipts(Date.now() + 31 * 60_000);
  const next = await collectSource(SOURCE, { force: true });
  assert.equal(next.status, "ok", next.error ?? "");
  assert.equal(next.created, 1);
  assert.equal(hits, 2);
  assert.deepEqual((await receipts()).map((r) => [r.status, r.attempts]), [["received", 2]]);

  // A committed listing releases its cursor round; the next scheduled round is a new read.
  const again = await collectSource(SOURCE, { force: true });
  assert.equal(again.status, "ok", again.error ?? "");
  assert.equal(again.created, 1);
  assert.equal(hits, 3);
  assert.deepEqual((await receipts()).map((r) => [r.status, r.attempts]), [["received", 2], ["received", 1]]);
});

test("a listing parsed with selectors is read from Jina as rendered HTML, dates included", async () => {
  const id = `${SOURCE}-html`;
  // Added before the post's date, so a regular run keeps it.
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, config, cursor)
    VALUES (${id}, 'Jina HTML listing', 'web_list', 'T1', 'editorial', '2100-01-01',
            ${sql.json({ url: "https://r.jina.ai/https://example.org/", baseUrl: "https://example.org", parseMode: "html", itemSelector: "article",
              titleSelector: "h2", publishedAtSelector: "time", allowUrlPrefixes: ["https://example.org/blog/"] })},
            ${sql.json({ initializedAt: "2026-09-01T00:00:00.000Z" })})`;
  const run = await collectSource(id, { force: true });
  assert.equal(run.status, "ok", run.error ?? "");
  const [post] = await sql<{ title: string; published_at: Date; publication_time: string }[]>`SELECT title, published_at, publication_time FROM articles WHERE source_id = ${id}`;
  assert.equal(post?.title, `Rendered ${T}`);
  assert.equal(post?.published_at.toISOString(), "2026-09-22T16:00:00.000Z");
  assert.equal(post?.publication_time, "2026-09-23");
});

test("a JSON listing embedded in a page is read from Jina as rendered HTML", async () => {
  const id = `${SOURCE}-json`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at, config, cursor)
    VALUES (${id}, 'Jina JSON listing', 'json_list', 'T1', 'editorial', '2100-01-01',
            ${sql.json({ url: "https://r.jina.ai/https://example.org/articles", mode: "html_json_key", jsonKey: "items", titlePaths: ["title"],
              urlTemplate: "https://example.org/articles/{slug}", externalIdPath: "_key", publishedAtPath: "publicationDate" })},
            ${sql.json({ initializedAt: "2026-09-01T00:00:00.000Z" })})`;
  const run = await collectSource(id, { force: true });
  assert.equal(run.status, "ok", run.error ?? "");
  const [post] = await sql<{ title: string; url: string; published_at: Date; publication_time: string }[]>`SELECT title, url, published_at, publication_time FROM articles WHERE source_id = ${id}`;
  assert.equal(post?.title, `Embedded ${T}`);
  assert.equal(post?.url, `https://example.org/articles/embedded-${T}`);
  assert.equal(post?.published_at.toISOString(), "2026-09-23T16:00:00.000Z");
  assert.equal(post?.publication_time, "2026-09-24");
  assert.equal((await sql`SELECT 1 FROM receipts WHERE subject = ${`source:${id}`} AND service = 'jina'`).length, 1);
});

test("a read keyed by its caller's round is paid once a round: a retry reuses it, the next round reads afresh", async () => {
  mode = "page";
  const before = hits;
  const read = (round: string) => jinaRead("https://example.org/news/", { purpose: "test.round", subject: `round:${T}`, round });
  const first = await read("r1");
  const retry = await read("r1");
  assert.equal(retry.receiptId, first.receiptId);
  assert.equal(hits, before + 1, "the same round is paid once");
  const next = await read("r2");
  assert.notEqual(next.receiptId, first.receiptId);
  assert.equal(hits, before + 2);
});

// A paid page can arrive before a database error: it is saved on the fetch's receipt before anything is
// stored, so the next fetch can retry storage without rebuying that listing.
test("a listing page received before a storage failure stays on its receipt", async () => {
  mode = "page";
  const before = hits;
  await sql.unsafe(`CREATE FUNCTION fail_listing_storage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_id = '${SOURCE}' THEN RAISE EXCEPTION 'injected listing storage failure'; END IF;
    RETURN NEW; END $$`);
  await sql`CREATE TRIGGER fail_listing_storage BEFORE INSERT ON articles FOR EACH ROW EXECUTE FUNCTION fail_listing_storage()`;
  try { assert.equal((await collectSource(SOURCE)).status, "failed"); }
  finally { await sql`DROP TRIGGER fail_listing_storage ON articles`; await sql`DROP FUNCTION fail_listing_storage()`; }
  assert.equal(hits, before + 1);
  const kept = (await receipts()).at(-1)!;
  assert.equal(kept.status, "received");
  assert.ok(kept.text?.includes(`post-${before + 1}-${T}`), "the page is on the receipt");
  const next = await collectSource(SOURCE);
  assert.equal(next.status, "ok", next.error ?? "");
  assert.equal(next.created, 1);
  assert.equal(hits, before + 1);
});

// Two reads can see the same clock reading: a CI VM's clock steps back (Check run 39178263522 reused one
// preview's receipt for the next).
test("each admin preview is a paid read of its own, even at the same clock reading", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await sql`UPDATE sources SET cursor=cursor||jsonb_build_object('jinaListingRound','pending-collector-round') WHERE id=${SOURCE}`;
  const before = hits;
  assert.equal((await previewStoredSource(SOURCE))!.count, 1);
  assert.equal((await previewStoredSource(SOURCE))!.count, 1);
  assert.equal(hits, before + 2);
  const [source] = await sql`SELECT cursor->>'jinaListingRound' AS round FROM sources WHERE id=${SOURCE}`;
  assert.equal(source!.round, "pending-collector-round");
});

test("a received Jina page with NUL persists its receipt and reuses it without another paid call", async () => {
  const before = hits;
  const url = `https://example.org/${T}/nul-response`;
  const options = { purpose: "source_detail", subject: `source:${SOURCE}-nul` };
  const first = await jinaRead(url, options);
  const second = await jinaRead(url, options);
  assert.equal(first.markdown, "正文�内容😀");
  assert.equal(second.raw, first.raw);
  assert.equal(second.receiptId, first.receiptId);
  assert.equal(hits, before + 1);
  const [receipt] = await sql`SELECT status, attempts, request_id, usage FROM receipts WHERE id = ${first.receiptId}`;
  assert.equal(receipt!.status, "received");
  assert.equal(receipt!.attempts, 1);
  assert.equal(receipt!.request_id, "nul-fixture");
  assert.equal(receipt!.usage.tokens, 100);
  const attempts = await sql`SELECT status FROM receipt_attempts WHERE receipt_id = ${first.receiptId}`;
  assert.deepEqual(attempts.map(row => row.status), ["received"]);
});
