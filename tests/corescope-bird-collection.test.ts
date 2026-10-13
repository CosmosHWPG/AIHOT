// Throwaway PostgreSQL and a local fake CLI only; no real session, X or model call.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource, adaptIntervals, scheduleDueSources } from "@aihot/backend/sources/collect";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { birdCredentialFingerprint } from "@aihot/backend/providers/bird-runtime";

const T = tag();
const handle = `bd${T.slice(-10)}`;
const sourceId = `test-bird-${T}`;
const profile = `offline-bird-${T}`;
const root = mkdtempSync(path.join(tmpdir(), "corescope-bird-collection-"));
const fixtureFile = path.join(root, "fixture.json");
const startedFile = path.join(root, "started.json");
const names = ["BIRD_ENABLED", "BIRD_CLI_PATH", "BIRD_NODE_PATH", "BIRD_CREDENTIAL_MODE", "BIRD_ACCOUNT_PROFILE", "BIRD_AUTH_TOKEN", "BIRD_CT0", "BIRD_CLI_SHA256", "BIRD_EXPECTED_USER_ID", "BIRD_EXPECTED_USERNAME", "COLLECT_KINDS"];
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
const sourceConfig = { provider: "bird", query: `from:${handle} -filter:replies`, searchType: "Latest",
  bird: { accountProfile: profile, strategy: "user_tweets", initialLookbackHours: 48, maxPagesPerRound: 1 }, _aihot: { initialBackfillLimit: 20 } };
let budget: Array<{ per_minute: number; per_hour: number; per_day: number; note: string | null }> = [];
let sequence = 0;
const id = () => String((BigInt(Date.now() - 1288834974657) << 22n) + BigInt(++sequence));
const raw = (tweetId = id()) => ({ id: tweetId, createdAt: new Date(Date.now() - 60_000).toISOString(), text: `Original evidence ${T}`,
  author: { username: handle, name: "Offline Author" }, authorId: "991122" });
function fixture(data: Record<string, unknown>) { writeFileSync(fixtureFile, JSON.stringify(data)); }
const cursor = async () => (await sql<{ cursor: Record<string, any> | null }[]>`SELECT cursor FROM sources WHERE id=${sourceId}`)[0]!.cursor;

