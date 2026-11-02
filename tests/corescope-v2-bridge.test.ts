import "./setup.ts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { importBatch, type BridgeBatch, type BridgeItem, validateBatch, bridgeIntakeAllowed, validateBridgeIntakePrefixes } from "../scripts/corescope-v2-core.ts";
import { tag } from "./setup.ts";

const T = tag();
const source = { id: `v2-source-test-${T}`, name: "Bridge fixture", kind: "external", config: {}, tier: "T2",
  first_party: false, owner_entity_id: null, signal_group_id: `publisher:test-${T}`, participation_mode: "editorial",
  interval_minutes: 60, tags: [], site_fulltext: false, syndicate_fulltext: false, enabled: true };
const discovered = new Date(Date.now() - 3600_000).toISOString();
const item = (id: number, changes: Partial<BridgeItem> = {}): BridgeItem => ({
  v2Id: id, v2ArticleId: `v2-${id}`, v2SourceId: "SRC-TEST", sourceId: source.id, sourceAlias: source.id,
  title: "Original material", url: `https://example.org/corescope-bridge-${T}-${id}`, language: "en",
  publishedAt: discovered, discoveredAt: discovered, updatedAt: discovered, excerpt: "Original source excerpt",
  bodyText: "Original source body; this is not a model summary", bodyStatus: "unconfirmed", fingerprint: "a".repeat(64),
  bodyEvidence: { origin: "original_raw_unverified", fulltextVerified: false, publicFulltextAllowed: false },
  sourceEvidence: [{ evidence_type: "arxiv_direct", evidence_url: "https://arxiv.org/abs/2609.12345" }],
  v2Metadata: { modelSummary: "V2 model result that must never become raw body", analysisOrigin: "V2 prior analysis" }, ...changes,
});
const batch = (items: BridgeItem[], changes: Partial<BridgeBatch> = {}): BridgeBatch => ({
  schemaVersion: 1, client: "corescope-v2", generatedAt: new Date().toISOString(), initialSince: discovered,
  cursorBefore: null, cursorAfter: { updatedAt: discovered, id: items.at(-1)?.v2Id ?? 0, scanAfter: null }, hasMore: false,
  sources: [source], items, dataLatest: { crawled_at: discovered }, ...changes,
});
before(async () => {
  await sql`DELETE FROM corescope_bridge_ledger WHERE client='corescope-v2'`;
  await sql`DELETE FROM corescope_bridge_state WHERE client='corescope-v2'`;
});
after(async () => { await stopBoss(); await closeDb(); });

test("raw bridge preserves original body, timestamps, evidence and URL; repeating a committed batch adds nothing", async () => {
  const input = batch([item(1001)]);
  const first = await importBatch(input);
  assert.equal(first.created, 1);
  assert.equal(first.queued, 1);
  const [row] = await sql`SELECT * FROM articles WHERE url=${input.items[0]!.url}`;
  assert.equal(row!.body_text, input.items[0]!.bodyText);
  assert.equal(row!.body_status, "unconfirmed");
  assert.equal(row!.published_at.toISOString(), discovered);
  assert.equal(row!.discovered_at.toISOString(), discovered);
  assert.equal(row!.raw.v2.priorAnalysis.modelSummary, input.items[0]!.v2Metadata.modelSummary);
  assert.equal(row!.raw.v2.sourceEvidence[0].evidence_type, "arxiv_direct");
  const repeated = await importBatch(input);
  assert.equal(repeated.created, 0);
  assert.equal(repeated.revised, 0);
  assert.equal(repeated.queued, 0);
  assert.equal((await sql`SELECT 1 FROM articles WHERE url=${input.items[0]!.url}`).length, 1);
});

test("paused later source rolls back the earlier material, job, ledger and progress", async () => {
  const paused = { ...source, id: `v2-source-paused-${T}`, enabled: false };
  await sql`INSERT INTO sources (id,name,kind,enabled) VALUES (${paused.id},'Paused bridge fixture','external',false)`;
  const [state] = await sql`SELECT cursor FROM corescope_bridge_state WHERE client='corescope-v2'`;
  const beforeCursor = state!.cursor;
  const input = batch([item(1002), item(1003, { sourceId: paused.id })], { sources: [source, paused], cursorBefore: beforeCursor });
  await assert.rejects(() => importBatch(input), /paused/);
  assert.equal((await sql`SELECT 1 FROM articles WHERE url=${input.items[0]!.url}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM corescope_bridge_ledger WHERE upstream_id=1002`).length, 0);
  const [afterState] = await sql`SELECT cursor FROM corescope_bridge_state WHERE client='corescope-v2'`;
  assert.deepEqual(afterState!.cursor, beforeCursor);
});

