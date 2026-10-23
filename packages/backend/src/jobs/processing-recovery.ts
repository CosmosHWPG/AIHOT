// A fixed, audited exception to the rolling scope. It grants no provider budget or publication rights.
import { createHash } from "node:crypto";
import { z } from "zod";
import { audit } from "../audit.ts";
import { sql, type Db } from "../db.ts";
import { digestInputsHash, type DigestReport } from "../events/derived-content.ts";
import { storyReportCondition, listedCondition, evidenceCondition } from "../publication/scope.ts";

export const RECOVERY_BATCH_PREFIX = "content.processing-recovery.";
export const RECOVERY_PRIORITY = 9000; // Ordinary recent news always stays ahead (> 10,000).
const memberSchema = z.object({ articleId: z.string().min(1), revision: z.number().int().positive(),
  sourceId: z.string().min(1), sourceKind: z.string().min(1), mode: z.enum(["editorial", "hot_signal"]) }).strict();
const planSchema = z.object({ version: z.literal(1), id: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/),
  kind: z.enum(["bird-pending", "model-failure"]), createdAt: z.string(),
  evidence: z.string().min(1), members: z.array(memberSchema).min(1).max(118), digest: z.string() }).strict();
export type RecoveryMember = z.infer<typeof memberSchema>;
export type RecoveryPlan = z.infer<typeof planSchema>;
export interface RecoveryBatch extends RecoveryPlan {
  status: "active" | "revoked" | "complete";
  activatedAt: string;
  currentRevisions: Record<string, number>;
  retriedFailures: string[];
}
interface Article {
  id: string; revision: number; source_id: string; participation_mode: string; enabled: boolean;
  kind: string; bird: boolean; processing_state: string; processing_attempts: number;
  published_at: Date | null; future: boolean; historical: boolean; grouped_at: Date | null; relevance_pass: boolean;
}
export interface RecoveryStoryStatus {
  storyId: number; needsDigest: boolean; digestCurrent: boolean; latestDigestState: string | null;
  activeJobs: number; deferrals: number; unknownReceipts: number; missingHandoff: boolean; settled: boolean;
}
export interface RecoveryMemberStatus extends RecoveryMember {
  currentRevision: number; admission: string; state: string; attempts: number;
  needsEvent: boolean; groupingSettled: boolean; latestGroupState: string | null;
  activeJobs: number; deferrals: number; unknownReceipts: number; settled: boolean;
  stories: RecoveryStoryStatus[];
}

