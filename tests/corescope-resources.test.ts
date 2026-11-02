import assert from "node:assert/strict";
import test from "node:test";
import { resourceDirectory } from "../packages/backend/src/publication/resources.ts";

test("resource directory exports authored links without private adapter data or isolated material", () => {
  const profiles = {
    catalog: { nonArticle: true, policy: "native", verification: { checkedAt: "2026-10-12T00:00:00Z" }, catalogPlan: { category: "模型目录", publicUrl: "https://example.com/models" },
      adapter: { config: { password: "private-marker", cacheDirectory: "private-user-path" } }, rawItems: ["suppressed-private-body"] },
    news: { policy: "native", nonArticle: false },
  };
  const result = resourceDirectory([{ id: "catalog", name: "模型资源" }, { id: "news", name: "新闻" }], profiles, new Map());
  assert.equal(result.length, 1);
  assert.equal(result[0]!.url, "https://example.com/models");
  assert.equal(result[0]!.status, "monitored");
  assert.doesNotMatch(JSON.stringify(result), /private-marker|private-user-path|suppressed-private-body|adapter|rawItems/);
});

test("resource links reject credentials and sensitive queries and reflect an operator pause", () => {
  const result = resourceDirectory([{ id: "a", name: "A" }, { id: "b", name: "B" }], {
    a: { nonArticle: true, policy: "native", catalogPlan: { publicUrl: "https://user:password@example.com/" } },
    b: { nonArticle: true, policy: "blocked", catalogPlan: { publicUrl: "https://example.com/?token=private", required: "具体软件包", status: "needs_scope" } },
  }, new Map(), [{ id: "a", enabled: false, last_fetch_at: new Date("2026-10-12T00:00:00Z") }]);
  assert.equal(result[0]!.url, null);
  assert.equal(result[0]!.status, "paused");
  assert.equal(result[1]!.url, null);
  assert.equal(result[1]!.status, "needs_scope");
});

test("an authored old-article reference does not isolate its editorial source or expose material", () => {
  const source = Object.freeze({ id: "eleuther", name: "EleutherAI Blog", participation_mode: "editorial", enabled: true });
  const profiles = {
    eleuther: { policy: "native", nonArticle: false, participationMode: "editorial",
      verification: { checkedAt: "2026-11-01T00:00:00Z" },
      adapter: { config: { cookie: "private-cookie" } },
      referenceArticles: [{ url: "https://blog.eleuther.ai/subliminal-learning-pretraining/",
        title: "EleutherAI · Subliminal Learning 研究资料", category: "模型训练与安全研究",
        description: "原始发布日期2026-10-25；作为研究资料浏览，不计作本周新发新闻。",
        body: "private-article-body", receipt: "private-provider-receipt" }],
    },
  };
  const before = JSON.stringify({ source, profiles });
  const result = resourceDirectory([source], profiles, new Map());
  assert.equal(result.length, 1);
  assert.equal(result[0]!.url, profiles.eleuther.referenceArticles[0]!.url);
  assert.equal(result[0]!.status, "reference");
  assert.equal(result[0]!.checkedAt, "2026-11-01T00:00:00.000Z");
  assert.match(result[0]!.description, /2026-10-25/);
  assert.equal(JSON.stringify({ source, profiles }), before);
  assert.equal(source.participation_mode, "editorial");
  assert.doesNotMatch(JSON.stringify(result), /private-cookie|private-article-body|private-provider-receipt|adapter|receipt|participationMode/);
});

test("reference cards reject unsafe links and deduplicate repeated public URLs", () => {
  const sources = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
  const profiles = {
    a: { policy: "native", referenceArticles: [
      { title: "Unsafe", url: "https://user:password@example.com/reference" },
      { title: "Unsafe", url: "https://example.com/reference?signature=secret" },
      { title: "Unsafe", url: "javascript:alert(1)" },
      { title: "Valid", url: "https://example.com/reference" },
      { title: "Duplicate", url: "https://example.com/reference" },
      { title: " ", url: "https://example.com/no-title" },
    ] },
    b: { policy: "native", referenceArticles: [{ title: "Same public reference", url: "https://example.com/reference" }] },
  };
  const result = resourceDirectory(sources, profiles, new Map());
  assert.equal(result.length, 1);
  assert.equal(result[0]!.name, "Valid");
  assert.doesNotMatch(JSON.stringify(result), /password|signature|secret|javascript|Duplicate/);
  assert.equal(resourceDirectory(sources, profiles, new Map())[0]!.id, result[0]!.id);
});

test("an operator pause is reflected for a reference without calling it a monitored article", () => {
  const result = resourceDirectory([{ id: "a", name: "A" }], {
    a: { policy: "native", referenceArticles: [{ title: "Reference", url: "https://example.com/reference" }] },
  }, new Map(), [{ id: "a", enabled: false, last_fetch_at: new Date("2026-11-01T00:00:00Z") }]);
  assert.equal(result[0]!.status, "paused");
  assert.equal(result[0]!.checkedAt, "2026-11-01T00:00:00.000Z");
});
