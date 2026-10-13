import "./setup.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle, republishSource } from "@aihot/backend/publication/publish";
import { listedCondition } from "@aihot/backend/publication/scope";
import { updateSource } from "@aihot/backend/admin/sources";
import { upgradeSources, managedKey, UPGRADE_ACTOR, type UpgradeSource, type SourceProfileManifest } from "../scripts/corescope-source-upgrade.ts";
import { tag } from "./setup.ts";

const T = tag();
const BODY = `Original technical evidence ${T} `.repeat(30);
const OLD_CURSOR = { initializedAt: "2026-10-01T00:00:00Z", rss: { etag: "old-validator" }, lastOkAt: "2026-10-01T00:00:00Z" };
after(async () => { await stopBoss(); await closeDb(); });

async function source(label: string, changes: Partial<UpgradeSource> & { health?: string } = {}): Promise<UpgradeSource> {
  const s: UpgradeSource = { id: `test-source-upgrade-${label}-${T}`, kind: "external", config: {},
    enabled: false, participation_mode: "editorial", interval_minutes: 60, ...changes };
  await sql`INSERT INTO sources (id,name,kind,config,enabled,participation_mode,interval_minutes,health,cursor,last_fetch_at,last_ok_at,fail_count,last_error)
    VALUES (${s.id},'Upgrade fixture',${s.kind},${sql.json(s.config as never)},${s.enabled},${s.participation_mode},${s.interval_minutes},
      ${changes.health ?? "unknown"},${sql.json(OLD_CURSOR)},now()-interval '1 day',now()-interval '1 day',2,'Old collector failure')`;
  return s;
}
const native = (s: UpgradeSource, changes: Partial<UpgradeSource> = {}): UpgradeSource => ({ ...s, kind: "rss",
  config: { feedUrl: `https://example.org/${s.id}.xml`, _aihot: { initialBackfillLimit: 2 } }, enabled: true, ...changes });
function manifest(s: UpgradeSource, opts: { frozen?: boolean; nonArticle?: boolean } = {}): SourceProfileManifest {
  return { schemaVersion: 1, preserveDisabledSourceIds: opts.frozen ? [s.id] : [], profiles: {
    [s.id]: { policy: opts.frozen || !s.enabled ? "blocked" : s.kind === "external" ? "bridge" : "native",
      nonArticle: opts.nonArticle, participationMode: s.participation_mode, verification: { status: "verified" } },
  } };
}
const run = (s: UpgradeSource, apply = true, profiles = manifest(s), legacyNativeConfigs: Array<{ kind: string; config: Record<string, unknown> }> = []) =>
  upgradeSources({ sources: [s], profiles, legacyNativeConfigs, apply });
const stored = async (id: string) => (await sql`SELECT * FROM sources WHERE id=${id}`)[0]!;
const ledger = async (id: string) => (await sql`SELECT value,updated_at FROM settings WHERE key=${managedKey(id)}`)[0];

async function material(sourceId: string) {
  return (await upsertMaterial({ sourceId, url: `https://example.org/upgrade-material-${sourceId}`, title: "Original model release",
    bodyText: BODY, bodyStatus: "ok", via: "ingest", publishedAt: new Date() })).articleId;
}

test("default dry run reports reviewed route changes and writes no source, ledger, audit or queue state", async () => {
  const s = await source("dry");
  const before = await stored(s.id);
  const audits = await sql`SELECT * FROM audit_log WHERE subject=${`source:${s.id}`}`;
  const result = await upgradeSources({ sources: [native(s)], profiles: manifest(native(s)), legacyNativeConfigs: [] });
  assert.equal(result.apply, false);
  assert.equal(result.wouldUpdate, 1);
  assert.equal(result.results[0]!.resetCursor, true);
  assert.deepEqual(await stored(s.id), before);
  assert.equal(await ledger(s.id), undefined);
  assert.deepEqual([...(await sql`SELECT * FROM audit_log WHERE subject=${`source:${s.id}`}`)], [...audits]);
});

