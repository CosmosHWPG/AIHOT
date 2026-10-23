import "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { buildScoreInput } from "@aihot/backend/editorial/analyze";
import { buildMaterial, type AnalyzeInputArticle } from "@aihot/backend/editorial/input";
import { renderContext } from "@aihot/backend/editorial/writing";

const input: AnalyzeInputArticle = { id: "v2-evidence-fixture", revision: 1, title: "5GC source report", url: "https://example.org/report",
  author: null, publishedAt: new Date("2026-10-01T12:00:00Z"), discoveredAt: new Date("2026-10-01T13:00:00Z"),
  bodyText: "Available original raw text. ".repeat(1000), excerpt: null, bodyStatus: "unconfirmed", xPost: null, media: [],
  source: { name: "Original publisher", kind: "external", tier: "T1", firstParty: true, tags: ["核心网"], ownerEntityId: null, fetchesBody: false },
  translationZh: null };

test("long unverified V2 text remains unconfirmed in every editorial prompt", () => {
  const writing = renderContext(input);
  assert.match(writing, /材料质量.*完整性未确认/);
  assert.doesNotMatch(writing, /完整正文（来自/);
  const score = buildScoreInput(input);
  assert.match(score, /来源文本（完整性未确认/);
  assert.doesNotMatch(score, /【完整正文】/);
  assert.match(buildMaterial(input), /材料完整性：未确认/);
});

test("confirmed native source text keeps its original scoring context", () => {
  const confirmed = { ...input, bodyStatus: "ok" };
  assert.match(buildScoreInput(confirmed), /【完整正文】/);
  assert.match(renderContext(confirmed), /完整正文（来自 RSS/);
});