before(async () => {
  mkdirSync(path.join(root, "dist"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@steipete/bird", version: "0.8.0", type: "module" }));
  writeFileSync(path.join(root, "dist/cli.js"), `import {readFileSync,writeFileSync} from 'node:fs';
const data=JSON.parse(readFileSync(new URL('../fixture.json',import.meta.url),'utf8'));
const command=process.argv.slice(2)[4];
if(data.delayMs){writeFileSync(new URL('../started.json',import.meta.url),'started');await new Promise(r=>setTimeout(r,data.delayMs));}
if(command==='user-tweets')process.stdout.write(JSON.stringify(data.timeline));
else if(command==='read')process.stdout.write(JSON.stringify(data.read));
else {process.stderr.write('offline unsupported command');process.exit(1);}`);
  Object.assign(process.env, { BIRD_ENABLED: "true", BIRD_CLI_PATH: path.join(root, "dist/cli.js"), BIRD_NODE_PATH: process.execPath,
    BIRD_CREDENTIAL_MODE: "process-env", BIRD_ACCOUNT_PROFILE: profile, BIRD_AUTH_TOKEN: "offline_cookie", BIRD_CT0: "offline_csrf" });
  delete process.env.BIRD_CLI_SHA256; delete process.env.BIRD_EXPECTED_USER_ID; delete process.env.BIRD_EXPECTED_USERNAME;
  budget = await sql`SELECT per_minute,per_hour,per_day,note FROM budgets WHERE service='bird'`;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('bird',10000,10000,10000)
    ON CONFLICT(service) DO UPDATE SET per_minute=10000,per_hour=10000,per_day=10000`;
  await sql`INSERT INTO bird_profile_gate(profile,verified_user_id,verified_username,credential_fingerprint,verified_at)
    VALUES(${profile},'991122','offline',${birdCredentialFingerprint({ authToken: "offline_cookie", ct0: "offline_csrf" })},now())`;
  await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,enabled,interval_minutes,next_fetch_at)
    VALUES(${sourceId},'Offline Bird','x_search',${sql.json(sourceConfig)},'T1','editorial',true,120,'2100-01-01')`;
});
beforeEach(async () => {
  if (existsSync(startedFile)) rmSync(startedFile);
  await sql`DELETE FROM receipts WHERE service='bird' AND subject LIKE ${`%${T}%`}`;
  await sql`DELETE FROM pgboss.job WHERE name='sources.fetch' AND data->>'sourceId'=${sourceId}`;
  await sql`UPDATE bird_profile_gate SET cooldown_until=NULL,lease_until=NULL,lease_owner=NULL WHERE profile=${profile}`;
  await sql`UPDATE sources SET config=${sql.json(sourceConfig)},cursor=NULL,enabled=true,health='unknown',fail_count=0,interval_minutes=120,next_fetch_at='2100-01-01' WHERE id=${sourceId}`;
  fixture({ timeline: { tweets: [raw()], nextCursor: null } });
});
after(async () => {
  const previous = budget[0];
  if (previous) await sql`UPDATE budgets SET per_minute=${previous.per_minute},per_hour=${previous.per_hour},per_day=${previous.per_day},note=${previous.note} WHERE service='bird'`;
  else await sql`DELETE FROM budgets WHERE service='bird'`;
  await sql`DELETE FROM bird_profile_gate WHERE profile=${profile}`;
  await sql`UPDATE sources SET enabled=false WHERE id=${sourceId}`;
  for (const name of names) { if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; }
  await stopBoss(); await closeDb();
  // The only recursive target is the exact OS-created private fixture directory.
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  rmSync(root, { recursive: true, force: true });
});

test("Bird collection commits all confirmed first-page materials, coverage and completed receipt together", async () => {
  const tweets = Array.from({ length: 20 }, () => raw()); fixture({ timeline: { tweets, nextCursor: "older-page" } });
  const result = await collectSource(sourceId);
  assert.equal(result.status, "ok"); assert.equal(result.created, 20);
  const state = (await cursor())!;
  assert.ok(state.initializedAt); assert.equal(state.bird.coverage, "partial"); assert.equal(state.bird.backlog[0].next, "older-page");
  const [receipt] = await sql`SELECT status,cost FROM receipts WHERE service='bird' AND subject=${`source:${sourceId}`}`;
  assert.equal(receipt!.status, "completed"); assert.equal(receipt!.cost, null);
  const stored = await sql`SELECT x_post,identity_key,backfill FROM articles WHERE identity_key IN ${sql(tweets.map(t => `x:${t.id}`))}`;
  assert.equal(stored.length, 20); assert.ok(stored.every(a => a.x_post.provider === "bird" && a.backfill));
});

test("a replay reuses the CLI receipt and neither duplicates nor invents a revision", async () => {
  const first = await collectSource(sourceId); const second = await collectSource(sourceId);
  assert.equal(first.created, 1); assert.equal(second.status, "ok"); assert.equal(second.created, 0); assert.equal(second.revised, 0);
  const attempts = await sql`SELECT id FROM receipt_attempts WHERE service='bird' AND receipt_id IN
    (SELECT id FROM receipts WHERE subject=${`source:${sourceId}`})`;
  assert.equal(attempts.length, 1);
});

test("a Bird-specific operation cannot switch to a paid provider while waiting for capacity", async () => {
  // The operator had already reviewed a Bird route; the source changes before collectSource loads
  // its authoritative snapshot, as can happen during the CLI's minute-budget wait.
  const moved = { provider: "xquik", query: sourceConfig.query, searchType: "Latest" };
  const oldCursor = { lastTweetId: "111", initializedAt: "2026-10-01T00:00:00Z" };
  await sql`UPDATE sources SET config=${sql.json(moved)},cursor=${sql.json(oldCursor)},health='degraded',fail_count=3 WHERE id=${sourceId}`;
  const [before] = await sql`SELECT updated_at,next_fetch_at FROM sources WHERE id=${sourceId}`;
  const runCount = (await sql`SELECT count(*)::int AS n FROM fetch_runs WHERE source_id=${sourceId}`)[0]!.n;
  const receiptCount = (await sql`SELECT count(*)::int AS n FROM receipts WHERE subject=${`source:${sourceId}`}`)[0]!.n;
  const result = await collectSource(sourceId, { force: true, expectedProvider: "bird" });
  assert.equal(result.status, "skipped"); assert.equal(result.error, "provider_changed");
  assert.equal((await sql`SELECT count(*)::int AS n FROM fetch_runs WHERE source_id=${sourceId}`)[0]!.n, runCount);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE subject=${`source:${sourceId}`}`)[0]!.n, receiptCount);
  const [after] = await sql`SELECT health,fail_count,cursor,updated_at,next_fetch_at FROM sources WHERE id=${sourceId}`;
  assert.equal(after!.health, "degraded"); assert.equal(after!.fail_count, 3); assert.deepEqual(after!.cursor, oldCursor);
  assert.equal(after!.updated_at.getTime(), before!.updated_at.getTime());
  assert.equal(after!.next_fetch_at.getTime(), before!.next_fetch_at.getTime());
});

test("a changed source route cannot acknowledge an old in-flight Bird page or overwrite its cursor", async () => {
  const t = raw(); fixture({ timeline: { tweets: [t], nextCursor: null }, delayMs: 700 });
  const running = collectSource(sourceId);
  for (let i = 0; i < 60 && !existsSync(startedFile); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(existsSync(startedFile));
  const moved = { provider: "xquik", query: sourceConfig.query, searchType: "Latest" };
  await sql`UPDATE sources SET config=${sql.json(moved)},cursor=${sql.json({ lastTweetId: "111", initializedAt: "2026-10-01T00:00:00Z" })} WHERE id=${sourceId}`;
  const result = await running;
  assert.equal(result.status, "skipped"); assert.equal((await cursor())!.lastTweetId, "111");
  assert.equal((await sql`SELECT id FROM articles WHERE identity_key=${`x:${t.id}`}`).length, 0);
  assert.equal((await sql`SELECT status FROM receipts WHERE service='bird' AND subject=${`source:${sourceId}`}`)[0]!.status, "received");
});

test("a failed Bird material write rolls back queue, cursor and receipt acknowledgment", async () => {
  const t = raw(); fixture({ timeline: { tweets: [t], nextCursor: null } });
  const functionName = `test_bird_reject_${T}`; const triggerName = `test_bird_trigger_${T}`;
  await sql.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_id='${sourceId}' THEN RAISE EXCEPTION 'offline material failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON articles FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  try {
    const result = await collectSource(sourceId);
    assert.equal(result.status, "failed"); assert.equal(await cursor(), null);
    assert.equal((await sql`SELECT id FROM articles WHERE identity_key=${`x:${t.id}`}`).length, 0);
    assert.equal((await sql`SELECT status FROM receipts WHERE service='bird' AND subject=${`source:${sourceId}`}`)[0]!.status, "received");
  } finally {
    await sql.unsafe(`DROP TRIGGER ${triggerName} ON articles`); await sql.unsafe(`DROP FUNCTION ${functionName}()`);
  }
});

test("metadata-only Article follows Bird read, confirms body and receipt without a paid fallback", async () => {
  const t = raw();
  fixture({ timeline: { tweets: [{ ...t, text: "Article preview", article: { title: "Confirmed article", previewText: "Preview only" } }], nextCursor: null },
    read: { ...t, text: "Confirmed article\n\nOriginal complete Article body", article: { title: "Confirmed article", previewText: "Preview only" },
      _raw: { article: { article_results: { result: { title: "Confirmed article", content_state: {
        blocks: [{ type: "unstyled", text: "Original complete Article body" }],
      } } } } } } });
  assert.equal((await collectSource(sourceId)).status, "ok");
  const [a] = await sql`SELECT id,body_status FROM articles WHERE identity_key=${`x:${t.id}`}`;
  assert.equal(a!.body_status, "pending"); assert.equal(await extractArticleBody(a!.id), "ok");
  const [body] = await sql`SELECT title,x_article,x_post FROM articles WHERE id=${a!.id}`;
  assert.equal(body!.title, "Confirmed article"); assert.equal(body!.x_post.bird.bodyLevel, "full");
  assert.equal(body!.x_article.provider, "bird"); assert.match(body!.x_article.text, /Original complete/);
  const [receipt] = await sql`SELECT status,service FROM receipts WHERE id=${body!.x_article.receiptId}`;
  assert.equal(receipt!.service, "bird"); assert.equal(receipt!.status, "completed");
});

test("an Article read containing only commentary and a link remains unconfirmed and acknowledges its non-full result", async () => {
  const t = raw(); const article = { title: "Unconfirmed Article", previewText: "Preview only" };
  fixture({ timeline: { tweets: [{ ...t, text: "Article preview", article }], nextCursor: null },
    read: { ...t, text: "My commentary about the article https://x.com/i/article/888", article } });
  assert.equal((await collectSource(sourceId)).status, "ok");
  const [a] = await sql`SELECT id FROM articles WHERE identity_key=${`x:${t.id}`}`;
  assert.equal(await extractArticleBody(a!.id), "unconfirmed");
  const [body] = await sql`SELECT body_status,x_article,x_post FROM articles WHERE id=${a!.id}`;
  assert.equal(body!.body_status, "unconfirmed"); assert.equal(body!.x_article, null); assert.equal(body!.x_post.bird.bodyLevel, "preview");
  const [receipt] = await sql`SELECT status FROM receipts WHERE service='bird' AND subject=${`article:${a!.id}`}`;
  assert.equal(receipt!.status, "completed");
});

test("legacy providerless material is unconfirmed without consulting the source's new Bird route", async () => {
  const tweetId = id();
  const old = await upsertMaterial({ sourceId, url: `https://x.com/${handle}/status/${tweetId}`, title: "Legacy Article", via: "fetch", bodyStatus: "pending",
    bodyText: "https://x.com/i/article/777", xPost: { tweetId, handle, authorName: handle, text: "https://x.com/i/article/777" } });
  assert.equal(await extractArticleBody(old.articleId), "unconfirmed");
  assert.equal((await sql`SELECT id FROM receipts WHERE service='bird' AND subject=${`article:${old.articleId}`}`).length, 0);
});

