// Local, audited controls for the bounded news-processing policy. No new collector or model caller.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { getRecentContentPolicy, getRecentContentScope, reprioritizeRecentContentJobs, setRecentContentPolicy } from "@aihot/backend/jobs/recent-content";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { activateTemporaryLlmBudget, restoreExpiredLlmBudget, temporaryLlmBudgetStatus } from "@aihot/backend/providers/temporary-budget";

const address = new URL(config.databaseUrl);
if (!["localhost", "127.0.0.1"].includes(address.hostname) || address.port !== "5448" || address.pathname !== "/corescope") {
  throw new Error("Processing operations require the independent local CoreScope database on port 5448.");
}
const actor = "corescope-processing-operations";
const output = path.join(config.dataDir, "qa/newest48h-2000");

async function snapshot() {
  const policy = await getRecentContentPolicy();
  const scope = await getRecentContentScope({ fresh: true });
  const rows = await sql`SELECT a.id,a.source_id,s.name AS source_name,s.participation_mode,a.title,a.url,a.published_at,
    a.processing_state,a.body_status,a.processing_error,a.processing_retry_at,p.visibility,p.eligible,p.selected,p.visible_after
    FROM articles a JOIN sources s ON s.id=a.source_id LEFT JOIN publications p ON p.article_id=a.id
    WHERE a.id=ANY(${scope.rows.map(r => r.id)}::text[]) ORDER BY a.published_at DESC,a.id DESC`;
  const [usage] = await sql`SELECT count(*) FILTER(WHERE started_at>now()-interval '1 minute')::int AS minute,
    count(*) FILTER(WHERE started_at>now()-interval '1 hour')::int AS hour,count(*)::int AS day
    FROM receipt_attempts WHERE service='llm' AND origin='live' AND started_at>now()-interval '1 day'`;
  const purposes = await sql`SELECT r.purpose,a.model,count(*)::int AS attempts FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id
    WHERE a.service='llm' AND a.origin='live' AND a.started_at>now()-interval '1 day' GROUP BY r.purpose,a.model ORDER BY attempts DESC`;
  const [publicCounts] = await sql`SELECT
    count(*) FILTER(WHERE p.visibility='public' AND p.eligible)::int AS public,
    count(*) FILTER(WHERE p.visibility='public' AND p.eligible AND p.selected AND p.visible_after<=now())::int AS selected
    FROM articles a JOIN publications p ON p.article_id=a.id WHERE a.id=ANY(${scope.rows.map(r => r.id)}::text[])`;
  const [hot] = await sql`SELECT id,computed_at,jsonb_array_length(entries)::int AS entries FROM hot_rankings WHERE published ORDER BY id DESC LIMIT 1`;
  const temporary = await temporaryLlmBudgetStatus();
  const [temporaryUsage] = temporary.lease?.status === "active" ? await sql`SELECT count(*)::int AS attempts,
    greatest(0,1200-count(*))::int AS remaining FROM receipt_attempts WHERE service='llm' AND origin='live'
      AND started_at>=${temporary.lease.activatedAt}::timestamptz` : [];
  const states: Record<string,number> = {};
  for (const row of rows) {
    const key = `${row.participation_mode}:${row.processing_state}`;
    states[key] = (states[key] ?? 0) + 1;
  }
  const result = { checkedAt: new Date().toISOString(), policy, at:scope.at, cutoff:scope.cutoff, count:rows.length,
    states, publicCounts, hot, budget:temporary, temporaryUsage, usage, purposes, rows };
  await mkdir(output, { recursive:true });
  await writeFile(path.join(output,"runtime-latest.json"),JSON.stringify(result,null,2));
  const columns = ["id","source_id","source_name","participation_mode","published_at","processing_state","body_status","eligible","selected","url"];
  const csvCell = (value:unknown) => `"${String(value instanceof Date ? value.toISOString() : value ?? "").replaceAll('"','""')}"`;
  await writeFile(path.join(output,"runtime-latest.csv"),"\uFEFF"+columns.join(",")+"\n"+
    rows.map(row => columns.map(column => csvCell(row[column])).join(",")).join("\n")+"\n");
  return result;
}