test("legacy automatic source upgrades atomically, resets only collector state and preserves raw material and bridge receipts", async (t) => {
  const s = await source("legacy");
  const articleId = await material(s.id);
  const beforeArticle = (await sql`SELECT * FROM articles WHERE id=${articleId}`)[0];
  const upstreamId = 8_000_000 + Math.floor(Math.random() * 1_000_000);
  const client = `corescope-upgrade-fixture-${T}`;
  await sql`INSERT INTO corescope_bridge_state (client) VALUES (${client})`;
  t.after(async () => {
    await sql`DELETE FROM corescope_bridge_ledger WHERE client=${client}`;
    await sql`DELETE FROM corescope_bridge_state WHERE client=${client}`;
  });
  await sql`INSERT INTO corescope_bridge_ledger (client,upstream_id,source_alias,source_id,article_id,raw_fingerprint,body_evidence,source_evidence)
    VALUES (${client},${upstreamId},${s.id},${s.id},${articleId},${"a".repeat(64)},'{}','[]')`;
  const beforeReceipt = (await sql`SELECT * FROM corescope_bridge_ledger WHERE client=${client} AND upstream_id=${upstreamId}`)[0];
  const desired = native(s, { interval_minutes: 120 });
  const result = await run(desired);
  assert.equal(result.updated, 1);
  const saved = await stored(s.id);
  assert.deepEqual([saved.kind, saved.config, saved.enabled, saved.participation_mode, saved.interval_minutes],
    [desired.kind, desired.config, true, "editorial", 120]);
  assert.deepEqual([saved.cursor, saved.fail_count, saved.last_error, saved.last_fetch_at, saved.last_ok_at, saved.health],
    [null, 0, null, null, null, "unknown"]);
  assert.ok(saved.next_fetch_at.getTime() <= Date.now());
  assert.deepEqual((await sql`SELECT * FROM articles WHERE id=${articleId}`)[0], beforeArticle);
  assert.deepEqual((await sql`SELECT * FROM corescope_bridge_ledger WHERE client=${client} AND upstream_id=${upstreamId}`)[0], beforeReceipt);
  const savedLedger = await ledger(s.id);
  assert.equal(savedLedger!.value.managedFields.config, undefined);
  assert.match(savedLedger!.value.managedFields.configHash, /^[a-f0-9]{64}$/);
  const beforeAudit = await sql`SELECT * FROM audit_log WHERE subject=${`source:${s.id}`} AND actor=${UPGRADE_ACTOR}`;
  const repeat = await run(desired);
  assert.equal(repeat.updated, 0);
  assert.equal(repeat.results[0]!.ledgerWritten, false);
  assert.deepEqual(await ledger(s.id), savedLedger);
  assert.deepEqual([...(await sql`SELECT * FROM audit_log WHERE subject=${`source:${s.id}`} AND actor=${UPGRADE_ACTOR}`)], [...beforeAudit]);
});

test("operator enabled audit preserves a pause while the reviewed route is upgraded", async () => {
  const s = await source("paused", { health: "paused" });
  await audit("admin:fixture", "source.update", `source:${s.id}`, "Operator pause", { enabled: true }, { enabled: false });
  const result = await run(native(s));
  const saved = await stored(s.id);
  assert.equal(saved.kind, "rss");
  assert.deepEqual([saved.enabled, saved.health], [false, "paused"]);
  assert.deepEqual(result.results[0]!.preservedFields, ["enabled"]);
  assert.ok(result.results[0]!.reasons.includes("operator_fields_preserved"));
});

test("an operator config audit preserves kind, config and participation together and does not activate an incomplete route", async () => {
  const s = await source("route-owner");
  await audit("admin:fixture", "source.update", `source:${s.id}`, "Explicit config ownership", { config: {} }, { config: {} });
  const result = await run(native(s, { participation_mode: "hot_signal" }));
  const saved = await stored(s.id);
  assert.deepEqual([saved.kind, saved.config, saved.participation_mode, saved.enabled], ["external", {}, "editorial", false]);
  assert.deepEqual(result.results[0]!.preservedFields, ["kind", "config", "participation_mode", "enabled"]);
  assert.ok(result.results[0]!.reasons.includes("incomplete_route_not_activated"));
});

test("existing unmanaged native configs are never adopted just because the ID appears in the new directory", async () => {
  const s = await source("custom", { kind: "rss", enabled: true, config: { feedUrl: "https://example.org/operator-feed.xml" } });
  const before = await stored(s.id);
  const result = await run(native(s));
  assert.equal(result.skipped, 1);
  assert.ok(result.results[0]!.reasons.includes("unmanaged_existing_route_needs_review"));
  assert.deepEqual(await stored(s.id), before);
  assert.equal(await ledger(s.id), undefined);
  assert.ok(!JSON.stringify(result).includes("operator-feed.xml"));
});