export function recoveryPlanDigest(plan: Pick<RecoveryPlan, "id" | "kind" | "evidence" | "members">): string {
  return createHash("sha256").update(JSON.stringify({ id: plan.id, kind: plan.kind, evidence: plan.evidence,
    members: [...plan.members].sort((a, b) => a.articleId.localeCompare(b.articleId)) })).digest("hex");
}
export function parseRecoveryPlan(value: unknown): RecoveryPlan {
  const plan = planSchema.parse(value);
  if (new Set(plan.members.map(m => m.articleId)).size !== plan.members.length) throw new Error("Duplicate recovery article ID");
  if (plan.kind === "model-failure" && plan.members.length > 3) throw new Error("Model failure recovery is limited to three fixed IDs");
  if (plan.digest !== recoveryPlanDigest(plan)) throw new Error("Recovery manifest digest mismatch");
  return plan;
}
async function readArticles(ids: string[], db: Db): Promise<Article[]> {
  return db<Article[]>`SELECT a.id,a.revision,a.source_id,s.participation_mode,s.enabled,s.kind,
    coalesce(a.x_post->>'provider','')='bird' AS bird,a.processing_state,a.processing_attempts,a.published_at,
    coalesce(a.published_at>now(),false) AS future,a.grouped_at,
    EXISTS(SELECT 1 FROM analyses n WHERE n.article_id=a.id AND n.input_revision=a.revision AND n.relevance='pass') AS relevance_pass,
    (a.backfill AND (a.published_at IS NULL OR a.discovered_at-a.published_at>interval '48 hours')) AS historical
    FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=ANY(${ids}::text[])`;
}
function match(member: RecoveryMember, revision: number, article?: Article): string {
  if (!article) return "missing";
  if (!article.enabled) return "disabled-source";
  if (article.participation_mode !== "editorial" && article.participation_mode !== "hot_signal") return "isolated";
  if (article.source_id !== member.sourceId) return "source-changed";
  if (article.kind !== member.sourceKind) return "source-kind-changed";
  if (article.participation_mode !== member.mode) return "mode-changed";
  if (article.revision !== revision) return "revision-changed";
  if (!article.published_at) return "unknown-publication";
  if (article.future) return "future-publication";
  return "admitted";
}
async function readBatches(db: Db, activeOnly = false): Promise<RecoveryBatch[]> {
  const rows = await db<{ value: RecoveryBatch }[]>`SELECT value FROM settings
    WHERE key LIKE ${RECOVERY_BATCH_PREFIX + "%"}
      AND (NOT ${activeOnly} OR value->>'status'='active') ORDER BY key`;
  return rows.map(r => r.value);
}
export async function activeRecoveryBatchIds(db: Db = sql): Promise<string[]> {
  return (await readBatches(db, true)).map(batch => batch.id);
}
export async function isRecoveryBatchMember(articleId: string, db: Db = sql): Promise<boolean> {
  return (await readBatches(db)).some(batch => batch.members.some(member => member.articleId === articleId));
}
export async function getRecoveryBatch(id: string, db: Db = sql): Promise<RecoveryBatch | null> {
  const [row] = await db<{ value: RecoveryBatch }[]>`SELECT value FROM settings WHERE key=${RECOVERY_BATCH_PREFIX + id}`;
  return row?.value ?? null;
}
async function save(batch: RecoveryBatch, actor: string, db: Db) {
  await db`INSERT INTO settings(key,value,updated_by) VALUES(${RECOVERY_BATCH_PREFIX + batch.id},${db.json(batch as never)},${actor})
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`;
}
/** Plan captures primary source and revision, never body text, responses or credentials. */
export async function planRecoveryBatch(input: { id: string; kind: RecoveryPlan["kind"]; articleIds: string[]; evidence: string }, db: Db = sql): Promise<RecoveryPlan> {
  if (new Set(input.articleIds).size !== input.articleIds.length) throw new Error("Duplicate recovery article ID");
  const rows = await readArticles(input.articleIds, db);
  const members = input.articleIds.map(articleId => {
    const row = rows.find(r => r.id === articleId);
    if (!row) throw new Error(`Recovery article missing: ${articleId}`);
    const member = memberSchema.parse({ articleId, revision: row.revision, sourceId: row.source_id, sourceKind: row.kind, mode: row.participation_mode });
    const admission = match(member, member.revision, row);
    if (admission !== "admitted") throw new Error(`Recovery article ${articleId}: ${admission}`);
    if (input.kind === "bird-pending" && (!row.bird || row.kind !== "x_search" || row.processing_state !== "new")) {
      throw new Error(`Recovery article ${articleId} is not pending Bird material`);
    }
    if (input.kind === "model-failure" && (!["rss", "external"].includes(row.kind) || row.processing_state !== "failed" || member.mode !== "editorial")) {
      throw new Error(`Recovery article ${articleId} is not a fixed failed editorial material`);
    }
    return member;
  });
  const plan = { version: 1 as const, id: input.id, kind: input.kind, createdAt: new Date().toISOString(), evidence: input.evidence, members };
  return parseRecoveryPlan({ ...plan, digest: recoveryPlanDigest(plan) });
}
/** Same id+digest is idempotent; a revoked/completed ID cannot be revived or silently expanded. */
export async function applyRecoveryBatch(value: unknown, actor: string, reason: string, db: Db = sql): Promise<RecoveryBatch> {
  const plan = parseRecoveryPlan(value);
  if (!reason.trim()) throw new Error("reason is required");
  const run = async (tx: Db) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${RECOVERY_BATCH_PREFIX}))`;
    const prior = await getRecoveryBatch(plan.id, tx);
    if (prior) {
      if (prior.digest !== plan.digest) throw new Error("Fixed recovery batch cannot be changed or expanded");
      if (prior.status !== "active") throw new Error("A stopped recovery batch cannot be reactivated");
      return prior;
    }
    const [policy] = await tx<{ value: { enabled?: boolean } }[]>`SELECT value FROM settings WHERE key='content.recent-processing'`;
    if (policy?.value.enabled !== true) throw new Error("The global 48h/2000 policy must remain enabled");
    await tx`SELECT id FROM sources WHERE id=ANY(${[...new Set(plan.members.map(m => m.sourceId))].sort()}::text[]) ORDER BY id FOR SHARE`;
    await tx`SELECT id FROM articles WHERE id=ANY(${plan.members.map(m => m.articleId).sort()}::text[]) ORDER BY id FOR UPDATE`;
    const rows = await readArticles(plan.members.map(m => m.articleId), tx);
    for (const member of plan.members) {
      const row = rows.find(r => r.id === member.articleId);
      const admission = match(member, member.revision, row);
      if (admission !== "admitted") throw new Error(`Recovery article ${member.articleId}: ${admission}`);
      if (plan.kind === "bird-pending" && (!row!.bird || row!.kind !== "x_search")) throw new Error("Bird provider evidence changed");
      if (plan.kind === "model-failure" && (!["rss", "external"].includes(row!.kind) || member.mode !== "editorial")) throw new Error("Failed editorial source changed");
    }
    const batch: RecoveryBatch = { ...plan, status: "active", activatedAt: new Date().toISOString(), currentRevisions: {}, retriedFailures: [] };
    await save(batch, actor, tx);
    await audit(actor, "content.processing-recovery.apply", `recovery:${plan.id}`, reason, null, batch, { db: tx });
    return batch;
  };
  return "begin" in db ? await (db as typeof sql).begin(run) : await run(db);
}
/** Every call reads settings anew: revoke works across API/worker processes without a stale cache. */
export async function getAdmittedRecoveryMembers(db: Db = sql): Promise<Array<RecoveryMember & { batchId: string }>> {
  const batches = await readBatches(db, true);
  if (!batches.length) return [];
  const rows = await readArticles([...new Set(batches.flatMap(b => b.members.map(m => m.articleId)))], db);
  return batches.flatMap(batch => batch.members.filter(member => match(member,
    batch.currentRevisions[member.articleId] ?? member.revision, rows.find(r => r.id === member.articleId)) === "admitted")
    .map(member => ({ ...member, revision: batch.currentRevisions[member.articleId] ?? member.revision, batchId: batch.id })));
}
export async function getRecoveryAdmission(articleId: string, db: Db = sql): Promise<{ batchId: string; priority: number } | null> {
  const candidates = (await readBatches(db, true)).filter(batch => batch.members.some(m => m.articleId === articleId));
  if (!candidates.length) return null;
  const [article] = await readArticles([articleId], db);
  const batch = candidates.find(batch => {
    const member = batch.members.find(m => m.articleId === articleId)!;
    return match(member, batch.currentRevisions[articleId] ?? member.revision, article) === "admitted";
  });
  return batch ? { batchId: batch.id, priority: RECOVERY_PRIORITY } : null;
}
/** Only official extraction calls this inside the transaction which created the exact next revision. */
export async function advanceRecoveryExtractionRevision(articleId: string, from: number, to: number, db: Db): Promise<void> {
  if (to !== from + 1) throw new Error("Extraction recovery revision must advance exactly once");
  const candidates = (await readBatches(db, true)).filter(b => b.members.some(m => m.articleId === articleId));
  for (const candidate of candidates) {
    const [locked] = await db<{ value: RecoveryBatch }[]>`SELECT value FROM settings WHERE key=${RECOVERY_BATCH_PREFIX + candidate.id} FOR UPDATE`;
    const batch = locked?.value;
    if (!batch || batch.status !== "active") continue;
    const member = batch.members.find(m => m.articleId === articleId)!;
    if ((batch.currentRevisions[articleId] ?? member.revision) !== from) continue;
    const [article] = await readArticles([articleId], db);
    if (match(member, to, article) !== "admitted") continue;
    const next = { ...batch, currentRevisions: { ...batch.currentRevisions, [articleId]: to } };
    await save(next, "content-extraction", db);
    await audit("content-extraction", "content.processing-recovery.extraction-revision", `recovery:${batch.id}`,
      "Official body extraction created the next revision of this fixed member", { articleId, revision: from }, { articleId, revision: to }, { db });
  }
}

/** One set of queue/receipt/deferral scans for the whole set, never one scan per member. */
async function statuses(batches: RecoveryBatch[], db: Db) {
  const ids = [...new Set(batches.flatMap(batch => batch.members.map(m => m.articleId)))];
  if (!ids.length) return [];
  const articles = await readArticles(ids, db);
  const now = new Date();
  // Discussion/mention membership grants no digest exception and inherits no unrelated story failure.
  const links = await db<{ article_id: string; story_id: number }[]>`SELECT DISTINCT fa.article_id,f.story_id FROM facts f
    JOIN fact_articles fa ON fa.fact_id=f.id JOIN publications p ON p.article_id=fa.article_id JOIN sources s ON s.id=p.source_id
    WHERE fa.article_id=ANY(${ids}::text[]) AND f.story_id IS NOT NULL AND s.participation_mode='editorial'
      AND fa.role IN('primary','report') AND ${storyReportCondition(now)} AND ${listedCondition(now)} AND ${evidenceCondition()}`;
  const storyIds = [...new Set(links.map(r => r.story_id))];
  const jobs = await db<{ id: string; name: string; state: string; article_id: string | null; story_id: string | null; verdict: string | null }[]>`
    SELECT id,name,state,data->>'articleId' AS article_id,data->>'storyId' AS story_id,output->>'verdict' AS verdict FROM pgboss.job
    WHERE (name IN('content.analyze','content.extract-body','events.group') AND data->>'articleId'=ANY(${ids}::text[]))
      OR (name='events.digest' AND data->>'storyId'=ANY(${storyIds.map(String)}::text[])) ORDER BY created_on DESC,id DESC`;
  const deferrals = await db<{ queue: string; article_id: string | null; story_id: string | null }[]>`SELECT queue,
    data->>'articleId' AS article_id,data->>'storyId' AS story_id FROM event_job_deferrals
    WHERE (queue='events.group' AND data->>'articleId'=ANY(${ids}::text[]))
      OR (queue='events.digest' AND data->>'storyId'=ANY(${storyIds.map(String)}::text[]))`;
  const unknowns = await db<{ article_id: string | null; story_id: string | null }[]>`SELECT
    substring(subject FROM '^article:([^@:#]+)') AS article_id,substring(subject FROM '^story:([0-9]+)') AS story_id
    FROM receipts WHERE status='unknown' AND (substring(subject FROM '^article:([^@:#]+)')=ANY(${ids}::text[])
      OR substring(subject FROM '^story:([0-9]+)')=ANY(${storyIds.map(String)}::text[]))`;
  const stories = await db<{ id: number; merged_into: number | null; digest: string | null; version: number;
    digest_version: number | null; article_ids: string[] | null; inputs_hash: string | null; context_article_ids: string[] | null }[]>`
    SELECT s.id,s.merged_into,s.digest,s.version,d.version AS digest_version,d.article_ids,d.inputs_hash,d.context_article_ids
    FROM stories s LEFT JOIN LATERAL(SELECT * FROM story_digests WHERE story_id=s.id ORDER BY version DESC LIMIT 1) d ON true
    WHERE s.id=ANY(${storyIds}::bigint[])`;
  const reports = await db<Array<DigestReport & { story_id: number }>>`SELECT DISTINCT ON(f.story_id,p.article_id)
    f.story_id,p.article_id AS id,p.title,p.summary,s.name AS source_name,p.first_party,coalesce(p.published_at,p.discovered_at) AS at
    FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id JOIN publications p ON p.article_id=fa.article_id JOIN sources s ON s.id=p.source_id
    WHERE f.story_id=ANY(${storyIds}::bigint[]) AND ${storyReportCondition(now)} AND ${listedCondition(now)} AND ${evidenceCondition()}
    ORDER BY f.story_id,p.article_id`;
  const active = (state: string) => ['created','retry','active'].includes(state);
  const storyStatuses: RecoveryStoryStatus[] = stories.map(story => {
    const currentReports = reports.filter(r => r.story_id === story.id);
    const known = new Set(story.article_ids ?? []);
    const previous = currentReports.filter(r => known.has(r.id));
    const digestCurrent = !!story.context_article_ids?.length && story.digest_version === story.version && !!story.digest
      && previous.length === known.size && digestInputsHash(previous) === story.inputs_hash
      && story.context_article_ids.every(id => known.has(id)) && digestInputsHash(currentReports) === story.inputs_hash;
    const relatedJobs = jobs.filter(j => j.name === 'events.digest' && j.story_id === String(story.id));
    const latestDigestState = relatedJobs[0]?.state ?? null;
    const activeJobs = relatedJobs.filter(j => active(j.state)).length;
    const deferred = deferrals.filter(d => d.queue === 'events.digest' && d.story_id === String(story.id)).length;
    const unknownReceipts = unknowns.filter(r => r.story_id === String(story.id)).length;
    const needsDigest = story.merged_into === null && currentReports.length > 0;
    return { storyId: story.id, needsDigest, digestCurrent, latestDigestState, activeJobs, deferrals: deferred, unknownReceipts,
      missingHandoff: needsDigest && !digestCurrent && !activeJobs && !deferred && !unknownReceipts && latestDigestState !== 'failed',
      settled: (!needsDigest || digestCurrent) && !activeJobs && !deferred && !unknownReceipts && latestDigestState !== 'failed' };
  });
  return batches.map(batch => {
    const members: RecoveryMemberStatus[] = batch.members.map(member => {
      const article = articles.find(a => a.id === member.articleId);
      const currentRevision = batch.currentRevisions[member.articleId] ?? member.revision;
      const admission = match(member, currentRevision, article);
      const ownJobs = jobs.filter(j => j.article_id === member.articleId && j.name !== 'events.digest');
      const group = ownJobs.find(j => j.name === 'events.group');
      const memberStories = storyStatuses.filter(story => links.some(link => link.article_id === member.articleId && link.story_id === story.storyId));
      const activeJobs = ownJobs.filter(j => active(j.state)).length + memberStories.reduce((n,s) => n+s.activeJobs,0);
      const deferred = deferrals.filter(d => d.queue === 'events.group' && d.article_id === member.articleId).length + memberStories.reduce((n,s) => n+s.deferrals,0);
      const unknownReceipts = unknowns.filter(r => r.article_id === member.articleId).length + memberStories.reduce((n,s) => n+s.unknownReceipts,0);
      const needsEvent = !!article && !article.historical && (member.mode === 'hot_signal' || article.relevance_pass);
      const groupingSettled = !needsEvent || !!article?.grouped_at || (group?.state === 'completed' && !!group.verdict);
      const settled = admission === 'admitted' && !!article && ['analyzed','skipped','blocked'].includes(article.processing_state)
        && groupingSettled && !activeJobs && !deferred && !unknownReceipts && group?.state !== 'failed' && memberStories.every(s => s.settled);
      return { ...member, currentRevision, admission, state: article?.processing_state ?? 'missing', attempts: article?.processing_attempts ?? 0,
        needsEvent, groupingSettled, latestGroupState: group?.state ?? null, activeJobs, deferrals: deferred, unknownReceipts, stories: memberStories, settled };
    });
    const memberIds = new Set(members.map(m => m.articleId));
    const memberStoryIds = new Set(members.flatMap(m => m.stories.map(s => String(s.storyId))));
    return { batch, members, completeable: members.every(m => m.settled), counts: { members: members.length,
      settled: members.filter(m => m.settled).length, drifted: members.filter(m => m.admission !== 'admitted').length,
      failed: members.filter(m => m.state === 'failed' || m.latestGroupState === 'failed' || m.stories.some(s => s.latestDigestState === 'failed')).length,
      activeJobs: jobs.filter(j => active(j.state) && (memberIds.has(j.article_id ?? '') || (j.name === 'events.digest' && memberStoryIds.has(j.story_id ?? '')))).length,
      deferrals: deferrals.filter(d => memberIds.has(d.article_id ?? '') || (d.queue === 'events.digest' && memberStoryIds.has(d.story_id ?? ''))).length } };
  });
}
export async function recoveryBatchStatus(id: string, db: Db = sql) {
  const batch = await getRecoveryBatch(id, db);
  return batch ? (await statuses([batch], db))[0]! : null;
}
export async function activeRecoveryBatchStatuses(db: Db = sql) {
  return statuses(await readBatches(db, true), db);
}
export async function stopRecoveryBatch(id: string, state: "revoked" | "complete", actor: string, reason: string, db: Db = sql) {
  if (!reason.trim()) throw new Error("reason is required");
  const run = async (tx: Db) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${RECOVERY_BATCH_PREFIX}))`;
    const [locked] = await tx<{ value: RecoveryBatch }[]>`SELECT value FROM settings WHERE key=${RECOVERY_BATCH_PREFIX + id} FOR UPDATE`;
    const prior = locked?.value;
    if (!prior) throw new Error("Recovery batch not found");
    if (prior.status === state) return prior;
    if (prior.status !== "active") throw new Error("Recovery batch is already stopped");
    const status = await recoveryBatchStatus(id, tx);
    if (state === "complete" && !status?.completeable) throw new Error("Recovery batch still has unsettled material, jobs, deferrals or failures");
    const next = { ...prior, status: state };
    await save(next, actor, tx);
    await audit(actor, `content.processing-recovery.${state}`, `recovery:${id}`, reason, prior, next, { db: tx });
    return next;
  };
  return "begin" in db ? await (db as typeof sql).begin(run) : await run(db);
}

