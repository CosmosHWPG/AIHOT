// Offline source semantics: the reader is injected and never launches Bird or calls X.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import type { BirdTweet } from "@aihot/backend/providers/bird";
import { fetchBirdTimeline, planXBootstrap, planXShards, readXSearch, shardHandle, tweetToCandidate } from "@aihot/backend/sources/x";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";

const now = Date.parse("2026-10-13T08:00:00Z");
const idAt = (date: number) => String(BigInt(date - 1288834974657) << 22n);
const tweet = (ageHours: number, handle = "OpenAI", extra: Partial<BirdTweet> = {}): BirdTweet => ({
  id_str: idAt(now - ageHours * 3_600_000), tweet_created_at: new Date(now - ageHours * 3_600_000).toISOString(),
  full_text: "Original evidence", user: { screen_name: handle, name: handle },
  birdContent: { kind: "tweet", bodyLevel: "full", authorId: "42" }, ...extra,
});
const source = (patch: Partial<SourceRow> = {}): SourceRow => ({
  id: "test-bird-openai", name: "OpenAI", kind: "x_search", enabled: true, tier: "T1", first_party: true,
  participation_mode: "editorial", interval_minutes: 120, fail_count: 0, cursor: null,
  config: { provider: "bird", query: "from:OpenAI -filter:replies", searchType: "Latest", bird: { accountProfile: "birdclaw-primary", maxPagesPerRound: 1 } },
  ...patch,
});
const page = (tweets: BirdTweet[], nextCursor: string | null, receiptId = 1) => ({ tweets, nextCursor, receiptId, reused: false });

after(closeDb);

test("Bird account timelines never join paid shards or paid search dispatch", async () => {
  const bird = source({ cursor: { lastTweetId: idAt(now - 3_600_000) } });
  assert.equal(shardHandle(bird), null);
  assert.deepEqual(planXShards([bird]), []);
  assert.deepEqual(planXBootstrap([bird]), []);
  await assert.rejects(readXSearch("from:OpenAI", { provider: "bird", lastId: null, backlog: [], subject: "offline" }), /cannot use paid OR/);
});

test("first Bird import is one bounded page and only original target posts advance the watermark", async () => {
  const calls: Array<string | null | undefined> = [];
  const own = tweet(1);
  const result = await fetchBirdTimeline(source({ config: { ...source().config, bird: { maxPagesPerRound: 5 } } }), async (_handle, opts) => {
    calls.push(opts.cursor);
    return page([own, tweet(0, "SomeoneElse"), tweet(0.1, "OpenAI", { in_reply_to_status_id_str: "123" }),
      tweet(72, "OpenAI", { birdContent: { kind: "tweet", bodyLevel: "full", pinned: true } })], "older");
  }, now);
  assert.deepEqual(calls, [null]);
  assert.equal(result.pages, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.lastId, own.id_str);
  assert.equal(result.birdCursor!.coverage, "partial");
  assert.equal(result.birdCursor!.backlog[0]!.next, "older");
  assert.equal(result.nextFetchMinutes, 5);
});

test("backlog resumes separately; new polling starts at the timeline top after the planned interval", async () => {
  const first = await fetchBirdTimeline(source(), async () => page([tweet(1)], "older"), now);
  const s = source({ cursor: { initializedAt: new Date(now).toISOString(), lastTweetId: first.lastId, bird: first.birdCursor } });
  const calls: Array<string | null | undefined> = [];
  const complete = await fetchBirdTimeline(s, async (_handle, opts) => {
    calls.push(opts.cursor);
    return page([tweet(2), tweet(49)], "unneeded");
  }, now + 5 * 60_000);
  assert.deepEqual(calls, ["older"]);
  assert.equal(complete.birdCursor!.backlog.length, 0);
  assert.equal(complete.birdCursor!.coverage, "complete");
  assert.equal(complete.lastId, first.lastId);
  const newCalls: Array<string | null | undefined> = [];
  await fetchBirdTimeline(s, async (_handle, opts) => { newCalls.push(opts.cursor); return page([tweet(0)], "fresh-next"); }, now + 2 * 3_600_000);
  assert.deepEqual(newCalls, [null]);
});

