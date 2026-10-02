// Explicit, bounded native re-analysis of already imported V2 material. No synthetic judgements.
// Historical report reconstruction preserves original times; generated_at remains the actual run.
import { analyzeArticle } from "@aihot/backend/editorial/analyze";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { publishArticle } from "@aihot/backend/publication/publish";
import { groupArticle } from "@aihot/backend/events/group";
import { composeStoryDigest } from "@aihot/backend/events/digest";
import { computeHotRanking } from "@aihot/backend/events/hot";
import { composeDaily } from "@aihot/backend/reports/compose";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { BudgetExceededError } from "@aihot/backend/providers/receipts";
import { setTimeout as pause } from "node:timers/promises";

const maxAt = process.argv.indexOf("--max");
const maximum = maxAt > 0 ? Number(process.argv[maxAt + 1]) : 20;
if (!Number.isInteger(maximum) || maximum < 1 || maximum > 40) throw new Error("--max must be 1..40");
if (!process.argv.includes("--analyze")) throw new Error("Use --analyze for explicitly authorized live native analysis (paid calls).");
const reportAt = process.argv.indexOf("--reconstruct-daily");
const reportDate = reportAt > 0 ? process.argv[reportAt + 1] : null;
const tagAt = process.argv.indexOf("--attempt-tag");
const attemptTag = tagAt > 0 ? process.argv[tagAt + 1] : undefined;
if (reportDate && !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error("Invalid reconstruction date");

async function budgeted<T>(work: () => Promise<T>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof BudgetExceededError) || error.retryAfterSeconds > 60 || retry >= 3) throw error;
      console.log(JSON.stringify({ stage: "budget-wait", seconds: error.retryAfterSeconds }));
      await pause(error.retryAfterSeconds * 1000 + 1000);
    }
  }
}

try {
  const rows = await sql`SELECT id, body_status, discovered_at FROM articles
    WHERE raw->'bridge'->>'client'='corescope-v2' ORDER BY discovered_at, id LIMIT ${maximum}`;
  for (const article of rows) {
    for (let budgetRetry = 0; budgetRetry < 4; budgetRetry++) try {
      if (article.body_status === "pending") await extractArticleBody(article.id);
      const result = await analyzeArticle(article.id, { attemptTag });
      // Historical V2 publications are imported using their original discovery time, explicitly.
      // Selection and every language/structure result still come from this native pipeline.
      if (result?.output && !result.stale) await publishArticle(article.id, reportDate ? { releasedAt: article.discovered_at } : {});
      console.log(JSON.stringify({ article: article.id, stage: "analysis", state: result?.output?.relevance ?? "waiting-body", selected: result?.output?.selected ?? false }));
      await pause(15_000);
      break;
    } catch (error) {
      if (error instanceof BudgetExceededError && error.retryAfterSeconds <= 60 && budgetRetry < 3) {
        console.log(JSON.stringify({ stage: "budget-wait", seconds: error.retryAfterSeconds }));
        await pause(error.retryAfterSeconds * 1000 + 1000);
        continue;
      }
      console.error(JSON.stringify({ article: article.id, stage: "analysis", error: error instanceof Error ? error.name : "Error" }));
      process.exitCode = 1;
      break;
    }
  }
  const eligible = await sql`SELECT a.id FROM articles a JOIN publications p ON p.article_id=a.id
    WHERE a.id=ANY(${rows.map((r) => r.id)}) AND p.visibility='public' AND p.eligible`;
  for (const article of eligible) {
    try {
      const result = await budgeted(() => groupArticle(article.id));
      console.log(JSON.stringify({ article: article.id, stage: "group", result }));
    } catch (error) {
      console.error(JSON.stringify({ article: article.id, stage: "group", error: error instanceof Error ? error.name : "Error" }));
      process.exitCode = 1;
    }
  }
  const stories = await sql`SELECT DISTINCT f.story_id FROM facts f JOIN publications p ON p.fact_id=f.id
    WHERE p.article_id = ANY(${rows.map((r) => r.id)}) AND p.visibility='public'`;
  for (const story of stories) {
    try { console.log(JSON.stringify({ story: story.story_id, stage: "digest", result: await budgeted(() => composeStoryDigest(story.story_id)) })); }
    catch (error) { console.error(JSON.stringify({ story: story.story_id, stage: "digest", error: error instanceof Error ? error.name : "Error" })); process.exitCode = 1; }
  }
  console.log(JSON.stringify({ stage: "hot", result: await computeHotRanking() }));
  if (reportDate) console.log(JSON.stringify({ stage: "report", result: await budgeted(() => composeDaily(reportDate, "corescope-initial-reconstruction")) }));
} finally { await stopBoss(); await closeDb(); }
