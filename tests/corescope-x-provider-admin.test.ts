// Throwaway PostgreSQL only. No collector, CLI, credential, X API or model is called.
import "./setup.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { sql, closeDb } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { createSource, sourceDetail, updateSource } from "@aihot/backend/admin/sources";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { tag } from "./setup.ts";

const T = tag();
const cursor = { lastTweetId: "1980000000000000000", initializedAt: "2026-10-01T00:00:00Z", lastOkAt: "2026-10-12T00:00:00Z",
  xBacklog: [{ query: "from:scope since_id:1970", next: "opaque-previous-supplier" }] };
let counter = 0;
after(async () => { await stopBoss(); await closeDb(); });
async function source(label: string, provider: string | undefined = undefined) {
  const id = `test-x-switch-${label}-${T}`;
  const config = { query: `from:s${++counter}${T.slice(-6)} -filter:replies`, searchType: "Latest", _aihot: { initialBackfillLimit: 2 }, ...(provider ? { provider } : {}) };
  await sql`INSERT INTO sources (id,name,kind,config,cursor,last_ok_at,fail_count,last_error,next_fetch_at)
    VALUES (${id},'X route fixture','x_search',${sql.json(config)},${sql.json(cursor)},now()-interval '1 day',2,'Old provider failed',now()+interval '1 day')`;
  return { id, config };
}
const stored = async (id: string) => (await sql`SELECT * FROM sources WHERE id=${id}`)[0]!;
async function change(id: string, config: Record<string, unknown>, actor = "test-x-switch") {
  const before = await stored(id);
  return updateSource(id, { patch: { config }, version: before.updated_at.toISOString(), reason: "Offline supplier route test" }, actor);
}
async function material(sourceId: string, provider?: "xquik" | "bird", discoveredAt = new Date()) {
  const tweetId = `${Date.now()}${++counter}000`;
  return (await upsertMaterial({ sourceId, url: `https://x.com/scope/status/${tweetId}`, title: "Original X evidence", bodyText: "Source evidence body",
    bodyStatus: "ok", via: "fetch", discoveredAt, xPost: { tweetId, authorName: "Scope", handle: "scope", text: "Original X evidence", ...(provider ? { provider } : {}) } })).articleId;
}
async function receipt(articleId: string, service: string) {
  await sql`INSERT INTO receipts (logical_key,service,purpose,subject,status,response)
    VALUES (${`x-switch-${T}-${articleId}-${service}`},${service},'x_article',${`article:${articleId}`},'completed','{}')`;
}
const bird = (config: Record<string, unknown>) => ({ ...config, provider: "bird", bird: { accountProfile: `test-${T}`, strategy: "user_tweets", maxPagesPerRound: 1 },
  _aihot: { initialBackfillLimit: 20 } });

test("admin supplier switch is atomic, retains ID/watermarks/material and binds exact historical provider evidence", async () => {
  const s = await source("position");
  const old = await material(s.id);
  const exact = await material(s.id);
  const conflicting = await material(s.id);
  const alreadyTagged = await material(s.id, "xquik");
  await receipt(exact, "xquik");
  await receipt(conflicting, "socialdata");
  await receipt(conflicting, "xquik");
  const before = await stored(s.id);
  const beforeMaterial = (await sql`SELECT * FROM articles WHERE id=${old}`)[0]!;
  const result = await change(s.id, bird(s.config));
  assert.equal(result!.id, s.id);
  const after = await stored(s.id);
  assert.equal(after.cursor.lastTweetId, cursor.lastTweetId);
  assert.equal(after.cursor.initializedAt, cursor.initializedAt);
  assert.equal(after.cursor.xBacklog, undefined);
  assert.deepEqual(after.cursor.bird.backlog, []);
  assert.equal(after.cursor.bird.coverage, "partial");
  assert.equal(after.cursor.xRouteHistory[0].backlog[0].next, cursor.xBacklog[0]!.next);
  assert.equal(after.last_ok_at.getTime(), before.last_ok_at.getTime());
  assert.deepEqual([after.fail_count, after.last_error, after.health], [0, null, "unknown"]);
  assert.ok(after.next_fetch_at.getTime() <= Date.now());
  for (const [id, expected] of [[old, "socialdata"], [exact, "xquik"], [conflicting, "unknown"], [alreadyTagged, "xquik"]]) {
    const [row] = await sql`SELECT x_post FROM articles WHERE id=${id!}`;
    assert.equal(row!.x_post.provider, expected);
  }
  const afterMaterial = (await sql`SELECT * FROM articles WHERE id=${old}`)[0]!;
  assert.deepEqual({ ...afterMaterial, x_post: beforeMaterial.x_post }, beforeMaterial, "only historical routing metadata changes; content/revision/date stay intact");
  const [entry] = await sql`SELECT after FROM audit_log WHERE subject=${`source:${s.id}`} AND action='source.x-provider-switch'`;
  assert.deepEqual(entry!.after.historicProviders, { socialdata: 1, xquik: 1, bird: 0, unknown: 1 });
  const again = await change(s.id, bird(s.config));
  assert.equal(again!.cursor.xRouteHistory.length, 1, "saving the same route must not create another switch");
  await assert.rejects(updateSource(s.id, { patch: { config: s.config }, version: before.updated_at.toISOString() }, "test"), /信源已被其他操作修改/);
});

