import assert from "node:assert/strict";
import { after, test } from "node:test";
import http from "node:http";
import { config } from "@aihot/backend/config";
import { fromArticleLinks, fetchWebList } from "@aihot/backend/sources/web-list";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";
import { parseWxArticles, wxPublishedAt } from "@aihot/backend/sources/wx-articles";
import { fetchJsonList } from "@aihot/backend/sources/json-list";

const source = (extra: Record<string, unknown> = {}): SourceRow => ({
  id: "native-article-profile", name: "Native article profile", kind: "web_list", cursor: null,
  tier: "T2", first_party: false, interval_minutes: 60, enabled: true, fail_count: 0,
  participation_mode: "editorial", config: { adapter: "article_links", itemUrlPattern: "^/news/[a-z0-9-]+$", ...extra },
});

test("article profiles exclude menu, listing, resource and external links before deduplication", () => {
  const html = [
    '<a href="/news/release-one">Read more</a>',
    '<a href="/news/release-one">A core network product release</a>',
    '<a href="/news/">Browse news</a>', '<a href="/news/page/2">Older publications</a>',
    '<a href="/models/new-model">A resource directory entry</a>',
    '<a href="https://elsewhere.example/news/release-two">An unrelated release headline</a>',
    '<a href="/news/about">About</a>',
  ].join("");
  const out = fromArticleLinks(html, "https://vendor.example/news/", source({ url: "https://vendor.example/news/" }));
  assert.deepEqual(out.map((c) => [c.url, c.title, c.publishedAt]), [["https://vendor.example/news/release-one", "A core network product release", null]]);
});

test("card profiles preserve source time and summary without inventing dates for undated links", () => {
  const html = '<article><a class="headline" href="/news/release-one">A core network release</a><time datetime="2026-10-01T11:20:00+08:00"></time><p class="summary">Source summary only</p></article>' +
    '<article><a class="headline" href="/news/release-two">Another core network release</a><p class="summary">Undated source summary</p></article>';
  const cfg = { itemSelector: "article", linkSelector: ".headline", publishedAtSelector: "time", summarySelector: ".summary" };
  const out = fromArticleLinks(html, "https://vendor.example/", source(cfg));
  assert.equal(out[0]!.publishedAt!.toISOString(), "2026-10-01T03:20:00.000Z");
  assert.equal(out[0]!.excerpt, "Source summary only");
  assert.equal(out[1]!.publishedAt, null);
  assert.equal(fromArticleLinks(html, "https://vendor.example/", source({ ...cfg, requirePublishedAt: true })).length, 1);
});

test("an article profile cannot silently fall back to generic anchors", () => {
  assert.throws(() => fromArticleLinks('<a href="/news/release">A product release</a>', "https://vendor.example/", source({ itemUrlPattern: undefined })), /itemUrlPattern missing/);
  assert.deepEqual(unsupportedConfig("web_list", source().config), []);
  assert.deepEqual(unsupportedConfig("mp_account", { transport: "wx_cache", account: "通信专家", limit: 8, lookbackDays: 7 }), []);
  assert.deepEqual(unsupportedConfig("mp_account", { transport: "unknown" }), ["transport=unknown"]);
});

let posted: { method: string | undefined; contentType: string | undefined; body: string } | null = null;
const server = http.createServer((req, res) => {
  if (req.url === "/json") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      posted = { method: req.method, contentType: req.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: 7, title: "厂商发布核心网技术白皮书", url: "https://vendor.example/news/new-release", date: "2026-10-01 10:20:00", summary: "来源摘要" }] }));
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end('<a href="/models/">Models and tools</a><a href="/about">About this vendor</a>');
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const listing = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("a 200 resource page with no article matches is a failed fetch, not healthy news output", async () => {
  await assert.rejects(fetchWebList(source({ url: listing })), /no items matched \(article_links\)/);
});

test("WeChat article records preserve original URL, real publication time and source provenance", () => {
  const sourceUrl = "https://mp.weixin.qq.com/s/abc?scene=21";
  const out = parseWxArticles(JSON.stringify({ data: { articles: [{ title: "核心网架构更新", url: sourceUrl, time: "2026-10-01 10:20:00", digest: "文章摘要", account_username: "network-expert" }] } }), "通信专家");
  assert.equal(out[0]!.url, sourceUrl);
  assert.equal(out[0]!.publishedAt!.toISOString(), "2026-10-01T02:20:00.000Z");
  assert.equal(out[0]!.excerpt, "文章摘要");
  assert.equal(out[0]!.bodyStatus, "pending", "a digest is not a full body");
  assert.deepEqual(out[0]!.raw, { wechat: { account: "通信专家", accountUsername: "network-expert" } });
  assert.equal(wxPublishedAt({ time: "2026-10-01" })!.toISOString(), "2026-09-30T16:00:00.000Z");
  assert.equal(wxPublishedAt({ timestamp: 1790821200000 })!.getTime(), 1790821200000);
  assert.equal(wxPublishedAt({ timestamp: 1790821200 })!.getTime(), 1790821200000);
});

test("empty WeChat records, malformed envelopes and off-platform records remain distinguishable", () => {
  assert.deepEqual(parseWxArticles('{"data":{"articles":[]}}', "通信专家"), []);
  assert.throws(() => parseWxArticles("credential failure", "通信专家"), /output is not JSON/);
  assert.throws(() => parseWxArticles('{"error":"login expired"}', "通信专家"), /article list missing/);
  assert.throws(() => parseWxArticles('[{"title":"Foreign link","url":"https://elsewhere.example/news/post"}]', "通信专家"), /no valid WeChat article/);
  const undated = parseWxArticles('[{"title":"无发布日期的原始文章","url":"https://mp.weixin.qq.com/s/undated"}]', "通信专家");
  assert.equal(undated[0]!.publishedAt, null, "missing time is never replaced with collection time");
});

test("native JSON profiles support POST and explicit source timezone without treating summaries as full text", async () => {
  const out = await fetchJsonList({ ...source(), kind: "json_list", config: {
    url: `${listing}json`, method: "POST", bodyJson: { offset: 0, limit: 8 }, itemsPath: "data", titlePaths: ["title"], summaryPaths: ["summary"],
    urlTemplate: "{raw:url}", publishedAtPath: "date", publishedAtUtcOffset: "+08:00", externalIdPath: "id",
  } });
  assert.equal(out[0]!.url, "https://vendor.example/news/new-release");
  assert.equal(out[0]!.publishedAt!.toISOString(), "2026-10-01T02:20:00.000Z");
  assert.equal(out[0]!.excerpt, "来源摘要");
  assert.equal(out[0]!.bodyStatus, "pending");
  assert.deepEqual(posted, { method: "POST", contentType: "application/json", body: '{"offset":0,"limit":8}' });
});
