// Local operations share the same source routes, account gate, receipts and publication rules.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { updateSource } from "@aihot/backend/admin/sources";
import { collectSource } from "@aihot/backend/sources/collect";
import { birdConfigurationStatus, birdWhoami, BirdConfigurationError } from "@aihot/backend/providers/bird";
import { BudgetExceededError, ProviderRejectedError, completeReceipt } from "@aihot/backend/providers/receipts";
import { stopBoss } from "@aihot/backend/jobs/queue";
import type { SourceRow } from "@aihot/backend/sources/types";

const command = process.argv[2] ?? "status";
const args = process.argv.slice(3);
const actor = "corescope-bird-operations";
const pilot = ["v2-source-190", "v2-source-3725", "v2-source-186", "corescope-x-rohanpaul-ai", "corescope-x-anthropicai"];
const dbUrl = new URL(config.databaseUrl);
if (!["127.0.0.1", "localhost"].includes(dbUrl.hostname) || dbUrl.port !== "5448" || dbUrl.pathname !== "/corescope") {
  throw new Error("Bird deployment operations require the independent local CoreScope database.");
}
async function targets() {
  const supplied = args.find(a => a.startsWith("--ids="))?.slice(6).split(",").filter(Boolean);
  if (supplied?.some(id => !/^[a-z0-9][a-z0-9-]{2,79}$/.test(id))) throw new Error("Invalid source IDs");
  const ids = args.includes("--all") ? null : supplied ?? pilot;
  const rows = await sql<(SourceRow & { updated_at: Date })[]>`SELECT * FROM sources WHERE enabled AND kind='x_search'
    AND (${ids === null} OR id = ANY(${ids ?? []}::text[])) ORDER BY id`;
  if (ids && rows.length !== new Set(ids).size) throw new Error("Target source is missing, disabled or is not an X source");
  return rows;
}
async function status() {
  const runtime = await birdConfigurationStatus();
  const routes = await sql`SELECT coalesce(config->>'provider','socialdata') AS provider,count(*)::int AS sources,
    count(*) FILTER (WHERE enabled)::int AS enabled,max(last_ok_at) AS latest_success FROM sources WHERE kind='x_search' GROUP BY 1 ORDER BY 1`;
  const [budget] = await sql`SELECT service,enabled,per_minute,per_hour,per_day FROM budgets WHERE service='bird'`;
  // Old failed runs omitted detail.provider. A current Bird route alone cannot identify them:
  // require a recorded Bird switch and a matching live attempt inside this exact run's window.
  const birdRunProof = sql`(r.detail->>'provider'='bird' OR (
    nullif(r.detail->>'provider','') IS NULL AND s.kind='x_search' AND s.config->>'provider'='bird'
    AND s.cursor->'xRouteHistory'->-1->>'toProvider'='bird'
    AND r.started_at>=(s.cursor->'xRouteHistory'->-1->>'capturedAt')::timestamptz
    AND EXISTS(SELECT 1 FROM receipts p JOIN receipt_attempts a ON a.receipt_id=p.id
      WHERE p.service='bird' AND p.subject='source:'||r.source_id AND a.service='bird' AND a.origin='live'
        AND a.started_at>=r.started_at AND a.finished_at<=r.finished_at)
    AND NOT EXISTS(SELECT 1 FROM receipts p JOIN receipt_attempts a ON a.receipt_id=p.id
      WHERE p.service IN ('socialdata','xquik') AND p.subject='source:'||r.source_id AND a.origin='live'
        AND a.started_at>=r.started_at AND a.started_at<=r.finished_at)))`;
  const runs = await sql`SELECT r.status,count(*)::int AS runs,coalesce(sum(r.new_count),0)::int AS new_count
    FROM fetch_runs r JOIN sources s ON s.id=r.source_id
    WHERE ${birdRunProof} AND r.started_at>now()-interval '24 hours' GROUP BY r.status`;
  const latestFailedRuns = await sql`SELECT r.id,r.source_id,s.name,r.started_at,r.finished_at,r.error,
    CASE WHEN r.detail->>'provider'='bird' THEN 'recorded_provider' ELSE 'live_attempt_after_route_switch' END AS evidence,
    EXISTS(SELECT 1 FROM fetch_runs ok WHERE ok.source_id=r.source_id AND ok.status='ok'
      AND ok.detail->>'provider'='bird' AND ok.started_at>r.started_at) AS recovered
    FROM fetch_runs r JOIN sources s ON s.id=r.source_id
    WHERE r.status='failed' AND ${birdRunProof} AND r.started_at>now()-interval '24 hours'
    ORDER BY r.started_at DESC,r.id DESC LIMIT 10`;
  const [fleet] = await sql`SELECT count(*)::int AS enabled,
    count(*) FILTER(WHERE checked.success)::int AS succeeded,
    count(*) FILTER(WHERE NOT checked.success)::int AS awaiting_success,
    count(*) FILTER(WHERE s.cursor->'bird'->>'coverage'='partial')::int AS partial,
    count(*) FILTER(WHERE s.cursor->'bird'->>'coverage'='complete')::int AS complete
    FROM sources s CROSS JOIN LATERAL (SELECT EXISTS(SELECT 1 FROM fetch_runs r
      WHERE r.source_id=s.id AND r.status='ok' AND r.detail->>'provider'='bird'
        AND r.started_at>=coalesce((s.cursor->'xRouteHistory'->-1->>'capturedAt')::timestamptz,'epoch'::timestamptz)) AS success) checked
    WHERE s.enabled AND s.kind='x_search' AND s.config->>'provider'='bird'`;
  return { checkedAt: new Date().toISOString(), runtime, routes, budget, runs, fleet, latestFailedRuns };
}
async function enable() {
  const rows = await targets();
  const parsed = args.find(a=>a.startsWith("--interval="))?.slice(11);
  const interval = parsed ? Number(parsed) : args.includes("--all") ? 1440 : 120;
  if (!Number.isSafeInteger(interval) || interval < 120 || interval > 1440) throw new Error("Bird rollout interval must be 120–1440 minutes");
  const changes = [];
  for (const snapshot of rows) {
    const [row] = await sql<(SourceRow & { updated_at: Date })[]>`SELECT * FROM sources WHERE id=${snapshot.id} AND enabled AND kind='x_search'`;
    if (!row || JSON.stringify(row.config)!==JSON.stringify(snapshot.config)) throw new Error("Source route changed during rollout; review it before retrying");
    const nextConfig = { ...row.config, provider: "bird", _aihot: { ...row.config._aihot, initialBackfillLimit: 20 },
      bird: { ...row.config.bird, strategy: "user_tweets", initialLookbackHours: 48, maxPagesPerRound: 1,
        accountProfile: process.env.BIRD_ACCOUNT_PROFILE ?? "birdclaw-primary" } };
    if (!/^from:[A-Za-z0-9_]{1,15} -filter:replies$/i.test(String(nextConfig.query))) throw new Error("Bird rollout only supports plain account sources");
    const change = { id: row.id, fromProvider: row.config.provider ?? "socialdata", toProvider: "bird", intervalMinutes: interval };
    if (command === "enable") {
      const after = await updateSource(row.id, { version: new Date(row.updated_at).toISOString(),
        patch: { config: nextConfig, interval_minutes: interval }, reason: "授权的 Bird 渐进接入；保留来源身份和公共水位，归档供应商分页" }, actor);
      if (!after) throw new Error("Source changed during rollout");
    }
    changes.push(change);
  }
  return { applied: command === "enable", count: changes.length, changes };
}
async function fetch() {
  const rows = await targets();
  if (rows.some(r => r.config.provider !== "bird")) throw new Error("Enable only the reviewed Bird targets before fetching");
  const results = [];
  // One operator invocation is bounded; normal workers continue the remaining fleet.
  if (rows.length > 5) throw new Error("Manual Bird verification is limited to five source IDs per invocation");
  for (const row of rows) {
    const [capacity] = await sql<{ enabled: boolean; per_minute: number; per_hour: number; per_day: number; minute: number; hour: number; day: number; oldest_minute: Date | null }[]>`
      SELECT b.enabled,b.per_minute,b.per_hour,b.per_day,
        count(a.id) FILTER(WHERE a.started_at>now()-interval '1 minute')::int AS minute,
        count(a.id) FILTER(WHERE a.started_at>now()-interval '1 hour')::int AS hour,count(a.id)::int AS day,
        min(a.started_at) FILTER(WHERE a.started_at>now()-interval '1 minute') AS oldest_minute
      FROM budgets b LEFT JOIN receipt_attempts a ON a.service=b.service AND a.origin='live' AND a.started_at>now()-interval '24 hours'
      WHERE b.service='bird' GROUP BY b.enabled,b.per_minute,b.per_hour,b.per_day`;
    if (!capacity || (capacity.enabled && (capacity.per_minute<=0 || capacity.per_hour<=0 || capacity.per_day<=0
      || capacity.hour>=capacity.per_hour || capacity.day>=capacity.per_day))) {
      results.push({ sourceId: row.id, status: "deferred", reason: "bird_budget" });
      continue;
    }
    if (capacity.enabled && capacity.minute>=capacity.per_minute && capacity.oldest_minute) {
      const waitMs=Math.min(60_000,Math.max(1,capacity.oldest_minute.getTime()+60_250-Date.now()));
      console.log(JSON.stringify({ waitingForBudget: true, sourceId: row.id, waitMs }));
      await delay(waitMs);
    }
    const result=await collectSource(row.id, { force: true, expectedProvider: "bird" });
    results.push(result);
    console.log(JSON.stringify({ sourceCompleted: result }));
  }
  return { results };
}

try {
  let result: unknown;
  if (command === "check" || command === "status") result = await status();
  else if (command === "auth") {
    const checked = await birdWhoami({ subject: "corescope-bird-auth", window: new Date().toISOString() });
    await sql.begin(tx => completeReceipt(tx, checked.receiptId));
    result = { authenticated: true, receiptId: checked.receiptId, reused: checked.reused };
  } else if (command === "plan" || command === "enable") result = await enable();
  else if (command === "fetch") result = await fetch();
  else throw new Error("Use status, check, auth, plan, enable or fetch; optional --ids=... / --all / --interval=...");
  mkdirSync(path.join(config.dataDir, "bird"), { recursive: true });
  writeFileSync(path.join(config.dataDir, "bird", `operations-${command}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  const safe = error instanceof BirdConfigurationError || error instanceof BudgetExceededError || error instanceof ProviderRejectedError
    ? error.message : "Bird operation failed; check source configuration, status and admin receipts.";
  console.error(JSON.stringify({ ok: false, error: safe }));
  process.exitCode = 1;
} finally { await stopBoss(); await closeDb(); }