test("known upstream configs can upgrade but unrelated operator names and collector interval drift remain untouched", async () => {
  const config = { feedUrl: "https://example.org/legacy-upstream.xml", _aihot: { initialBackfillLimit: 2 } };
  const s = await source("upstream", { kind: "rss", enabled: true, config });
  await audit("admin:fixture", "source.update", `source:${s.id}`, "Rename", { name: "Old" }, { name: "Operator name" });
  await sql`UPDATE sources SET name='Operator name' WHERE id=${s.id}`;
  const desired = native(s);
  assert.equal((await run(desired, true, manifest(desired), [{ kind: "rss", config }])).updated, 1);
  await sql`UPDATE sources SET interval_minutes=15 WHERE id=${s.id}`;
  const changed = native(s, { config: { feedUrl: "https://example.org/next-profile.xml", _aihot: { initialBackfillLimit: 2 } }, interval_minutes: 90 });
  const result = await run(changed);
  const saved = await stored(s.id);
  assert.deepEqual([saved.name, saved.interval_minutes, saved.config], ["Operator name", 15, changed.config]);
  assert.ok(result.results[0]!.preservedFields.includes("interval_minutes"));
});

test("new operator audits and unaudited drift after a managed upgrade cannot be overwritten on later starts", async () => {
  const s = await source("later-edit");
  const desired = native(s);
  await run(desired);
  await audit("admin:fixture", "source.update", `source:${s.id}`, "Pause after upgrade", { enabled: true }, { enabled: false });
  await sql`UPDATE sources SET enabled=false,health='paused',config=${sql.json({ feedUrl: "https://example.org/private-operator.xml" })} WHERE id=${s.id}`;
  const second = native(s, { participation_mode: "hot_signal" });
  const result = await run(second);
  const saved = await stored(s.id);
  assert.deepEqual([saved.enabled, saved.participation_mode, saved.config], [false, "editorial", { feedUrl: "https://example.org/private-operator.xml" }]);
  assert.ok(result.results[0]!.preservedFields.includes("enabled"));
  assert.ok(result.results[0]!.preservedFields.includes("config"));
  assert.equal((await run(second)).updated, 0);
});

test("frozen pauses remain disabled and freshly seeded reviewed routes establish a baseline without a rewrite", async () => {
  const paused = await source("frozen");
  await run({ ...paused, enabled: true }, true, manifest(paused, { frozen: true }));
  assert.equal((await stored(paused.id)).enabled, false);
  const desired = { ...paused, id: `test-source-upgrade-fresh-${T}`, kind: "rss" as const,
    enabled: true, config: { feedUrl: "https://example.org/fresh.xml" } };
  await source("fresh", desired);
  const before = await stored(desired.id);
  const result = await run(desired);
  assert.equal(result.updated, 0);
  assert.equal(result.results[0]!.ledgerWritten, true);
  assert.deepEqual(await stored(desired.id), before);
});

test("operator-created sources keep every explicitly owned route field even when the ID is later included in the directory", async () => {
  const s = await source("operator-created");
  await audit("admin:fixture", "source.create", `source:${s.id}`, null, null, { ...s });
  const before = await stored(s.id);
  const result = await run(native(s));
  assert.equal(result.updated, 0);
  assert.deepEqual(await stored(s.id), before);
  assert.deepEqual(result.results[0]!.preservedFields, ["kind", "config", "participation_mode", "enabled", "interval_minutes"]);
});

test("reviewed X provider-only upgrade preserves account watermarks and a later operator choice survives directory reconciliation", async () => {
  const config = { query: `from:u${T.slice(-8)} -filter:replies`, searchType: "Latest", provider: "xquik", _aihot: { initialBackfillLimit: 2 } };
  const s = await source("x-provider", { kind: "x_search", enabled: true, config });
  const xCursor = { lastTweetId: "1980000000000000000", initializedAt: "2026-10-01T00:00:00Z",
    xBacklog: [{ query: config.query, next: "supplier-specific-backlog" }] };
  await sql`UPDATE sources SET cursor=${sql.json(xCursor)} WHERE id=${s.id}`;
  const desired = { ...s, config: { ...config, provider: "bird", bird: { accountProfile: "birdclaw-primary", maxPagesPerRound: 1 }, _aihot: { initialBackfillLimit: 20 } } };
  const result = await run(desired, true, manifest(desired), [{ kind: "x_search", config }]);
  assert.equal(result.updated, 1);
  assert.equal(result.results[0]!.resetCursor, false);
  let saved = await stored(s.id);
  assert.equal(saved.cursor.lastTweetId, xCursor.lastTweetId);
  assert.equal(saved.cursor.initializedAt, xCursor.initializedAt);
  assert.equal(saved.cursor.xBacklog, undefined);
  assert.equal(saved.cursor.xRouteHistory[0].backlog[0].next, "supplier-specific-backlog");
  await updateSource(s.id, { patch: { config }, version: saved.updated_at.toISOString(), reason: "Operator chooses Xquik" }, "admin:fixture");
  const reconciled = await run(desired);
  saved = await stored(s.id);
  assert.equal(saved.config.provider, "xquik");
  assert.equal(saved.cursor.lastTweetId, xCursor.lastTweetId);
  assert.ok(reconciled.results[0]!.preservedFields.includes("config"));
  assert.equal((await run(desired)).updated, 0);
});