test("two V2 identities for one original URL share a material and retain both alias receipts", async () => {
  const [state] = await sql`SELECT cursor FROM corescope_bridge_state WHERE client='corescope-v2'`;
  const url = `https://example.org/corescope-one-original-${T}`;
  const input = batch([item(1004, { url }), item(1005, { url, sourceAlias: `v2-source-alias-${T}` })], { cursorBefore: state!.cursor });
  const result = await importBatch(input);
  assert.equal(result.created, 1);
  assert.equal(result.queued, 1);
  assert.equal((await sql`SELECT 1 FROM articles WHERE url=${url}`).length, 1);
  const ledger = await sql`SELECT article_id,source_alias FROM corescope_bridge_ledger WHERE upstream_id IN (1004,1005)`;
  assert.equal(ledger.length, 2);
  assert.equal(ledger[0]!.article_id, ledger[1]!.article_id);
  assert.equal(new Set(ledger.map((r) => r.source_alias)).size, 2);
});

test("changed evidence updates its receipt without a body revision or another paid job", async () => {
  const [state] = await sql`SELECT cursor FROM corescope_bridge_state WHERE client='corescope-v2'`;
  const changed = item(1005, { url: `https://example.org/corescope-one-original-${T}`, fingerprint: "b".repeat(64),
    sourceEvidence: [{ evidence_type: "wechat_digest", parent_digest_url: "https://example.org/digest" }] });
  const result = await importBatch(batch([changed], { cursorBefore: state!.cursor }));
  assert.equal(result.created, 0);
  assert.equal(result.revised, 0);
  assert.equal(result.queued, 0);
  const [row] = await sql`SELECT source_evidence FROM corescope_bridge_ledger WHERE upstream_id=1005`;
  assert.equal(row!.source_evidence[0].evidence_type, "wechat_digest");
});

test("replaying an older fingerprint after a correction cannot rewind the ledger", async () => {
  const old = item(1005, { url: `https://example.org/corescope-one-original-${T}` });
  await assert.rejects(() => importBatch(batch([old])), /cursor changed/);
  const [row] = await sql`SELECT raw_fingerprint FROM corescope_bridge_ledger WHERE upstream_id=1005`;
  assert.equal(row!.raw_fingerprint, "b".repeat(64));
});

test("credential URLs and fabricated fulltext confirmation are rejected before database writes", () => {
  assert.throws(() => validateBatch(batch([item(1006, { url: "https://example.org/news?api_key=secret" })])), /Unsafe/);
  assert.throws(() => validateBatch(batch([item(1006, { bodyEvidence: { fulltextVerified: true } })])), /verification/);
});

test("source directory refresh preserves a manual pause instead of enabling it from V2 status", async () => {
  const paused = { ...source, id: `v2-source-manual-paused-${T}`, enabled: true };
  await sql`INSERT INTO sources (id,name,kind,enabled,health) VALUES (${paused.id},'Operator paused source','external',false,'paused')`;
  const [state] = await sql`SELECT cursor FROM corescope_bridge_state WHERE client='corescope-v2'`;
  await importBatch(batch([], { sources: [paused], cursorBefore: state!.cursor, cursorAfter: state!.cursor }));
  const [saved] = await sql`SELECT enabled,health FROM sources WHERE id=${paused.id}`;
  assert.deepEqual([saved!.enabled, saved!.health], [false, "paused"]);
});

