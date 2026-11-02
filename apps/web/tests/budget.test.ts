import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetChanged, budgetDraft, budgetUpdate } from "../app/features/admin/budget.ts";

const version = "2026-10-13T14:00:00.123Z";
const bird = { service: "bird", enabled: true, per_minute: 1, per_hour: 10, per_day: 120, used_hour: 9, used_day: 70, updated_at: version };
const llm = { service: "llm", enabled: true, per_minute: 20, per_hour: 180, per_day: 2000, used_hour: 180, used_day: 980, updated_at: version };

test("closing one service sends only the switch, so stale temporary limits cannot overwrite restored limits", () => {
  const before = structuredClone([llm, bird]);
  const draft = { ...budgetDraft(llm), enabled: false };
  assert.deepEqual(budgetUpdate(llm, draft, "  startup processing  "),
    { enabled: false, reason: "startup processing", version });
  assert.deepEqual([llm, bird], before);
  assert.equal(budgetChanged(bird, budgetDraft(bird)), false);
  assert.equal(budgetUpdate(bird, budgetDraft(bird), "do not change Bird"), null);
});

test("re-enabling preserves prior numeric limits, including an explicit zero stop limit", () => {
  const stopped = { ...llm, enabled: false, per_minute: 0 };
  const draft = { ...budgetDraft(stopped), enabled: true };
  assert.deepEqual(budgetUpdate(stopped, draft, "resume enforcement"),
    { enabled: true, reason: "resume enforcement", version });
  assert.equal(stopped.enabled, false);
  assert.equal(stopped.per_minute, 0);
  assert.deepEqual(budgetUpdate(stopped, { ...budgetDraft(stopped), perHour: 90 }, "change retained hourly limit"),
    { perHour: 90, reason: "change retained hourly limit", version }, "a numeric edit leaves the enforcement switch and other limits alone");
});

test("a switch requires an audit reason and rejects invalid retained limits instead of serializing them", () => {
  const draft = { ...budgetDraft(llm), enabled: false };
  assert.equal(budgetUpdate(llm, draft, "  "), null);
  for (const invalid of [NaN, Infinity, -1, 0.5]) {
    assert.equal(budgetUpdate(llm, { ...draft, perDay: invalid }, "startup"), null);
  }
  assert.equal(budgetUpdate(llm, budgetDraft(llm), "reason alone is not a change"), null);
});

test("older responses without an enforcement field retain existing enabled behavior", () => {
  const legacy = { per_minute: 1, per_hour: 10, per_day: 120 };
  assert.equal(budgetDraft(legacy).enabled, true);
  assert.deepEqual(budgetUpdate(legacy, { ...budgetDraft(legacy), enabled: false }, "disable enforcement"),
    { enabled: false, reason: "disable enforcement" });
});