/** Only quota waits are woken; genuine failures, unknown receipts and retry identities stay intact. */
async function wakeAvailableCapacity() {
  return sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('budget:llm'))`;
    const [budget] = await tx`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='llm'`;
    const [used] = await tx`SELECT count(*) FILTER(WHERE started_at>now()-interval '1 minute')::int AS minute,
      count(*) FILTER(WHERE started_at>now()-interval '1 hour')::int AS hour,count(*)::int AS day
      FROM receipt_attempts WHERE service='llm' AND origin='live' AND started_at>now()-interval '1 day'`;
    if (!budget || used.minute>=budget.per_minute || used.hour>=budget.per_hour || used.day>=budget.per_day) return { articles:0,events:0 };
    const scope = await getRecentContentScope({db:tx,fresh:true});
    const articles = await tx`UPDATE articles SET processing_retry_at=now(),processing_queued_at=NULL
      WHERE id=ANY(${scope.rows.map(r => r.id)}::text[]) AND processing_state='new'
        AND processing_error ~ '^(extract: )?Budget for llm exhausted [(](minute|hour|day)[)]$' RETURNING id`;
    const events = await tx`UPDATE event_job_deferrals SET retry_at=now(),updated_at=now()
      WHERE reason ~ '^Budget for llm exhausted [(](minute|hour|day)[)]$' RETURNING singleton_key`;
    await audit(actor,"content.capacity-wake","content:recent-processing","Capacity available after authorized temporary quota increase",
      null,{ articles:articles.length,events:events.length },{ db:tx });
    return { articles:articles.length,events:events.length };
  });
}

async function start() {
  await setRecentContentPolicy(true,actor,"User requested newest-first processing of the latest 2000 news/heat materials published within 48 hours");
  let temporaryBudget = null;
  if (process.argv.includes("--temporary-llm=2000")) {
    // This option is explicit: regular startups never grant additional paid requests.
    temporaryBudget = await activateTemporaryLlmBudget(actor,"User explicitly authorized 800 to 2000 rolling-24h requests for 24 hours; retain 20/min and 180/hour");
  }
  const awakened = await wakeAvailableCapacity();
  const reordered = await reprioritizeRecentContentJobs();
  const scope = await getRecentContentScope({fresh:true});
  const rows = await sql<{id:string}[]>`SELECT a.id FROM articles a
    WHERE a.id=ANY(${scope.rows.map(r => r.id)}::text[]) AND a.processing_state='new'
      AND (a.processing_retry_at IS NULL OR a.processing_retry_at<=now())
      AND NOT EXISTS(SELECT 1 FROM pgboss.job j WHERE j.name IN('content.analyze','content.extract-body','events.group')
        AND j.state IN('created','retry','active') AND j.data->>'articleId'=a.id)
    ORDER BY a.published_at DESC,a.id DESC`;
  let enqueued=0;
  for (const row of rows) if (await queueProcessing(row.id)) enqueued++;
  const result = { startedAt:new Date().toISOString(),temporaryBudget,awakened,reordered,enqueued,
    automaticWorker:true,collectorStarted:false,selectionRulesChanged:false };
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,"start-result.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
}

try {
  const command=process.argv[2] ?? "status";
  if (command==="start") await start();
  else if (command==="status" || command==="plan") {
    const {rows,...summary}=await snapshot();
    console.log(JSON.stringify(summary));
  } else if (command==="restore-expired") console.log(JSON.stringify(await restoreExpiredLlmBudget()));
  else if (command==="disable") {
    await setRecentContentPolicy(false,actor,"Operator restored the previous content processing scope");
    console.log(JSON.stringify(await reprioritizeRecentContentJobs()));
  } else throw new Error("Use plan, status, start [--temporary-llm=2000], disable or restore-expired");
} finally { await stopBoss(); await closeDb(); }