test("a failed later CLI page preserves successful candidates, receipts and its resume position", async () => {
  let calls = 0;
  const s = source({ cursor: { initializedAt: new Date(now - 3_600_000).toISOString() }, config: { ...source().config, bird: { maxPagesPerRound: 3 } } });
  const result = await fetchBirdTimeline(s, async (_handle, opts) => {
    calls += 1;
    if (opts.cursor) throw new Error("offline page failure");
    return page([tweet(1)], "second", 81);
  }, now);
  assert.equal(calls, 2);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.receiptIds, [81]);
  assert.equal(result.birdCursor!.backlog[0]!.next, "second");
  assert.equal(result.birdCursor!.gap!.reason, "later_page_failed");
});

test("missing cursor and empty responses record uncertainty rather than fabricated coverage", async () => {
  const empty = await fetchBirdTimeline(source(), async () => page([], null), now);
  assert.equal(empty.lastId, null);
  assert.equal(empty.birdCursor!.coverage, "unknown");
  assert.equal(empty.birdCursor!.gap!.reason, "empty_page_without_cursor");
  const one = await fetchBirdTimeline(source(), async () => page([tweet(1)], null), now);
  assert.equal(one.birdCursor!.coverage, "unknown");
  assert.equal(one.birdCursor!.gap!.reason, "cli_cursor_missing");
});

test("id-only reposts and an unmarked old pin cannot create original material or stop recent pagination", async () => {
  const result = await fetchBirdTimeline(source(), async () => page([
    tweet(72), tweet(1), tweet(0, "OpenAI", { birdContent: { kind: "tweet", bodyLevel: "full", isRepost: true, repostedTweetId: "123" } }),
  ], "older"), now);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.birdCursor!.coverage, "partial");
  assert.equal(result.birdCursor!.backlog[0]!.next, "older");
});

test("Article metadata without an article URL waits for confirmed body and preserves its private profile reference", () => {
  const article = tweet(1, "OpenAI", { full_text: "An article preview without a URL", birdContent: {
    kind: "article", bodyLevel: "preview", articleTitle: "Long article", articleId: "888", authorId: "42",
  } });
  const candidate = tweetToCandidate(article, "bird", "birdclaw-primary");
  assert.equal(candidate.bodyStatus, "pending");
  assert.equal(candidate.xPost!.provider, "bird");
  assert.equal(candidate.xPost!.bird!.articleId, "888");
  assert.equal(candidate.xPost!.bird!.accountProfile, "birdclaw-primary");
  assert.equal(tweetToCandidate(tweet(1), "socialdata").xPost!.provider, "socialdata");
});

test("provider-switch gaps survive successful posts until the missing range is demonstrably covered", async () => {
  const oldGap = { from: new Date(now - 3_600_000).toISOString(), to: new Date(now).toISOString(), reason: "provider_switch_backlog" };
  const s = source({ cursor: { initializedAt: new Date(now).toISOString(), bird: { gap: oldGap } } });
  const result = await fetchBirdTimeline(s, async () => page([tweet(1), tweet(49)], null), now);
  assert.deepEqual(result.birdCursor!.gap, oldGap);
  assert.equal(result.birdCursor!.coverage, "partial");
});

test("a long outage records the portion outside the bounded lookback and never claims it was recovered", async () => {
  const lastOkAt = new Date(now - 72 * 3_600_000).toISOString();
  const result = await fetchBirdTimeline(source({ cursor: { lastOkAt, initializedAt: lastOkAt } }), async () => page([tweet(1), tweet(49)], null), now);
  assert.equal(result.birdCursor!.coverage, "partial");
  assert.deepEqual(result.birdCursor!.gap, { from: lastOkAt, to: new Date(now - 48 * 3_600_000).toISOString(), reason: "lookback_limit" });
});

test("Bird configuration refuses unsupported search strategies, embedded secrets and invalid capacities", () => {
  assertSupportedConfig("x_search", source().config);
  for (const bird of [{ strategy: "search" }, { authToken: "test-placeholder" }, { maxPagesPerRound: 0 }, { initialLookbackHours: 72 }, { accountProfile: "bad profile" }]) {
    assert.throws(() => assertSupportedConfig("x_search", { ...source().config, bird }), /不支持的配置项/);
  }
  assert.throws(() => assertSupportedConfig("x_search", { ...source().config, query: "(from:OpenAI OR from:other) -filter:replies" }), /bird.query/);
});
