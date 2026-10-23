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
