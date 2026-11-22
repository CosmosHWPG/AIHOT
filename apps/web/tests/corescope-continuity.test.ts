// CoreScope's reader-facing continuity across the upstream module and phone-shell split.
// Only an ephemeral web process and a synthetic public HTTP API; no database or model access.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, expect } from "@playwright/test";
import type { LbBoardEntry, LbBoardResponse, LbModelDetail, LbRunInfo, LbSourceDetail, LbSourcesResponse } from "@aihot/contracts/leaderboard";
import { fakeApi, feedItem, startWebServer, visit, type WebServer } from "./web-server.ts";

const at = new Date().toISOString();
const run: LbRunInfo = { id: "fixture", methodologyVersion: "2026.09-public-consensus-v15", generatedAt: at, fx: null };
const entry = (slug: string, rank: number, domestic: boolean, weightsUrl: string | null): LbBoardEntry => ({
  rank, score: 90 - rank / 10, model: { slug, name: `Model ${slug}`, provider: "Fixture", releasedAt: "2026-11-01", brand: { src: null, monogram: "F", raster: false } },
  sourceCount: 8, coverage: 0.8, confidence: "HIGH", stability: null, price: null, access: { domestic, weightsUrl },
});
const entries = [entry("global", 1, false, null), entry("domestic", 2, true, null), entry("open", 3, true, "https://example.org/weights")];
const sources: LbSourcesResponse = { run, rankedCount: 1, totalCount: 1, groups: [{ key: "fixture", name: "固定评测", blurb: "固定的公开评测证据", sources: [{ key: "fixture", name: "Fixture evaluator", operator: "Fixture", description: "固定评测介绍", status: "ranked", brand: null, budget: 0.1 }] }] };
const source: LbSourceDetail = { run, source: { ...sources.groups[0]!.sources[0]!, fullName: "Fixture evaluator", area: null, group: { key: "fixture", name: "固定评测" }, officialUrl: "https://example.org/", what: "固定评测机制", usage: "按共同证据排名", limits: "仅用于兼容测试", license: "Fixture", attribution: "Fixture" }, collected: true, upstreamAt: at, syncedAt: at, rows: [], systemRows: false, rowsNote: null };
const model: LbModelDetail = { run, historical: false, model: { ...entries[0]!.model, contextWindowTokens: null, weightsUrl: null }, price: null, overall: { rank: 1, score: 89.9, onBoard: true, confidence: "HIGH", stability: null }, categories: [], metricCount: 8, evidence: [], excluded: [], unmeasured: [], comparisons: [] };
const hits: URL[] = [];
let web: WebServer;
let origin: string;
const api = fakeApi((url, res) => {
  hits.push(url);
  const path = url.pathname;
  if (path.startsWith("/api/site/leaderboard/boards/")) {
    const key = path.split("/").at(-1)! as LbBoardResponse["board"]["key"];
    return { run, board: { key, name: key === "overall" ? "综合" : "编程", title: "固定模型榜", description: "固定公开评测榜", howToRead: "只比较共同证据。", sourceCount: 8, operatorCount: 3, modelCount: 4 }, tabs: [], entries, filterEntries: [entry("additional", 31, true, null)], pending: [] } satisfies LbBoardResponse;
  }
  if (path === "/api/site/leaderboard/sources") return sources;
  if (path === "/api/site/leaderboard/sources/fixture") return source;
  if (path === "/api/site/leaderboard/models/global") return model;
  if (path === "/api/site/leaderboard/rules") return { run, budgets: [], anchors: [] };
  if (path === "/api/site/search/suggestions") return { topics: [], hot: [] };
  if (path === "/api/site/timeline") {
    const item = feedItem({ id: "core-ai", title: "核心网与 AI 交叉动态", publishedAt: at, timelineAt: at });
    return { filters: { channel: "all", category: null, tag: url.searchParams.get("tag"), topic: url.searchParams.get("topic") }, cards: [{ key: item.id, anchorAt: at, item, group: null }], nextCursor: null, dayCounts: {}, hot: null };
  }
  if (path === "/api/site/pool") return { filters: { channel: "all", category: null, tag: url.searchParams.get("tag"), topic: url.searchParams.get("topic"), q: url.searchParams.get("q"), tab: "time" }, items: [], page: 1, pageCount: 1, total: 0, todayCount: 0, freshness: at };
  if (path === "/api/site/resources") return { resources: [] };
  if (path.startsWith("/api/site/leaderboard/")) { res.statusCode = 404; return { code: "not_found" }; }
});

before(async () => { web = await startWebServer(api); origin = web.origin; });
after(() => web.stop());

test("registered leaderboard pages keep their public addresses, published evidence and CoreScope navigation", async () => {
  for (const [path, text] of [
    ["/leaderboard", "Model global"], ["/leaderboard/category/coding", "固定公开评测榜"],
    ["/leaderboard/sources", "Fixture evaluator"], ["/leaderboard/sources/fixture", "固定评测机制"],
    ["/leaderboard/rules", "2026.09-public-consensus-v15"], ["/leaderboard/global", "Model global"],
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.ok(html.includes(text!), path);
    assert.match(html, /CoreScope/);
    assert.match(html, /研究与开发资源/);
    assert.doesNotMatch(html, /MyHOT|Codex 重置/);
  }
  const missing = await fetch(origin + "/leaderboard/category/unknown");
  assert.equal(missing.status, 404);
  const unknownModel = await fetch(origin + "/leaderboard/missing");
  assert.equal(unknownModel.status, 404);
  assert.ok(hits.some(u => u.pathname === "/api/site/leaderboard/models/global"));
});

test("phone search keeps the cross perspective and model filters retain original ranks", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    await visit(page, origin + "/leaderboard");
    await expect(page.getByRole("navigation", { name: "底部导航" }).getByRole("link", { name: "模型榜", exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "国产厂商", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(3);
    await expect(page.locator("tbody")).not.toContainText("Model global");
    await expect(page.locator("tbody tr").last()).toContainText("31");
    await page.getByRole("button", { name: "开放权重", exact: true }).click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody")).toContainText("Model open");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "the phone board must fit the viewport");
    await visit(page, origin + "/?" + new URLSearchParams({ tag: "核心网", topic: "ai" }));
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "搜索", exact: true });
    await dialog.getByRole("searchbox").fill("架构");
    await dialog.getByRole("searchbox").press("Enter");
    await expect(page).toHaveURL(url => url.pathname === "/all" && url.searchParams.get("q") === "架构" && url.searchParams.get("tag") === "核心网" && url.searchParams.get("topic") === "ai");
    const request = hits.findLast(url => url.pathname === "/api/site/pool" && url.searchParams.get("q") === "架构");
    assert.equal(request?.searchParams.get("tag"), "核心网");
    assert.equal(request?.searchParams.get("topic"), "ai");
    await page.close();
  } finally { await browser.close(); }
});
