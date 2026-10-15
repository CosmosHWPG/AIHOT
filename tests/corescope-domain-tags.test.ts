import "./setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { withDomainTags } from "@aihot/backend/lib/domain-tags";
import { normalizeAnalysis, type AnalysisRun } from "@aihot/backend/editorial/analyze";

test("domain filters keep explicit structure evidence when writing chooses other tags, without changing selection", () => {
  const run: AnalysisRun = {
    prefilter: { label: "PASS", reason: "source evidence", model: "stub", receiptId: 1, reused: false },
    scores: { model: "stub", threshold: 60, values: [75, 75], receiptIds: [2, 3], reused: false },
    writing: { kind: "understand", model: "stub", titleZh: "技术进展", summaryZh: "可审阅的原始材料摘要", reasonZh: "架构信息", tags: ["产品更新"], receiptIds: [5], reused: false },
    structure: { model: "stub", category: "ai-products", tags: ["AI", "核心网"], subjects: [], fact: null, receiptId: 4, reused: false },
  };
  const result = normalizeAnalysis(run);
  assert.deepEqual(result.tags, ["产品更新", "AI", "核心网"]);
  assert.equal(result.selected, true);
  assert.equal(result.score, 75);
});

test("exclusive domain vocabulary includes AI infrastructure and 5GC in their correct reader filters", () => {
  assert.deepEqual(withDomainTags(["AI基础设施", "NVIDIA"]), ["AI基础设施", "NVIDIA", "AI"]);
  assert.deepEqual(withDomainTags(["5GC/核心网"]), ["5GC/核心网", "核心网"]);
  assert.deepEqual(withDomainTags(["AI基础设施", "6G"]), ["AI基础设施", "6G", "AI", "核心网"]);
});

test("company names, general engineering and ambiguous standards never infer a domain", () => {
  const tags = ["NVIDIA", "Google", "部署/工程", "云原生网络", "标准/协议", "网络安全", "unknown"];
  assert.deepEqual(withDomainTags(tags), tags);
  assert.deepEqual(withDomainTags(["AI", "AI基础设施", "AI"]), ["AI", "AI基础设施"]);
});