/** A single explicit repair phase for the fixed (at most three) editorial failures, not a re-evaluation. */
export async function retryRecoveryFailures(id: string, articleIds: string[], actor: string, reason: string,
  queue: (articleId: string, db: Db) => Promise<string | null>, db: Db = sql) {
  if (!reason.trim()) throw new Error("reason is required");
  if (!articleIds.length || articleIds.length > 3 || new Set(articleIds).size !== articleIds.length) throw new Error("Specify one to three unique fixed repair IDs");
  const run = async (tx: Db) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${RECOVERY_BATCH_PREFIX}))`;
    const initial = await getRecoveryBatch(id, tx);
    if (!initial || initial.status !== "active" || initial.kind !== "model-failure") throw new Error("Active fixed model-failure batch required");
    if (articleIds.some(articleId => !initial.members.some(m => m.articleId === articleId))) throw new Error("Repair ID is outside the fixed failure batch");
    await tx`SELECT id FROM sources WHERE id=ANY(${initial.members.map(m => m.sourceId).sort()}::text[]) ORDER BY id FOR SHARE`;
    await tx`SELECT id FROM articles WHERE id=ANY(${articleIds.sort()}::text[]) ORDER BY id FOR UPDATE`;
    const [locked] = await tx<{ value: RecoveryBatch }[]>`SELECT value FROM settings WHERE key=${RECOVERY_BATCH_PREFIX + id} FOR UPDATE`;
    const batch = locked!.value;
    if (batch.status !== "active") throw new Error("Recovery batch was stopped");
    const rows = await readArticles(articleIds, tx);
    const retried: string[] = [];
    for (const articleId of articleIds) {
      if (batch.retriedFailures.includes(articleId)) continue;
      const member = batch.members.find(m => m.articleId === articleId)!;
      const row = rows.find(a => a.id === articleId);
      if (match(member, batch.currentRevisions[articleId] ?? member.revision, row) !== "admitted" || row?.processing_state !== "failed") throw new Error("Repair material changed or is no longer failed");
      const [held] = await tx<{ blocked: boolean }[]>`SELECT
        EXISTS(SELECT 1 FROM receipts r WHERE r.status IN('unknown','pending') AND
          (r.subject=${'article:' + articleId} OR r.subject LIKE ${'article:' + articleId + '@%'}))
        OR EXISTS(SELECT 1 FROM pgboss.job j WHERE j.state IN('created','retry','active')
          AND j.name IN('content.analyze','content.extract-body','events.group') AND j.data->>'articleId'=${articleId}) AS blocked`;
      if (held.blocked) throw new Error("Repair is blocked by an unresolved receipt or active queue job");
      await tx`UPDATE articles SET processing_state='new',processing_attempts=0,processing_retry_at=NULL,processing_queued_at=NULL
        WHERE id=${articleId} AND revision=${row.revision}`;
      const jobId = await queue(articleId, tx);
      if (!jobId) throw new Error("Repair did not enter the normal processing queue");
      await audit(actor, "content.processing-recovery.retry-failed", `content:${articleId}`, reason,
        { batchId: id, revision: row.revision, state: row.processing_state, attempts: row.processing_attempts },
        { batchId: id, revision: row.revision, state: "new", attempts: 0, jobId, originalPaidIdentityRetained: true }, { db: tx });
      retried.push(articleId);
    }
    const next = { ...batch, retriedFailures: [...batch.retriedFailures, ...retried] };
    await save(next, actor, tx);
    return { id, retried, alreadyRetried: articleIds.filter(articleId => !retried.includes(articleId)) };
  };
  return "begin" in db ? await (db as typeof sql).begin(run) : await run(db);
}