test("Bird sources keep their explicit polling plan and schedule through the ordinary fetch queue", async () => {
  await sql`UPDATE sources SET cursor=${sql.json({ lastTweetId: id(), initializedAt: new Date().toISOString() })},next_fetch_at=NULL,interval_minutes=180 WHERE id=${sourceId}`;
  await adaptIntervals();
  assert.equal((await sql`SELECT interval_minutes FROM sources WHERE id=${sourceId}`)[0]!.interval_minutes, 180);
  process.env.COLLECT_KINDS = "x_search"; await scheduleDueSources(10000);
  const direct = await sql`SELECT id FROM pgboss.job WHERE name='sources.fetch' AND data->>'sourceId'=${sourceId}`;
  assert.ok(direct.length > 0);
  const sharded = await sql`SELECT id FROM pgboss.job WHERE name='sources.fetch-x' AND data->'sourceIds' ? ${sourceId}`;
  assert.equal(sharded.length, 0);
});

test("Bird scheduler queues one oldest successful author and defers remaining due authors without failed runs", async () => {
  const extra = [`${sourceId}-old`, `${sourceId}-recent`]; const all = [sourceId, ...extra];
  for (const [index, source] of extra.entries()) await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,enabled,interval_minutes,next_fetch_at,last_ok_at)
    VALUES(${source},'Offline fair queue','x_search',${sql.json({ ...sourceConfig, query: `from:${handle}${index} -filter:replies` })},
      'T1','editorial',true,1440,NULL,${index === 0 ? null : new Date()})`;
  await sql`UPDATE sources SET next_fetch_at=NULL,last_ok_at=now()-interval '1 hour' WHERE id=${sourceId}`;
  process.env.COLLECT_KINDS = 'x_search';
  const before = (await sql`SELECT count(*)::int AS n FROM fetch_runs WHERE source_id IN ${sql(all)}`)[0]!.n;
  try {
    await scheduleDueSources(10000); await scheduleDueSources(10000);
    let jobs = await sql`SELECT data FROM pgboss.job WHERE name='sources.fetch' AND data->>'sourceId' IN ${sql(all)}`;
    assert.equal(jobs.length, 1); assert.equal(jobs[0]!.data.sourceId, extra[0]);
    await sql`DELETE FROM pgboss.job WHERE name='sources.fetch' AND data->>'sourceId'=${extra[0]!}`;
    await sql`UPDATE sources SET last_ok_at=now(),next_fetch_at='2100-01-01' WHERE id=${extra[0]!}`;
    await scheduleDueSources(10000);
    jobs = await sql`SELECT data FROM pgboss.job WHERE name='sources.fetch' AND data->>'sourceId' IN ${sql(all)}`;
    assert.equal(jobs.length, 1); assert.equal(jobs[0]!.data.sourceId, sourceId);
    assert.equal((await sql`SELECT count(*)::int AS n FROM fetch_runs WHERE source_id IN ${sql(all)}`)[0]!.n, before);
  } finally {
    await sql`DELETE FROM pgboss.job WHERE name='sources.fetch' AND data->>'sourceId' IN ${sql(all)}`;
    await sql`UPDATE sources SET enabled=false WHERE id IN ${sql(extra)}`;
  }
});

test("known local budget and profile deferrals do not enqueue work or damage source health", async () => {
  process.env.COLLECT_KINDS = 'x_search';
  await sql`UPDATE sources SET next_fetch_at=NULL WHERE id=${sourceId}`;
  const before = (await sql`SELECT count(*)::int AS n FROM fetch_runs WHERE source_id=${sourceId}`)[0]!.n;
  await sql`UPDATE budgets SET per_minute=0 WHERE service='bird'`;
  try {
    await scheduleDueSources(10000);
    assert.equal((await sql`SELECT id FROM pgboss.job WHERE name='sources.fetch' AND data->>'sourceId'=${sourceId}`).length, 0);
    assert.equal((await sql`SELECT count(*)::int AS n FROM fetch_runs WHERE source_id=${sourceId}`)[0]!.n, before);
  } finally { await sql`UPDATE budgets SET per_minute=10000 WHERE service='bird'`; }
  await sql`UPDATE bird_profile_gate SET cooldown_until=now()+interval '1 hour' WHERE profile=${profile}`;
  await scheduleDueSources(10000);
  assert.equal((await sql`SELECT id FROM pgboss.job WHERE name='sources.fetch' AND data->>'sourceId'=${sourceId}`).length, 0);
  assert.equal((await collectSource(sourceId)).status, 'skipped');
  const [latest] = await sql`SELECT status,detail FROM fetch_runs WHERE source_id=${sourceId} ORDER BY id DESC LIMIT 1`;
  assert.equal(latest!.status, 'skipped'); assert.equal(latest!.detail.deferred, true);
  const [health] = await sql`SELECT fail_count,health FROM sources WHERE id=${sourceId}`;
  assert.equal(health!.fail_count, 0); assert.equal(health!.health, 'unknown');
});
