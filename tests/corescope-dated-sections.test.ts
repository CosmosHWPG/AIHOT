import assert from "node:assert/strict";
import { test } from "node:test";
import { fromDatedSections } from "@aihot/backend/sources/web-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const source: SourceRow = {
  id: "test-dated-sections", name: "Product release notes", kind: "web_list", tier: "T1", first_party: true,
  participation_mode: "editorial", enabled: true, interval_minutes: 60, cursor: null, fail_count: 0,
  config: { parseMode: "dated_sections", itemSelector: "article h2[id], article h3[id]", preserveUrlFragment: true, publishedAtUtcOffset: "+00:00" },
};
const page = `<article><h2 id="october">October 2026</h2>
  <h3 id="oct-7">October 7, 2026</h3><p><strong>New agent controls</strong> are available with a documented release and public API.</p>
  <h3 id="oct-6">October 6, 2026</h3><p><strong>Improved deployment safety</strong> adds a separate capability and configuration.</p>
  <h2 id="september">September 2026</h2><p>Monthly navigation and summaries are not individual releases.</p></article>`;

test("daily changelog sections preserve distinct fragment identities and skip month headings", () => {
  const items = fromDatedSections(page, "https://example.org/releases", source);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((x) => x.identityKey), ["url:https://example.org/releases#oct-7", "url:https://example.org/releases#oct-6"]);
  assert.deepEqual(items.map((x) => x.publishedAt?.toISOString()), ["2026-10-07T00:00:00.000Z", "2026-10-06T00:00:00.000Z"]);
  assert.match(items[0]!.title, /^New agent controls/);
});

test("a section stops at the next heading of the same or higher level", () => {
  const items = fromDatedSections(page, "https://example.org/releases", source);
  assert.match(items[0]!.bodyText!, /public API/);
  assert.doesNotMatch(items[0]!.bodyText!, /deployment safety|Monthly navigation/);
  assert.doesNotMatch(items[1]!.bodyText!, /Monthly navigation/);
});

test("Chinese spaced date headings retain the source date and nested feature heading", () => {
  const html = `<article><h2 id="10-08-2026">2026 年 10 月 8 日</h2><h3>Gemini release</h3><p>This release documents a new supported model and migration details.</p></article>`;
  const [item] = fromDatedSections(html, "https://example.org/changelog", source);
  assert.equal(item?.publishedAt?.toISOString(), "2026-10-08T00:00:00.000Z");
  assert.equal(item?.url, "https://example.org/changelog#10-08-2026");
  assert.match(item?.title ?? "", /^Gemini release/);
});

test("undated headings and empty daily sections cannot fabricate a release", () => {
  const html = `<article><h2 id="unknown">Latest changes</h2><p>A useful update without a verifiable publication day.</p><h2 id="empty">October 8, 2026</h2><p>Short</p></article>`;
  assert.deepEqual(fromDatedSections(html, "https://example.org/changelog", source), []);
});

test("help-center wrapper blocks keep the daily body inside its own date boundary", () => {
  const html = `<article><div><h2 id="month">October 2026</h2></div><div><h3 id="day1">October 7, 2026</h3></div>
    <div><p><strong>New desktop controls</strong> give users a separate supported capability.</p></div>
    <div><h3 id="day2">October 6, 2026</h3></div><div><p>A different release adds tools for the documented desktop workflow.</p></div></article>`;
  const items = fromDatedSections(html, "https://example.org/releases", source);
  assert.equal(items.length, 2);
  assert.match(items[0]!.bodyText!, /desktop controls/);
  assert.doesNotMatch(items[0]!.bodyText!, /different release/);
});