test("source route history and opaque automatic rewrites cannot silently reattribute legacy posts to a paid supplier", async () => {
  const s = await source("history", "xquik");
  const discoveredAt = new Date("2026-10-01T00:00:00Z");
  const articleId = await material(s.id, undefined, discoveredAt);
  await audit("test", "source.update", `source:${s.id}`, "Historical provider change", { config: { ...s.config, provider: "socialdata" } }, { config: s.config });
  await change(s.id, bird(s.config));
  assert.equal((await sql`SELECT x_post FROM articles WHERE id=${articleId}`)[0]!.x_post.provider, "socialdata");
  const opaque = await source("opaque", "xquik");
  const unknown = await material(opaque.id);
  await audit("system:corescope-source-upgrade", "source.route-upgrade", `source:${opaque.id}`, null,
    { configHash: "old-route-hash" }, { configHash: "new-route-hash", changedFields: ["config"] });
  await change(opaque.id, bird(opaque.config));
  assert.equal((await sql`SELECT x_post FROM articles WHERE id=${unknown}`)[0]!.x_post.provider, "unknown");
});

test("failed switch audit rolls source, cursor, historical bindings and route audit back together", async () => {
  const s = await source("rollback", "xquik");
  const id = await material(s.id);
  const before = await stored(s.id);
  const beforeArticle = (await sql`SELECT * FROM articles WHERE id=${id}`)[0];
  const fn = `test_x_switch_${T}`;
  await sql.unsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.actor='test-reject-x-switch' AND NEW.action='source.x-provider-switch' THEN RAISE EXCEPTION 'fixture rejected route audit'; END IF;
    RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try { await assert.rejects(change(s.id, bird(s.config), "test-reject-x-switch"), /fixture rejected route audit/); }
  finally { await sql.unsafe(`DROP TRIGGER ${fn} ON audit_log`); await sql.unsafe(`DROP FUNCTION ${fn}()`); }
  assert.deepEqual(await stored(s.id), before);
  assert.deepEqual((await sql`SELECT * FROM articles WHERE id=${id}`)[0], beforeArticle);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE actor='test-reject-x-switch' AND subject=${`source:${s.id}`}`).length, 0);
});

test("Bird admin state exposes local coverage and current supplier success without credentials or login identity", async () => {
  const enabledBefore = process.env.BIRD_ENABLED;
  process.env.BIRD_ENABLED = "true"; // Only a local state read; no provider operation is invoked.
  const s = await source("status");
  await change(s.id, bird(s.config));
  await sql`INSERT INTO bird_profile_gate (profile,verified_at,verified_user_id,verified_username,credential_fingerprint,cooldown_until)
    VALUES (${`test-${T}`},now(),'private-login-id','private-login-handle','private-session-fingerprint',now()+interval '1 hour')`;
  try {
    await sql`INSERT INTO fetch_runs (source_id,status,finished_at,detail) VALUES (${s.id},'ok',now(),'{"provider":"socialdata"}')`;
    let detail = await sourceDetail(s.id);
    assert.equal(detail!.x!.lastSuccessAt, null, "old supplier success is not a Bird success");
    assert.equal(detail!.x!.profile!.state, "cooldown");
    assert.equal(detail!.x!.coverage, "partial");
    const json = JSON.stringify(detail);
    for (const secret of ["private-login-id", "private-login-handle", "private-session-fingerprint"]) assert.ok(!json.includes(secret));
    await sql`INSERT INTO fetch_runs (source_id,status,finished_at,detail) VALUES (${s.id},'ok',now(),'{"provider":"bird","coverage":"partial"}')`;
    detail = await sourceDetail(s.id);
    assert.ok(detail!.x!.lastSuccessAt);
    await assert.rejects(change(s.id, { ...bird(s.config), bird: { authToken: "never-store-session-secret" } }), /不支持的配置项/);
    assert.ok(!JSON.stringify(await stored(s.id)).includes("never-store-session-secret"));
    process.env.BIRD_ENABLED = "false";
    assert.equal((await sourceDetail(s.id))!.x!.profile!.state, "disabled");
  } finally {
    if (enabledBefore === undefined) delete process.env.BIRD_ENABLED; else process.env.BIRD_ENABLED = enabledBefore;
    await sql`DELETE FROM bird_profile_gate WHERE profile=${`test-${T}`}`;
  }
});

test("X providers remain one source identity so switching cannot clone the same account", async () => {
  const s = await source("duplicate");
  const result = await createSource({ id: `test-x-clone-${T}`, name: "Should not clone", kind: "x_search",
    config: { ...bird(s.config), query: s.config.query.replace("from:", "FROM:").toUpperCase().replace("-FILTER:REPLIES", "-filter:replies") } }, "test");
  assert.equal(result.created, false);
  assert.equal(result.created ? null : result.duplicate.id, s.id);
});
