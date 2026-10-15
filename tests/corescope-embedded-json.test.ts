import assert from "node:assert/strict";
import { test } from "node:test";
import { embeddedJson, jsonValueAt } from "@aihot/backend/sources/json-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const source: SourceRow = {
  id: "test-flight", name: "Embedded publisher articles", kind: "json_list", tier: "T1", first_party: true,
  participation_mode: "editorial", enabled: true, interval_minutes: 60, cursor: null, fail_count: 0,
  config: { mode: "html_json_key", jsonKey: "articles" },
};
const flight = (text: string) => `<script>self.__next_f.push(${JSON.stringify([1, text])})</script>`;

test("a Flight articles array keeps nested arrays, metadata and later items", () => {
  const articles = [
    { id: "one", fields: { title: "One", body: [], images: [{ sizes: [1, 2] }], publishedAt: "2026-10-12" } },
    { id: "two", fields: { title: "Two", body: [{ text: "A second article" }], publishedAt: "2026-10-11" } },
  ];
  const html = flight(`c:["$","Component",null,${JSON.stringify({ articles })}]\n`);
  assert.deepEqual(embeddedJson(html, source), { articles });
});

test("brackets and escaped quotes in strings do not end a JSON value", () => {
  const value = [{ title: 'A ] bracket and a \\" quote', body: "{ still text }", data: [[{ end: "]" }]] }];
  const text = `prefix ${JSON.stringify(value)} suffix`;
  const parsed = jsonValueAt(text, 7);
  assert.deepEqual(parsed?.value, value);
  assert.equal(text.slice(parsed!.end), " suffix");
});

test("truncated and invalid JSON fail instead of accepting a partial articles list", () => {
  assert.equal(jsonValueAt('[{"nested":[1,2]}', 0), null);
  assert.equal(jsonValueAt('[{"bad":undefined}]', 0), null);
  assert.equal(jsonValueAt('{"mismatch":1] extra', 0), null);
  assert.throws(() => embeddedJson(flight('a:{"articles":[{"body":[]},'), source), /embedded key articles not found/);
});

test("window JSON objects use the same bounded scanner without executing script", () => {
  const withWindow = { ...source, config: { mode: "html_window_var", windowVar: "PUBLIC_DATA" } };
  assert.deepEqual(embeddedJson('<script>window.PUBLIC_DATA = {"articles":[{"title":"safe [ value"}]};throw new Error("must not run")</script>', withWindow), { articles: [{ title: "safe [ value" }] });
});