test("invalid profile policy, unverified native route and non-article editorial scope are rejected before any upgrade writes", async () => {
  const s = await source("invalid-profile");
  const desired = native(s);
  const before = await stored(s.id);
  const invalid = manifest(desired);
  invalid.profiles[s.id]!.policy = "unreviewed" as "native";
  await assert.rejects(run(desired, true, invalid), /policy/);
  const unverified = manifest(desired);
  unverified.profiles[s.id]!.verification = { status: "candidate" };
  await assert.rejects(run(desired, true, unverified), /verified/);
  await assert.rejects(run(desired, true, manifest(desired, { nonArticle: true })), /isolated/);
  assert.deepEqual(await stored(s.id), before);
  assert.equal(await ledger(s.id), undefined);
});

test("non-article isolation hides public scope immediately and queues normal republishing without changing evidence", async () => {
  const s = await source("catalog", { enabled: true });
  const articleId = await material(s.id);
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected)
    VALUES (${articleId},1,'rule','pass','目录误入新闻夹具','原始技术证据摘要',90,true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id,title,summary,first_report_at,latest_at)
    VALUES (${randomUUID()},'Old catalog story','Old source-dependent story summary',now(),now()) RETURNING id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id,story_id,title) VALUES (${randomUUID()},${story!.id},'Old source-dependent fact') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},${articleId},'report')`;
  const beforeArticle = (await sql`SELECT * FROM articles WHERE id=${articleId}`)[0];
  const visible = () => sql`SELECT 1 FROM publications p JOIN sources s ON s.id=p.source_id WHERE p.article_id=${articleId} AND ${listedCondition(new Date())}`;
  assert.equal((await visible()).length, 1);
  const desired: UpgradeSource = { ...s, enabled: false, participation_mode: "isolated" };
  await run(desired, true, manifest(desired, { nonArticle: true }));
  assert.equal((await visible()).length, 0);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.republishSource} AND data->>'sourceId'=${s.id}`).length, 1);
  assert.deepEqual((await sql`SELECT * FROM articles WHERE id=${articleId}`)[0], beforeArticle);
  assert.equal((await sql`SELECT summary FROM stories WHERE id=${story!.id}`)[0]!.summary, null);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${articleId}`)[0]!.visibility, "withdrawn");
  await republishSource(s.id);
  assert.equal((await sql`SELECT visibility FROM publications WHERE article_id=${articleId}`)[0]!.visibility, "withdrawn");
});

test("source, audit, republish job and managed ledger roll back together on a ledger write failure", async () => {
  const s = await source("rollback", { enabled: true });
  const before = await stored(s.id);
  const functionName = `test_source_upgrade_rollback_${T}`;
  await sql.unsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.key = '${managedKey(s.id)}' THEN
        IF NOT EXISTS (SELECT 1 FROM pgboss.job WHERE name = '${QUEUES.republishSource}' AND data->>'sourceId' = '${s.id}') THEN
          RAISE EXCEPTION 'republish job missing before rollback';
        END IF;
        RAISE EXCEPTION 'fixture source upgrade ledger rollback';
      END IF;
      RETURN NEW;
    END $$`);
  await sql.unsafe(`CREATE TRIGGER ${functionName} BEFORE INSERT OR UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
  try {
    const desired: UpgradeSource = { ...s, enabled: false, participation_mode: "isolated" };
    await assert.rejects(run(desired, true, manifest(desired, { nonArticle: true })), /fixture source upgrade ledger rollback/);
  } finally {
    await sql.unsafe(`DROP TRIGGER ${functionName} ON settings`);
    await sql.unsafe(`DROP FUNCTION ${functionName}()`);
  }
  assert.deepEqual(await stored(s.id), before);
  assert.equal(await ledger(s.id), undefined);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject=${`source:${s.id}`} AND actor=${UPGRADE_ACTOR}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE name=${QUEUES.republishSource} AND data->>'sourceId'=${s.id}`).length, 0);
});
