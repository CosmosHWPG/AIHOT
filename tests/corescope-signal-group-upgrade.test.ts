import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { tag } from "./setup.ts";
import { upgradeSources, managedKey, UPGRADE_ACTOR, type UpgradeSource, type SourceProfileManifest } from "../scripts/corescope-source-upgrade.ts";

const T = tag();
const previous = `feed:legacy-${T}`;
const target = `publisher:official-${T}`;
const cursor = { initializedAt: "2026-10-01T00:00:00Z", lastTweetId: "12345" };
after(async () => { await stopBoss(); await closeDb(); });

async function source(label: string, group: string | null = previous) {
  const desired: UpgradeSource = { id: `test-group-upgrade-${label}-${T}`, kind: "external", config: {},
    enabled: true, participation_mode: "editorial", interval_minutes: 60, signal_group_id: target };
  await sql`INSERT INTO sources (id,name,kind,config,enabled,participation_mode,interval_minutes,signal_group_id,cursor)
    VALUES (${desired.id},'Group fixture','external','{}',true,'editorial',60,${group},${sql.json(cursor)})`;
  return desired;
}
const profiles = (desired: UpgradeSource, transition = true, frozen = false): SourceProfileManifest => ({
  schemaVersion: 1, preserveDisabledSourceIds: frozen ? [desired.id] : [], profiles: {
    [desired.id]: { policy: "bridge", ...(transition ? { signalGroupId: target, previousSignalGroupId: previous } : {}) },
  },
});
const run = (desired: UpgradeSource, apply: boolean, manifest = profiles(desired)) =>
  upgradeSources({ sources: [desired], profiles: manifest, legacyNativeConfigs: [], apply });
const state = async (id: string) => ({
  source: (await sql`SELECT * FROM sources WHERE id=${id}`)[0],
  ledger: (await sql`SELECT value,updated_at FROM settings WHERE key=${managedKey(id)}`)[0],
  audits: [...await sql`SELECT * FROM audit_log WHERE subject=${`source:${id}`} ORDER BY id`],
});

test("reviewed exact old-to-new group transition is dry-run safe, transactional and repeat has zero writes", async () => {
  const desired = await source("exact");
  const before = await state(desired.id);
  const preview = await run(desired, false);
  assert.equal(preview.wouldUpdate, 1);
  assert.equal(preview.results[0]!.signalGroup?.status, "would_update");
  assert.deepEqual(await state(desired.id), before);

  const applied = await run(desired, true);
  assert.equal(applied.updated, 1);
  assert.equal(applied.results[0]!.resetCursor, false);
  const after = await state(desired.id);
  assert.equal(after.source!.signal_group_id, target);
  assert.deepEqual(after.source!.cursor, cursor);
  assert.deepEqual(Object.keys(after.ledger!.value.managedFields).sort(), ["kind", "configHash", "participation_mode", "enabled", "interval_minutes"].sort());
  assert.equal(after.audits.filter(a => a.actor === UPGRADE_ACTOR && a.action === "source.signal-group-upgrade").length, 1);
  const repeated = await run(desired, true);
  assert.equal(repeated.updated, 0);
  assert.equal(repeated.results[0]!.signalGroup?.status, "unchanged");
  assert.equal(repeated.results[0]!.ledgerWritten, false);
  assert.deepEqual(await state(desired.id), after, "source timestamp, ledger timestamp and audits are unchanged");
});

test("historical operator no-op and source creation retain signal group ownership beyond route ledger watermark", async () => {
  const noOp = await source("historical-noop");
  await audit("admin:fixture", "source.update", `source:${noOp.id}`, "Explicit ownership", { signal_group_id: previous }, { signal_group_id: previous });
  await run(noOp, true, profiles(noOp, false)); // ledger watermark has already passed this manual audit
  const result = await run(noOp, true);
  assert.equal(result.results[0]!.signalGroup?.reason, "operator_signal_group_preserved");
  assert.equal((await state(noOp.id)).source!.signal_group_id, previous);

  const created = await source("operator-create");
  await audit("admin:fixture", "source.create", `source:${created.id}`, null, null, { signal_group_id: previous });
  assert.equal((await run(created, true)).results[0]!.signalGroup?.reason, "operator_signal_group_preserved");
  assert.equal((await state(created.id)).source!.signal_group_id, previous);
  assert.equal((await state(created.id)).audits.filter(a => a.action === "source.signal-group-upgrade").length, 0);
});

test("unknown drift, frozen sources and profiles without explicit transition never rewrite group identity", async () => {
  const drift = await source("drift", `operator:unknown-${T}`);
  const driftResult = await run(drift, true);
  assert.equal(driftResult.results[0]!.signalGroup?.reason, "signal_group_drift_needs_review");
  assert.equal((await state(drift.id)).source!.signal_group_id, `operator:unknown-${T}`);
  const frozen = await source("frozen");
  assert.equal((await run(frozen, true, profiles(frozen, true, true))).results[0]!.signalGroup?.reason, "frozen_source_group_preserved");
  assert.equal((await state(frozen.id)).source!.signal_group_id, previous);
  const absent = await source("no-transition");
  assert.equal((await run(absent, true, profiles(absent, false))).results[0]!.signalGroup, undefined);
  assert.equal((await state(absent.id)).source!.signal_group_id, previous);
  const conflicting = await source("conflicting");
  const before = await state(conflicting.id);
  await assert.rejects(run({ ...conflicting, signal_group_id: "publisher:wrong" }, true), /conflicting reviewed signal group/);
  assert.deepEqual(await state(conflicting.id), before);
});
