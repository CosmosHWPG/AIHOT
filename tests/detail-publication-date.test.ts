// Detail-only dates must be established before storage, even when a listing exceeds the per-run
// detail budget. Known dates survive authoritative rules, and undated links remain retryable.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import { identityKeyForUrl } from "@aihot/backend/lib/url";

const T = tag();
const dates = Array.from({ length: 4 }, (_, i) => new Date(Date.now() - (i + 1) * 86_400_000).toISOString());
const reads = new Map<string, number>();
let missingDateAvailable = false;
let rotationHeadInserted = false;
const server = http.createServer((req, res) => {
  const pathname = req.url ?? "";
  reads.set(pathname, (reads.get(pathname) ?? 0) + 1);
  const listing = /^\/(bounded|retry|legacy|known|future|rotate|position|failed-store)\/list$/.exec(pathname);
  let body: string;
  if (listing) {
    const count = ["bounded", "rotate", "position", "failed-store"].includes(listing[1]!) ? 4 : ["known", "future"].includes(listing[1]!) ? 1 : 3;
    const indices = Array.from({ length: count }, (_, i) => i);
    if (listing[1] === "rotate" && rotationHeadInserted) indices.unshift(4);
    body = indices.map(i => `<li><a href="/${listing[1]}/post-${i}">Source headline ${listing[1]} ${i} ${T}</a></li>`).join("");
  } else {
    const item = /^\/(bounded|retry|legacy|known|future|rotate|position|failed-store)\/post-(\d)$/.exec(pathname);
    if (!item) { res.writeHead(404); res.end(); return; }
    if (item[1] === "rotate" && item[2] === "1") { res.writeHead(503); res.end("Unavailable"); return; }
    const dated = !(item[1] === "retry" && item[2] === "1" && !missingDateAvailable) && !(item[1] === "rotate" && item[2] === "0");
    const date = item[1] === "future" ? new Date(Date.now() + 86_400_000).toISOString() : dates[Number(item[2]) % dates.length];
    body = dated ? `<time datetime="${date}"></time>` : "<p>No source publication date yet.</p>";
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<html><head><title>Source page</title></head><body>${body}</body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
const id = (name: string) => `test-detail-date-${name}-${T}`;
const sourceConfig = (name: string, requirePublishedAt: boolean | undefined) => ({
  url: `${base}/${name}/list`, itemSelector: "li", linkSelector: "a", titleSelector: "a",
  _aihot: { initialBackfillLimit: 2 },
  detail: { maxFetches: name === "legacy" ? 1 : 2, publishedAtSelector: "time", publishedAtAuthoritative: true,
    ...(requirePublishedAt === undefined ? {} : { requirePublishedAt }) },
});
before(async () => {
  for (const name of ["bounded", "retry", "legacy", "known", "future", "rotate", "position", "failed-store"]) {
    await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
      VALUES (${id(name)}, ${name}, 'web_list', ${sql.json(sourceConfig(name, name === "legacy" ? undefined : true))},
        'T2', 'editorial', ${["bounded", "rotate"].includes(name) ? null : sql.json({ initializedAt: new Date().toISOString() })}, '2100-01-01')`;
  }
});
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});
const articles = (name: string) => sql<{ url: string; published_at: Date | null; revision: number }[]>`
  SELECT url, published_at, revision FROM articles WHERE source_id=${id(name)} ORDER BY url`;
const cursor = async (name: string) => (await sql<{ cursor: Record<string, unknown> }[]>`SELECT cursor FROM sources WHERE id=${id(name)}`)[0]!.cursor;

test("bounded detail-only dates advance over later rounds and survive authoritative repeat listings", async () => {
  const first = await collectSource(id("bounded"), { force: true });
  assert.deepEqual([first.status, first.found, first.created], ["ok", 4, 2]);
  assert.deepEqual((await articles("bounded")).map(a => a.published_at?.toISOString()), dates.slice(0, 2));
  assert.equal(reads.get("/bounded/post-2"), undefined, "the initial backfill and detail budget are both bounded");

  const second = await collectSource(id("bounded"), { force: true });
  assert.deepEqual([second.status, second.created, second.revised], ["ok", 2, 0]);
  const third = await collectSource(id("bounded"), { force: true });
  assert.deepEqual([third.status, third.created, third.revised], ["ok", 0, 0]);
  assert.deepEqual((await articles("bounded")).map(a => [a.published_at?.toISOString(), a.revision]), dates.map(d => [d, 1]));
  for (let i = 0; i < 4; i++) assert.equal(reads.get(`/bounded/post-${i}`), 1, "known source dates need no repeated detail request");
});

test("unfetched and still-undated candidates are withheld and can acquire a source date later", async () => {
  const first = await collectSource(id("retry"), { force: true });
  assert.deepEqual([first.status, first.found, first.created], ["ok", 3, 1]);
  assert.deepEqual((await articles("retry")).map(a => a.url), [`${base}/retry/post-0`]);
  assert.equal(reads.get("/retry/post-2"), undefined, "an unchecked link is not admitted at discovery time");

  missingDateAvailable = true;
  const second = await collectSource(id("retry"), { force: true });
  assert.deepEqual([second.status, second.created], ["ok", 2]);
  assert.deepEqual((await articles("retry")).map(a => a.published_at?.toISOString()), dates.slice(0, 3));
  assert.equal(reads.get("/retry/post-1"), 2, "a date missing on the previous check remains retryable");
  assert.equal(reads.get("/retry/post-2"), 1, "known dated material does not consume the next round's budget");
});

test("a globally known undated article can be checked without duplicating or revising its original owner", async () => {
  const url = `${base}/known/post-0`;
  const seeded = await upsertMaterial({ sourceId: id("legacy"), via: "fetch", url, title: `Source headline known 0 ${T}`, publishedAt: null });
  const run = await collectSource(id("known"), { force: true });
  assert.equal(run.status, "ok");
  const [article] = await sql<{ published_at: Date | null; source_id: string }[]>`SELECT published_at, source_id FROM articles WHERE id=${seeded.articleId}`;
  assert.deepEqual([article!.published_at, article!.source_id], [null, id("legacy")], "another source's immutable original date and ownership stay intact");
  assert.equal(run.created, 0, "the global identity is not duplicated");
  const [discovery] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM article_discoveries WHERE article_id=${seeded.articleId} AND source_id=${id("known")}`;
  assert.equal(discovery!.n, 1, "a verified dated discovery can still associate the material with the new source");
  assert.equal(reads.get("/known/post-0"), 1, "the known-identity shortcut cannot prevent establishing a missing date");
});

test("existing detail configs still admit undated material unless the new policy is enabled", async () => {
  const run = await collectSource(id("legacy"), { force: true });
  assert.deepEqual([run.status, run.found, run.created], ["ok", 3, 3]);
  const rows = (await articles("legacy")).filter(a => a.url.includes("/legacy/"));
  assert.deepEqual(rows.map(a => a.published_at?.toISOString() ?? null), [dates[0], null, null]);
});

test("a detail timestamp rejected by the shared future-date rule cannot fall back to discovery time", async () => {
  const run = await collectSource(id("future"), { force: true });
  assert.deepEqual([run.status, run.found, run.created], ["ok", 1, 0]);
  assert.equal((await articles("future")).length, 0, "a finite but untrusted future timestamp is withheld before storage");
});

test("detail date admission accepts a boolean policy and refuses ambiguous config values", () => {
  assert.deepEqual(unsupportedConfig("web_list", sourceConfig("bounded", true)), []);
  assert.deepEqual(unsupportedConfig("web_list", sourceConfig("bounded", false)), []);
  assert.deepEqual(unsupportedConfig("web_list", { detail: { requirePublishedAt: "true" } }), ["detail.requirePublishedAt"]);
});

test("permanently undated and failing details cannot starve later dated articles or a new listing head", async () => {
  const first = await collectSource(id("rotate"), { force: true });
  assert.deepEqual([first.status, first.created], ["ok", 0]);
  assert.equal((await cursor("rotate")).detailDateAfterIdentity, identityKeyForUrl(`${base}/rotate/post-1`));
  assert.equal(reads.get("/rotate/post-2"), undefined, "the first import still respects its two-item bound");

  const second = await collectSource(id("rotate"), { force: true });
  assert.deepEqual([second.status, second.created], ["ok", 2]);
  assert.deepEqual((await articles("rotate")).map(a => a.url), [`${base}/rotate/post-2`, `${base}/rotate/post-3`]);
  const third = await collectSource(id("rotate"), { force: true });
  assert.deepEqual([third.status, third.created], ["ok", 0]);
  assert.equal(reads.get("/rotate/post-0"), 2, "permanently undated pages remain retryable after the wrap");
  assert.equal(reads.get("/rotate/post-1"), 2, "a persistent HTTP failure does not become a permanent exclusion");

  rotationHeadInserted = true;
  const fourth = await collectSource(id("rotate"), { force: true });
  assert.deepEqual([fourth.status, fourth.created], ["ok", 1]);
  assert.ok((await articles("rotate")).some(a => a.url === `${base}/rotate/post-4`), "a new head is reached despite both permanently failing older details");
  assert.equal(reads.get("/rotate/post-2"), 1, "known dated pages use no detail budget while rotating");
  assert.equal(reads.get("/rotate/post-3"), 1);
});

test("a changed listing that drops the saved detail position restarts safely at its head", async () => {
  await sql`UPDATE sources SET cursor=${sql.json({ initializedAt: new Date().toISOString(), detailDateAfterIdentity: "url:https://removed.example/post" })} WHERE id=${id("position")}`;
  const run = await collectSource(id("position"), { force: true });
  assert.deepEqual([run.status, run.created], ["ok", 2]);
  assert.deepEqual((await articles("position")).map(a => a.url), [`${base}/position/post-0`, `${base}/position/post-1`]);
  assert.equal((await cursor("position")).detailDateAfterIdentity, identityKeyForUrl(`${base}/position/post-1`));
});

test("a failed material commit preserves the detail position and storage keeps original listing order", async () => {
  const previous = { initializedAt: new Date().toISOString(), detailDateAfterIdentity: identityKeyForUrl(`${base}/failed-store/post-2`) };
  await sql`UPDATE sources SET cursor=${sql.json(previous)} WHERE id=${id("failed-store")}`;
  const constraint = `detail_date_failure_${T}`;
  const blockedTitle = sql.unsafe("'" + `Source headline failed-store 3 ${T}`.replaceAll("'", "''") + "'");
  await sql`ALTER TABLE articles ADD CONSTRAINT ${sql(constraint)} CHECK (title <> ${blockedTitle}) NOT VALID`;
  try {
    const failed = await collectSource(id("failed-store"), { force: true });
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, new RegExp(constraint));
    assert.deepEqual(await cursor("failed-store"), previous, "the uncommitted rotation never advances on a storage failure");
    assert.deepEqual((await articles("failed-store")).map(a => a.url), [`${base}/failed-store/post-0`], "detail was read from 3 then 0, but storage still writes 0 before 3");
  } finally {
    await sql`ALTER TABLE articles DROP CONSTRAINT ${sql(constraint)}`;
  }
  assert.equal((await collectSource(id("failed-store"), { force: true })).created, 2);
  assert.equal((await collectSource(id("failed-store"), { force: true })).created, 1);
  assert.equal((await articles("failed-store")).length, 4, "retry fills the remaining entries without losing the committed prefix");
});