test("native routes suppress the bridge before and after source database reconciliation", async () => {
  const pending = { ...source, id: `v2-source-native-pending-${T}`, kind: "rss", config: { feedUrl: "https://example.org/pending.xml" } };
  const ready = { ...source, id: `v2-source-native-ready-${T}`, kind: "rss", config: { feedUrl: "https://example.org/ready.xml" } };
  await sql`INSERT INTO sources (id,name,kind,enabled) VALUES (${pending.id},'Pending route reconciliation','external',true)`;
  await sql`INSERT INTO sources (id,name,kind,config,enabled) VALUES (${ready.id},'Native route','rss',${sql.json(ready.config)},true)`;
  const [state] = await sql`SELECT cursor FROM corescope_bridge_state WHERE client='corescope-v2'`;
  const input = batch([item(1010, { sourceId: pending.id }), item(1011, { sourceId: ready.id })],
    { sources: [pending, { ...ready, kind: "external", config: {} }], cursorBefore: state!.cursor });
  const result = await importBatch(input);
  assert.equal(result.nativeSkipped, 2);
  assert.deepEqual([result.created, result.revised, result.queued], [0, 0, 0]);
  assert.equal((await sql`SELECT 1 FROM articles WHERE source_id IN (${pending.id},${ready.id})`).length, 0);
  assert.equal((await sql`SELECT 1 FROM corescope_bridge_ledger WHERE upstream_id IN (1010,1011)`).length, 0);
  const [saved] = await sql`SELECT kind,config FROM sources WHERE id=${ready.id}`;
  assert.deepEqual([saved!.kind, saved!.config], ["rss", ready.config]);
});

test("publisher intake boundaries reject hostile hosts, sibling paths and private prefixes", () => {
  const prefixes = validateBridgeIntakePrefixes(["https://qwen.ai/blog/"]);
  assert.equal(bridgeIntakeAllowed("http://QWEN.AI:80/blog/release?lang=en", prefixes), true);
  for (const url of ["https://qwen.ai.evil.example/blog/release", "https://qwen.ai/blogger/release",
    "https://qwen.ai/blog/%2e%2e/other", "https://qwen.ai/blog/release?api_key=fixture"]) {
    assert.equal(bridgeIntakeAllowed(url, prefixes), false);
  }
  assert.equal(bridgeIntakeAllowed("https://any.example/news", []), false);
  assert.equal(bridgeIntakeAllowed("https://any.example/news"), true);
  for (const invalid of ["not-an-array", ["ftp://example.org/feed"], ["https://user:fixture@example.org/news"],
    ["https://example.org/news?lang=en"], ["https://example.org/news#part"], ["https://rss.app/feeds/fixture-private-handle.xml"]]) {
    assert.throws(() => validateBridgeIntakePrefixes(invalid));
  }
});

test("file imports enforce local publisher guards, preserve other sources and advance past rejected material", async () => {
  const guarded = { ...source, id: `v2-source-publisher-${T}` };
  const blocked = { ...source, id: `v2-source-no-publisher-${T}` };
  const profiles = { [guarded.id]: { policy: "bridge", bridgeIntakeUrlPrefixes: ["https://qwen.ai/blog/"] },
    [blocked.id]: { policy: "bridge", bridgeIntakeUrlPrefixes: [] } };
  const [state] = await sql`SELECT cursor FROM corescope_bridge_state WHERE client='corescope-v2'`;
  const input = batch([
    item(1012, { sourceId: guarded.id, sourceAlias: guarded.id, url: `https://wrong-publisher.example/news-${T}` }),
    item(1013, { sourceId: guarded.id, sourceAlias: guarded.id, url: `https://qwen.ai/blog/news-${T}` }),
    item(1014, { sourceId: blocked.id, sourceAlias: blocked.id, url: `https://mp.sohu.com/a/blocked-${T}` }),
    item(1015),
  ], { sources: [source, guarded, blocked], cursorBefore: state!.cursor });
  const result = await importBatch(input, { queue: false, intakeProfiles: profiles });
  assert.deepEqual([result.created, result.intakeSkipped], [2, 2]);
  assert.equal((await sql`SELECT 1 FROM corescope_bridge_ledger WHERE upstream_id IN (1012,1014)`).length, 0);
  assert.equal((await sql`SELECT cursor FROM corescope_bridge_state WHERE client='corescope-v2'`)[0]!.cursor.id, 1015);
  const repeated = await importBatch(input, { queue: false, intakeProfiles: profiles });
  assert.deepEqual([repeated.created, repeated.intakeSkipped, repeated.replayed], [0, 2, true]);
  const [next] = await sql`SELECT cursor FROM corescope_bridge_state WHERE client='corescope-v2'`;
  const rejected = batch([item(1016, { sourceId: blocked.id, sourceAlias: blocked.id })],
    { sources: [blocked], cursorBefore: next!.cursor });
  const empty = await importBatch(rejected, { queue: false, intakeProfiles: profiles });
  assert.deepEqual([empty.created, empty.intakeSkipped], [0, 1]);
  assert.equal((await sql`SELECT cursor FROM corescope_bridge_state WHERE client='corescope-v2'`)[0]!.cursor.id, 1016);
});
