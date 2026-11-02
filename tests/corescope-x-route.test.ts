// No database, network, credentials or collector calls: supplier position and provenance contracts.
import test from "node:test";
import assert from "node:assert/strict";
import { historicXProvider, transitionXCursor, xRouteChange } from "@aihot/backend/sources/x-route";

const oldConfig = { query: "from:scope -filter:replies", searchType: "Latest", provider: "xquik" };
const birdConfig = { ...oldConfig, provider: "bird", bird: { accountProfile: "birdclaw-primary", maxPagesPerRound: 1 } };
const now = new Date("2026-10-13T06:00:00Z");

test("provider switch keeps source position and archives tokens without ever executing them on Bird", () => {
  const cursor = { lastTweetId: "1980000000000000000", initializedAt: "2026-10-01T00:00:00Z", lastOkAt: "2026-10-12T00:00:00Z",
    xBacklog: [{ query: `from:scope since_id:${(BigInt(Date.parse("2026-10-05T00:00:00Z")) - 1288834974657n) << 22n}`, next: "opaque-xquik-token" }], custom: { retained: true } };
  const before = structuredClone(cursor);
  const result = transitionXCursor(cursor, oldConfig, birdConfig, now);
  assert.equal(result.change, "provider-only");
  assert.equal(result.archivedBacklog, 1);
  assert.deepEqual(cursor, before, "source snapshot is not mutated before commit");
  assert.equal(result.cursor!.lastTweetId, cursor.lastTweetId);
  assert.equal(result.cursor!.initializedAt, cursor.initializedAt);
  assert.deepEqual(result.cursor!.custom, cursor.custom);
  assert.equal(result.cursor!.xBacklog, undefined);
  const bird = result.cursor!.bird as Record<string, unknown>;
  assert.deepEqual(bird.backlog, []);
  assert.equal(bird.coverage, "partial");
  assert.equal(bird.checkedAt, null, "switching is not a successful Bird read");
  assert.deepEqual(bird.gap, { from: "2026-10-05T00:00:00.000Z", to: now.toISOString(), reason: "provider_switch_backlog" },
    "the pending range can predate the last successful top-page read");
  const history = result.cursor!.xRouteHistory as Array<Record<string, unknown>>;
  assert.deepEqual(history[0]!.backlog, cursor.xBacklog);
  assert.deepEqual([history[0]!.fromProvider, history[0]!.toProvider], ["xquik", "bird"]);
  assert.ok(!JSON.stringify(bird).includes("opaque-xquik-token"));
});

test("round trip never resumes archived Bird tokens on a different provider or profile", () => {
  const priorBird = { ...birdConfig, bird: { accountProfile: "profile-a" } };
  const cursor = { lastTweetId: "1980", initializedAt: "2026-10-01T00:00:00Z", bird: {
    coverage: "partial", backlog: [{ next: "opaque-bird", lowerId: "1970", since: "2026-10-12T00:00:00Z" }],
    gap: { from: "2026-10-12T00:00:00Z", to: "2026-10-13T00:00:00Z", reason: "later_page_failed" } } };
  const paid = transitionXCursor(cursor, priorBird, oldConfig, now).cursor!;
  assert.equal(paid.bird, undefined);
  assert.equal(paid.xBacklog, undefined);
  assert.equal(paid.lastTweetId, cursor.lastTweetId);
  const returning = transitionXCursor(paid, oldConfig, birdConfig, now).cursor!;
  assert.deepEqual((returning.bird as Record<string, unknown>).backlog, []);
  assert.equal((returning.xRouteHistory as unknown[]).length, 2);
  const otherProfile = transitionXCursor(cursor, priorBird, birdConfig, now);
  assert.equal(otherProfile.change, "provider-only");
  assert.deepEqual((otherProfile.cursor!.bird as Record<string, unknown>).backlog, []);
});

test("supplier change to another account archives history and does not reuse the former account's watermark", () => {
  const result = transitionXCursor({ lastTweetId: "1980", initializedAt: "2026-10-01T00:00:00Z" }, oldConfig,
    { ...birdConfig, query: "from:other -filter:replies" }, now);
  assert.equal(result.change, "account-route");
  assert.equal(result.cursor!.lastTweetId, undefined);
  assert.equal(result.cursor!.initializedAt, undefined);
  assert.equal((result.cursor!.xRouteHistory as Array<Record<string, unknown>>)[0]!.lastTweetId, "1980");
  assert.equal(xRouteChange({ ...oldConfig, provider: undefined, searchType: undefined }, { ...oldConfig, provider: "socialdata" }), "none");
  assert.equal(xRouteChange(oldConfig, { ...oldConfig, query: "from:other -filter:replies" }), "account-route");
  const sameSupplier = transitionXCursor({ lastTweetId: "1980", initializedAt: "2026-10-01T00:00:00Z" }, oldConfig,
    { ...oldConfig, query: "from:other -filter:replies" }, now);
  assert.equal(sameSupplier.cursor!.lastTweetId, undefined);
  assert.equal(sameSupplier.cursor!.initializedAt, undefined);
  const bootstrap = transitionXCursor({ lastTweetId: "1980", initializedAt: "2026-10-01T00:00:00Z" },
    { ...oldConfig, _aihot: { initialBackfillLimit: 2 } }, { ...birdConfig, _aihot: { initialBackfillLimit: 20 } }, now);
  assert.equal(bootstrap.change, "provider-only");
  assert.equal(bootstrap.cursor!.lastTweetId, "1980");
  assert.equal(bootstrap.cursor!.initializedAt, "2026-10-01T00:00:00Z");
});

test("legacy provider is bound by exact receipts, otherwise by a coherent source route timeline", () => {
  const at = new Date("2026-10-02T00:00:00Z");
  const initial = { ...oldConfig, provider: "socialdata" };
  const audit = [{ created_at: "2026-10-03T00:00:00Z", before: { config: initial }, after: { config: oldConfig } }];
  assert.equal(historicXProvider(oldConfig, at, audit, []), "socialdata");
  assert.equal(historicXProvider(oldConfig, new Date("2026-10-04T00:00:00Z"), audit, []), "xquik");
  assert.equal(historicXProvider(oldConfig, at, audit, ["xquik"]), "xquik");
  assert.equal(historicXProvider(oldConfig, at, audit, ["socialdata", "xquik"]), "unknown");
  assert.equal(historicXProvider(birdConfig, at, audit, []), "unknown", "missing intermediate route must not turn into a paid fallback");
  assert.equal(historicXProvider(oldConfig, at, [{ created_at: "2026-10-03T00:00:00Z", before: null, after: { config: oldConfig } }], []), "unknown");
  assert.equal(historicXProvider({ query: "from:scope -filter:replies" }, at, [], []), "socialdata", "the original implicit route is documented");
});
