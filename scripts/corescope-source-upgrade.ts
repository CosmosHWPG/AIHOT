// Reconcile reviewed collector routes with existing CoreScope sources. Seed stays
// insert-only; this separate, audited upgrade preserves operator-owned fields.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sql, closeDb, type Tx } from "@aihot/backend/db";
import { REPO_ROOT } from "@aihot/backend/config";
import { audit } from "@aihot/backend/audit";
import { sha256, stableJson } from "@aihot/backend/lib/ids";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";
import { invalidateStoryInputs } from "@aihot/backend/events/derived-content";
import { resumeSourceArticles } from "@aihot/backend/jobs/content";
import { republishKey } from "@aihot/backend/jobs/publication";
import { publishArticleTx } from "@aihot/backend/publication/publish";
import { enqueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { bindHistoricXProviders, routeProvider, transitionXCursor } from "@aihot/backend/sources/x-route";

export const UPGRADE_ACTOR = "system:corescope-source-upgrade";
export const managedKey = (sourceId: string) => `corescope.source-upgrade:${sourceId}`;
const ROUTE_FIELDS = ["kind", "config", "participation_mode"] as const;
const MANAGED_FIELDS = [...ROUTE_FIELDS, "enabled", "interval_minutes"] as const;
const SOURCE_KINDS: SourceRow["kind"][] = ["rss", "web_list", "json_list", "x_search", "mp_account", "external"];
type ManagedField = typeof MANAGED_FIELDS[number];

export interface UpgradeSource {
  id: string; kind: SourceRow["kind"]; config: Record<string, unknown>;
  enabled: boolean; participation_mode: SourceRow["participation_mode"]; interval_minutes: number;
  signal_group_id?: string | null;
}
export interface SourceProfileManifest {
  schemaVersion: number; preserveDisabledSourceIds: string[];
  profiles: Record<string, { policy: "native" | "bridge" | "blocked"; nonArticle?: boolean;
    participationMode?: string; [key: string]: unknown }>;
}
interface Baseline {
  kind: string; configHash: string; participation_mode: string; enabled: boolean; interval_minutes: number;
}
interface ManagedLedger {
  schemaVersion: 1; profileHash: string; managedFields: Baseline;
  auditWatermark: number; protectedFields: ManagedField[];
}
interface AuditRow { id: number; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
interface StoredSource extends UpgradeSource { health: string; cursor: Record<string, unknown> | null }
export interface UpgradeOptions {
  apply?: boolean; db?: typeof sql; sources?: UpgradeSource[]; profiles?: SourceProfileManifest;
  legacyNativeConfigs?: Array<{ kind: string; config: Record<string, unknown> }>;
}
export interface UpgradeResult {
  sourceId: string; status: "missing" | "skipped" | "unchanged" | "would_update" | "updated";
  changedFields: ManagedField[]; preservedFields: ManagedField[]; reasons: string[];
  profileHash: string; resetCursor: boolean; ledgerWritten: boolean;
  signalGroup?: SignalGroupUpgradeResult;
}
export interface SignalGroupUpgradeResult {
  status: "unchanged" | "preserved" | "would_update" | "updated";
  previous: string | null; target: string; reason?: string;
}

function baseline(source: UpgradeSource): Baseline {
  return { kind: source.kind, configHash: sha256(stableJson(source.config)),
    participation_mode: source.participation_mode, enabled: source.enabled, interval_minutes: source.interval_minutes };
}
function fieldValue(value: Baseline, field: ManagedField): unknown {
  return field === "config" ? value.configHash : value[field];
}
function same(a: unknown, b: unknown): boolean { return stableJson(a) === stableJson(b); }
function owns(value: Record<string, unknown> | null, key: string): boolean {
  return value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

export function loadUpgradeInputs(root = REPO_ROOT) {
  const sources = JSON.parse(readFileSync(path.join(root, "industry/sources.json"), "utf8")).sources as UpgradeSource[];
  const profilePath = path.join(root, "industry/corescope-source-profiles.json");
  const profiles: SourceProfileManifest = existsSync(profilePath)
    ? JSON.parse(readFileSync(profilePath, "utf8"))
    : { schemaVersion: 1, preserveDisabledSourceIds: [], profiles: {} };
  const upstream = JSON.parse(readFileSync(path.join(root, "docs/corescope-upstream-sources.json"), "utf8")).sources as UpgradeSource[];
  const legacyNativeConfigs = upstream.map((s) => ({ kind: s.kind,
    config: { ...s.config, _aihot: { initialBackfillLimit: 2 } } }));
  return { sources, profiles, legacyNativeConfigs };
}

function validateInputs(sources: UpgradeSource[], profiles: SourceProfileManifest) {
  if (profiles.schemaVersion !== 1 || !Array.isArray(profiles.preserveDisabledSourceIds)
    || profiles.preserveDisabledSourceIds.some((id) => typeof id !== "string")
    || !profiles.profiles || typeof profiles.profiles !== "object" || Array.isArray(profiles.profiles)) {
    throw new Error("Invalid source profile manifest");
  }
  for (const profile of Object.values(profiles.profiles)) {
    if (!["native", "bridge", "blocked"].includes(profile.policy)) throw new Error("Invalid source profile policy");
    if (owns(profile, "previousSignalGroupId") && (typeof profile.signalGroupId !== "string"
      || !profile.signalGroupId.trim() || profile.signalGroupId.length > 120
      || !(profile.previousSignalGroupId === null || typeof profile.previousSignalGroupId === "string" && profile.previousSignalGroupId.length <= 120))) {
      throw new Error("Invalid reviewed signal group transition");
    }
  }
  const ids = new Set<string>();
  for (const s of sources) {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(s.id) || ids.has(s.id)) throw new Error("Invalid or duplicate source ID");
    ids.add(s.id);
    if (!SOURCE_KINDS.includes(s.kind) || !s.config || typeof s.config !== "object" || Array.isArray(s.config)
      || typeof s.enabled !== "boolean" || !["editorial", "hot_signal", "isolated"].includes(s.participation_mode)
      || !Number.isInteger(s.interval_minutes) || s.interval_minutes < 1 || s.interval_minutes > 1440) {
      throw new Error(`Invalid reviewed source fields for ${s.id}`);
    }
    assertSupportedConfig(s.kind, s.config);
    const profile = profiles.profiles[s.id];
    if (profile && owns(profile, "previousSignalGroupId") && s.signal_group_id !== profile.signalGroupId) {
      throw new Error(`Source ${s.id} has conflicting reviewed signal group`);
    }
    if (profile?.nonArticle && s.participation_mode !== "isolated") {
      throw new Error(`Non-article source ${s.id} must stay isolated`);
    }
    if (profile?.policy === "native") {
      const verification = profile.verification as Record<string, unknown> | undefined;
      if (s.kind === "external" || verification?.status !== "verified") throw new Error(`Source ${s.id} has no verified native route`);
    }
    if (profile?.policy === "bridge" && s.kind !== "external") throw new Error(`Source ${s.id} has conflicting collector routes`);
    if (profile?.policy === "blocked" && s.enabled && !profiles.preserveDisabledSourceIds.includes(s.id)) {
      throw new Error(`Blocked source ${s.id} is enabled in the reviewed pack`);
    }
  }
}

/** Explicit group transitions have their own ownership check, independent of the route ledger. */
async function reconcileSignalGroup(db: Tx, desired: UpgradeSource, profiles: SourceProfileManifest,
  apply: boolean): Promise<SignalGroupUpgradeResult | undefined> {
  const profile = profiles.profiles[desired.id];
  if (!profile || !owns(profile, "previousSignalGroupId")) return undefined;
  const previous = profile.previousSignalGroupId as string | null;
  const target = profile.signalGroupId as string;
  const result: SignalGroupUpgradeResult = { status: "preserved", previous, target };
  if (profiles.preserveDisabledSourceIds.includes(desired.id)) {
    result.reason = "frozen_source_group_preserved"; return result;
  }
  // reconcileOne already took the shared admin identity lock for apply. Re-locking the row keeps
  // group writes and route writes within that same transaction and prevents concurrent admin edits.
  const [current] = await db<{ signal_group_id: string | null }[]>`SELECT signal_group_id FROM sources
    WHERE id=${desired.id} ${apply ? db`FOR UPDATE` : db``}`;
  if (!current) { result.reason = "source_missing_run_seed_first"; return result; }
  // Search all history, not the route ledger watermark: a past no-op is still explicit ownership.
  const owned = await db<{ id: number }[]>`SELECT id FROM audit_log
    WHERE subject=${`source:${desired.id}`} AND actor<>${UPGRADE_ACTOR}
      AND action IN ('source.update','source.create')
      AND (before ? 'signal_group_id' OR after ? 'signal_group_id') LIMIT 1`;
  if (owned.length) { result.reason = "operator_signal_group_preserved"; return result; }
  if (current.signal_group_id === target) { result.status = "unchanged"; return result; }
  if (current.signal_group_id !== previous) { result.reason = "signal_group_drift_needs_review"; return result; }
  result.status = apply ? "updated" : "would_update";
  if (apply) {
    await db`UPDATE sources SET signal_group_id=${target},updated_at=now() WHERE id=${desired.id}`;
    await audit(UPGRADE_ACTOR, "source.signal-group-upgrade", `source:${desired.id}`, "应用已核验的参与主体群组，保留人工归属",
      { signal_group_id: previous }, { signal_group_id: target }, { db });
  }
  return result;
}

function validLedger(value: unknown): value is ManagedLedger {
  if (!value || typeof value !== "object") return false;
  const ledger = value as ManagedLedger;
  return ledger.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(ledger.profileHash) && !!ledger.managedFields
    && /^[a-f0-9]{64}$/.test(ledger.managedFields.configHash)
    && typeof ledger.managedFields.kind === "string" && typeof ledger.managedFields.participation_mode === "string"
    && typeof ledger.managedFields.enabled === "boolean" && Number.isInteger(ledger.managedFields.interval_minutes)
    && Number.isSafeInteger(ledger.auditWatermark) && ledger.auditWatermark >= 0
    && Array.isArray(ledger.protectedFields) && ledger.protectedFields.every((f) => MANAGED_FIELDS.includes(f));
}

async function reconcileOne(db: Tx, desired: UpgradeSource, profiles: SourceProfileManifest,
  legacyNativeConfigs: Array<{ kind: string; config: Record<string, unknown> }>, apply: boolean): Promise<UpgradeResult> {
  if (apply) {
    // Share the identity lock with admin config edits, then hold the source row
    // while reading its audits and writing source/ledger/publication changes.
    await db`SELECT pg_advisory_xact_lock(hashtext('admin-source-identity'))`;
  }
  const [current] = await db<StoredSource[]>`SELECT id,kind,config,enabled,participation_mode,interval_minutes,health,cursor
    FROM sources WHERE id=${desired.id} ${apply ? db`FOR UPDATE` : db``}`;
  const frozen = profiles.preserveDisabledSourceIds.includes(desired.id);
  const target = { ...desired, enabled: frozen ? false : desired.enabled };
  const profileHash = sha256(stableJson({ fields: baseline(target), profile: profiles.profiles[desired.id] ?? null, frozen }));
  const result: UpgradeResult = { sourceId: desired.id, status: "missing", changedFields: [], preservedFields: [],
    reasons: [], profileHash, resetCursor: false, ledgerWritten: false };
  if (!current) { result.reasons.push("source_missing_run_seed_first"); return result; }
  const [saved] = await db<{ value: unknown }[]>`SELECT value FROM settings WHERE key=${managedKey(desired.id)}`;
  if (saved && !validLedger(saved.value)) {
    result.status = "skipped"; result.reasons.push("invalid_managed_ledger_needs_review"); return result;
  }
  const ledger = saved?.value as ManagedLedger | undefined;
  const audits = await db<AuditRow[]>`SELECT id,action,before,after FROM audit_log
    WHERE subject=${`source:${desired.id}`} AND action IN ('source.update','source.create') AND actor<>${UPGRADE_ACTOR}
      AND id>${ledger?.auditWatermark ?? 0} ORDER BY id`;
  const protectedFields = new Set<ManagedField>(ledger?.protectedFields ?? []);
  for (const row of audits) {
    for (const field of MANAGED_FIELDS) {
      // Explicit no-op updates also express operator ownership of that field.
      if (owns(row.before, field) || owns(row.after, field)) protectedFields.add(field);
    }
  }
  const currentBaseline = baseline(current);
  const targetBaseline = baseline(target);
  const freshSeed = MANAGED_FIELDS.every((f) => same(fieldValue(currentBaseline, f), fieldValue(targetBaseline, f)));
  const legacyExternal = current.kind === "external" && same(current.config, {}) && current.participation_mode === "editorial";
  const legacyNative = current.participation_mode === "editorial"
    && legacyNativeConfigs.some((legacy) => current.kind === legacy.kind && same(current.config, legacy.config));
  if (!ledger && !freshSeed && !legacyExternal && !legacyNative) {
    result.status = "skipped"; result.preservedFields = [...MANAGED_FIELDS];
    result.reasons.push("unmanaged_existing_route_needs_review"); return result;
  }
  if (ledger) {
    for (const field of MANAGED_FIELDS) {
      if (!same(fieldValue(currentBaseline, field), fieldValue(ledger.managedFields, field))) {
        protectedFields.add(field);
        result.reasons.push(`managed_field_drift:${field}`);
      }
    }
  } else if (!current.enabled && current.health === "paused" && target.enabled && !protectedFields.has("enabled")) {
    protectedFields.add("enabled");
    result.reasons.push("paused_health_without_audit_needs_review");
  }
  if (ROUTE_FIELDS.some((field) => protectedFields.has(field))) {
    for (const field of ROUTE_FIELDS) protectedFields.add(field);
    result.reasons.push("operator_or_drift_route_preserved_as_one_group");
  }
  if (audits.some((row) => MANAGED_FIELDS.some((f) => owns(row.before, f) || owns(row.after, f)))) {
    result.reasons.push("operator_fields_preserved");
  }
  const after: UpgradeSource = { ...current };
  for (const field of MANAGED_FIELDS) {
    if (protectedFields.has(field)) continue;
    if (!same(fieldValue(currentBaseline, field), fieldValue(targetBaseline, field))) {
      Object.assign(after, { [field]: target[field] });
      result.changedFields.push(field);
    }
  }
  // Do not activate a replacement whose route could not be applied atomically.
  if (!current.enabled && after.enabled && ROUTE_FIELDS.some((f) => !same(fieldValue(baseline(after), f), fieldValue(targetBaseline, f)))) {
    after.enabled = false;
    result.changedFields = result.changedFields.filter((f) => f !== "enabled");
    protectedFields.add("enabled");
    result.reasons.push("incomplete_route_not_activated");
  }
  result.preservedFields = [...MANAGED_FIELDS].filter((f) => protectedFields.has(f));
  const transition = current.kind === "x_search" && after.kind === "x_search"
    ? transitionXCursor(current.cursor, current.config, after.config) : null;
  const providerChanged = transition !== null && transition.change !== "none";
  result.resetCursor = result.changedFields.some((f) => ROUTE_FIELDS.includes(f as typeof ROUTE_FIELDS[number]));
  if (transition?.change === "provider-only") {
    result.resetCursor = false;
    result.reasons.push("x_provider_watermark_preserved_opaque_backlog_archived");
  }
  result.status = result.changedFields.length ? apply ? "updated" : "would_update" : "unchanged";
  const nextLedger: ManagedLedger = { schemaVersion: 1, profileHash, managedFields: baseline(after),
    auditWatermark: audits.at(-1)?.id ?? ledger?.auditWatermark ?? 0, protectedFields: result.preservedFields };
  if (!apply) return result;
  if (result.changedFields.length) {
    const historicProviders = providerChanged ? await bindHistoricXProviders(db, current) : null;
    const patch = Object.fromEntries(result.changedFields.map((f) => [f, f === "config" ? db.json(after.config as never) : after[f]]));
    await db`UPDATE sources SET ${db(patch as never, ...result.changedFields)}, updated_at=now(),
      cursor=CASE WHEN ${providerChanged} THEN ${providerChanged ? db.json(transition!.cursor as never) : null}::jsonb WHEN ${result.resetCursor} THEN NULL ELSE cursor END,
      fail_count=CASE WHEN ${result.resetCursor || providerChanged} THEN 0 ELSE fail_count END,
      last_error=CASE WHEN ${result.resetCursor || providerChanged} THEN NULL ELSE last_error END,
      last_fetch_at=CASE WHEN ${result.resetCursor} THEN NULL ELSE last_fetch_at END,
      last_ok_at=CASE WHEN ${result.resetCursor} THEN NULL ELSE last_ok_at END,
      health=CASE WHEN NOT ${after.enabled} THEN 'paused' WHEN ${result.resetCursor || providerChanged} OR health='paused' THEN 'unknown' ELSE health END,
      next_fetch_at=CASE WHEN ${result.resetCursor || providerChanged || (!current.enabled && after.enabled)} THEN now() ELSE next_fetch_at END
      WHERE id=${desired.id}`;
    if (providerChanged) await audit(UPGRADE_ACTOR, "source.x-provider-switch", `source:${desired.id}`, "应用已复审的 X 供应商并保留账户水位",
      { provider: routeProvider(current.config) }, { provider: routeProvider(after.config), transition: transition!.change,
        archivedBacklog: transition!.archivedBacklog, historicProviders, watermarkPreserved: transition!.change === "provider-only" }, { db });
    if (current.participation_mode !== after.participation_mode) {
      if (current.participation_mode !== "editorial" && after.participation_mode === "editorial") {
        await resumeSourceArticles(desired.id, db);
      }
      if (current.participation_mode === "editorial" && after.participation_mode !== "editorial") {
        // Lists use persisted eligibility; waiting for the worker would briefly
        // leave quarantined catalog pages in news. Revoke published material via
        // the normal projection/selected-sync contract in this same transaction.
        const published = await db<{ article_id: string }[]>`SELECT article_id FROM publications WHERE source_id=${desired.id} ORDER BY article_id`;
        for (const article of published) await publishArticleTx(db, article.article_id);
        const unpublished = await db<{ id: string }[]>`SELECT a.id FROM articles a
          WHERE a.source_id=${desired.id} AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.article_id=a.id)`;
        await invalidateStoryInputs(db, unpublished.map((a) => a.id), new Date());
      }
      await db`INSERT INTO settings (key,value,updated_by) VALUES (${republishKey(desired.id)},
        ${db.json({ status: "queued", queuedAt: new Date().toISOString() })},${UPGRADE_ACTOR})
        ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`;
      await enqueue(QUEUES.republishSource, { sourceId: desired.id }, { singletonKey: desired.id }, db);
    }
    // Never copy configuration secrets into human-readable audits or CLI output.
    await audit(UPGRADE_ACTOR, "source.route-upgrade", `source:${desired.id}`, "应用已复审的采集路线并保留人工配置",
      currentBaseline, { ...baseline(after), changedFields: result.changedFields, preservedFields: result.preservedFields, profileHash }, { db });
  }
  if (!same(ledger, nextLedger)) {
    await db`INSERT INTO settings (key,value,updated_by) VALUES (${managedKey(desired.id)},${db.json(nextLedger as never)},${UPGRADE_ACTOR})
      ON CONFLICT (key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`;
    result.ledgerWritten = true;
  }
  return result;
}

export async function upgradeSources(options: UpgradeOptions = {}) {
  const defaults = options.sources && options.profiles && options.legacyNativeConfigs ? null : loadUpgradeInputs();
  const sources = options.sources ?? defaults!.sources;
  const profiles = options.profiles ?? defaults!.profiles;
  const legacyNativeConfigs = options.legacyNativeConfigs ?? defaults!.legacyNativeConfigs;
  validateInputs(sources, profiles);
  const connection = options.db ?? sql;
  const results: UpgradeResult[] = [];
  for (const desired of sources) {
    const reconcile = async (tx: Tx) => {
      const result = await reconcileOne(tx, desired, profiles, legacyNativeConfigs, options.apply === true);
      result.signalGroup = await reconcileSignalGroup(tx, desired, profiles, options.apply === true);
      if (result.signalGroup?.status === "updated" || result.signalGroup?.status === "would_update") result.status = result.signalGroup.status;
      return result;
    };
    const one = options.apply
      ? await connection.begin(reconcile)
      : await connection.begin("read only", reconcile);
    results.push(one as UpgradeResult);
  }
  return { apply: options.apply === true, total: results.length,
    updated: results.filter((r) => r.status === "updated").length,
    wouldUpdate: results.filter((r) => r.status === "would_update").length,
    skipped: results.filter((r) => r.status === "skipped" || r.status === "missing").length,
    unchanged: results.filter((r) => r.status === "unchanged").length, results };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const flags = process.argv.slice(2);
    if (flags.some((f) => !["--apply", "--dry-run"].includes(f)) || flags.includes("--apply") && flags.includes("--dry-run")) {
      throw new Error("Usage: corescope-source-upgrade.ts [--dry-run | --apply]");
    }
    console.log(JSON.stringify(await upgradeSources({ apply: flags.includes("--apply") })));
  } finally {
    await stopBoss();
    await closeDb();
  }
}
