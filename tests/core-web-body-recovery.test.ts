import { pointModels, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { processArticle, queueProcessing } from "@aihot/backend/jobs/content";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { selectionThreshold } from "@aihot/backend/editorial/analyze";
import { groupArticle } from "@aihot/backend/events/group";
import { analysisStep } from "./analysis-steps.ts";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { getRecentContentPolicy, getRecentContentPriority, invalidateRecentContentCache,
  RECENT_CONTENT_POLICY_KEY, setRecentContentPolicy } from "@aihot/backend/jobs/recent-content";
import { advanceRecoveryExtractionRevision, applyRecoveryBatch, getAdmittedRecoveryMembers, getRecoveryAdmission,
  getRecoveryBatch, parseRecoveryPlan, planRecoveryBatch, recoveryPlanDigest, RECOVERY_BATCH_PREFIX,
  RECOVERY_PRIORITY, recoveryBatchStatus, stopRecoveryBatch, type RecoveryPlan } from "@aihot/backend/jobs/processing-recovery";

const prefix = `web-body-${tag()}`;
const sources = Object.fromEntries(["rss", "web_list", "json_list", "external", "x_search"].map(kind => [kind, `${prefix}-${kind}`]));
const ids: string[] = [];
const batchIds: string[] = [];
let savedPolicy: Array<{ value: unknown; updated_by: string | null; updated_at: Date }> = [];

before(async () => {
  savedPolicy = await sql`SELECT value,updated_by,updated_at FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  await getBoss();
  for (const [kind, id] of Object.entries(sources)) await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES(${id},'Offline web body fixture',${kind},'T1','editorial','2100-01-01')`;
});
afterEach(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=ANY(${ids}::text[])`;
  await sql`DELETE FROM settings WHERE key=ANY(${batchIds.map(id => RECOVERY_BATCH_PREFIX + id)}::text[])`;
  await sql`DELETE FROM articles WHERE source_id=ANY(${Object.values(sources)}::text[])`;
  await sql`UPDATE sources SET enabled=true,participation_mode='editorial',config='{}'::jsonb WHERE id=ANY(${Object.values(sources)}::text[])`;
  ids.length = 0;
  batchIds.length = 0;
  invalidateRecentContentCache();
});
after(async () => {
  await sql`DELETE FROM sources WHERE id=ANY(${Object.values(sources)}::text[])`;
  await sql`DELETE FROM settings WHERE key=${RECENT_CONTENT_POLICY_KEY}`;
  for (const row of savedPolicy) await sql`INSERT INTO settings(key,value,updated_by,updated_at)
    VALUES(${RECENT_CONTENT_POLICY_KEY},${sql.json(row.value as never)},${row.updated_by},${row.updated_at})`;
  await stopBoss();
  await closeDb();
});
async function article(name: string, options: { kind?: string; state?: string; body?: string; url?: string; at?: Date | null } = {}) {
  const id = `${prefix}-${name}`;
  const kind = options.kind ?? "rss";
  ids.push(id);
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,body_status,processing_state,published_at,discovered_at,timeline_at,x_post)
    VALUES(${id},${sources[kind]},${id},${options.url ?? 'https://www.example.com/' + id},'Offline web body fixture',
      ${options.body ?? 'unconfirmed'},${options.state ?? 'new'},${options.at === undefined ? new Date(Date.now() - 60 * 60_000) : options.at},
      now()-interval '1 second',now()-interval '1 second',${kind === 'x_search' ? sql.json({ provider: 'bird', tweetId: '12345', text: 'offline fixture' }) : null})`;
  return id;
}
function plan(name: string, articleIds: string[], kind: RecoveryPlan["kind"] = "web-body-recovery", windowAt?: string) {
  const id = `${prefix}-${name}`;
  batchIds.push(id);
  return planRecoveryBatch({ id, kind, articleIds, evidence: "Fixed offline public webpage manifest", windowAt });
}
async function activate(name: string, articleIds: string[], kind: RecoveryPlan["kind"] = "web-body-recovery") {
  await setRecentContentPolicy(true, "test", "Preserve global 48h/latest2000 gates");
  const result = await plan(name, articleIds, kind);
  await applyRecoveryBatch(result, "test", "Explicit fixed body recovery");
  return result;
}

test("a fixed recent webpage outside latest2000 gets only the lower priority formal queue exception", async () => {
  const id = await article("outside2000");
  const other = await article("not-approved");
  const newest = await article("normal-news", { at: new Date(Date.now() - 5_000) });
  await setRecentContentPolicy(true, "test", "Preserve the ordinary rolling scope");
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,processing_state)
    SELECT ${prefix + '-filler-'}||g,${sources.rss},${prefix + '-filler-'}||g,'https://www.example.com/filler/'||g,'Offline filler',
      now()-interval '1 minute',now(),now(),'blocked' FROM generate_series(1,2000) g`;
  invalidateRecentContentCache();
  assert.equal((await getRecentContentPriority(id)).reason, "outside-latest-2000");
  const result = await activate("outside-plan", [id]);
  assert.equal((await getRecentContentPriority(id)).reason, "fixed-recovery-batch");
  assert.equal((await getRecentContentPriority(id)).priority, RECOVERY_PRIORITY);
  assert.ok((await getRecentContentPriority(newest)).priority! > RECOVERY_PRIORITY);
  assert.equal(await getRecoveryAdmission(other), null);
  assert.equal(await queueProcessing(other, { step: "extract" }), null);
  const job = await queueProcessing(id, { step: "extract" });
  assert.ok(job);
  const [queued] = await sql`SELECT name,data,priority FROM pgboss.job WHERE id=${job}`;
  assert.equal(queued.name, "content.extract-body");
  assert.deepEqual(queued.data, { articleId: id });
  assert.equal(queued.priority, 9000);
  const policy = await getRecentContentPolicy();
  assert.equal(policy.enabled, true);
  assert.equal(policy.windowHours, 48);
  assert.equal(policy.maxRecords, 2000);
  assert.equal(result.members[0].initialBodyStatus, "unconfirmed");
  assert.equal(result.windowAt, result.createdAt);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts WHERE subject LIKE ${'article:' + id + '%'}`)[0].n, 0);
});

test("only enabled editorial webpages in initial new/analyzed/failed unconfirmed states can be planned", async () => {
  for (const state of ["new", "analyzed", "failed"]) {
    for (const kind of ["rss", "web_list", "json_list", "external"]) {
      const id = await article(`${kind}-${state}`, { kind, state });
      const result = await plan(`accept-${kind}-${state}`, [id]);
      assert.equal(result.members[0].initialProcessingState, state);
      assert.equal(result.members[0].sourceKind, kind);
    }
  }
  for (const state of ["blocked", "skipped"]) {
    const id = await article(state, { state });
    await assert.rejects(plan(`reject-${state}`, [id]), /initial recent unconfirmed/);
  }
  for (const body of ["pending", "ok", "none"]) {
    const id = await article(body, { body });
    await assert.rejects(plan(`reject-${body}`, [id]), /initial recent unconfirmed/);
  }
  const x = await article("x", { kind: "x_search" });
  await assert.rejects(plan("reject-x-kind", [x]), /initial recent unconfirmed/);
  const id = await article("source-guards");
  await sql`UPDATE sources SET enabled=false WHERE id=${sources.rss}`;
  await assert.rejects(plan("disabled", [id]), /disabled-source/);
  await sql`UPDATE sources SET enabled=true,participation_mode='hot_signal' WHERE id=${sources.rss}`;
  await assert.rejects(plan("signal", [id]), /initial recent unconfirmed/);
  await sql`UPDATE sources SET participation_mode='isolated' WHERE id=${sources.rss}`;
  await assert.rejects(plan("isolated", [id]), /initial recent unconfirmed/);
});

test("planning refuses old/future/unknown dates and nonpublic, credential or X/WeChat URLs", async () => {
  for (const [name, at] of [["old", new Date(Date.now() - 49 * 60 * 60_000)],
    ["future", new Date(Date.now() + 60_000)], ["unknown", null]] as const) {
    const id = await article(name, { at });
    await assert.rejects(plan(`reject-${name}`, [id]), /initial recent unconfirmed/);
  }
  const rejected = ["ftp://example.com/article", "https://user:pass@example.com/article", "https://example.com/?api_key=private",
    "https://example.com/?access_token=private", "https://example.com/?sig=private", "https://example.com/?client_secret=private",
    "http://127.0.0.1/article", "http://[::1]/article", "http://10.1.2.3/article",
    "https://localhost/article", "https://news.internal/article", "https://news.invalid/article", "https://intranet/article",
    "https://x.com/account/status/123", "https://x.com../account/status/123", "https://sub.twitter.com/account/status/123", "https://mp.weixin.qq.com/s/article"];
  for (const [index, url] of rejected.entries()) {
    const id = await article(`url-${index}`, { url });
    await assert.rejects(plan(`reject-url-${index}`, [id]), /initial recent unconfirmed/);
  }
});

test("new manifests freeze URL/config/time/initial state and a 30-minute activation window", async () => {
  const id = await article("frozen");
  await setRecentContentPolicy(true, "test", "Bounded recovery only");
  const result = await plan("frozen-plan", [id]);
  const member = result.members[0];
  assert.equal(member.url, 'https://www.example.com/' + id);
  assert.match(member.sourceConfigMd5!, /^[a-f0-9]{32}$/);
  assert.match(member.publishedAt!, /\.\d{6}Z$/);
  const noUrl = { ...result, members: [{ ...member, url: undefined }] };
  assert.throws(() => parseRecoveryPlan({ ...noUrl, digest: recoveryPlanDigest(noUrl) }), /requires fixed public editorial identity/);
  assert.notEqual(recoveryPlanDigest({ ...result, createdAt: new Date(Date.now() - 60_000).toISOString() }), result.digest);
  await sql`UPDATE articles SET url='https://www.example.com/changed' WHERE id=${id}`;
  await assert.rejects(applyRecoveryBatch(result, "test", "URL drift"), /url-changed/);
  await sql`UPDATE articles SET url=${member.url!} WHERE id=${id}`;
  await sql`UPDATE sources SET config='{"parseMode":"html"}'::jsonb WHERE id=${sources.rss}`;
  await assert.rejects(applyRecoveryBatch(result, "test", "Source config drift"), /source-config-changed/);
  await sql`UPDATE sources SET config='{}'::jsonb WHERE id=${sources.rss}`;
  await sql`UPDATE articles SET published_at=published_at+interval '1 microsecond' WHERE id=${id}`;
  await assert.rejects(applyRecoveryBatch(result, "test", "Publication microsecond drift"), /publication-changed/);
  await sql`UPDATE articles SET published_at=${member.publishedAt!}::timestamptz,processing_state='analyzed' WHERE id=${id}`;
  await assert.rejects(applyRecoveryBatch(result, "test", "Initial state drift"), /initial state/);
  await sql`UPDATE articles SET processing_state='new',body_status='pending' WHERE id=${id}`;
  await assert.rejects(applyRecoveryBatch(result, "test", "Initial body drift"), /initial state/);
  await sql`UPDATE articles SET body_status='unconfirmed' WHERE id=${id}`;
  const expiredAt = new Date(Date.now() - 31 * 60_000).toISOString();
  const expired = { ...result, createdAt: expiredAt, windowAt: expiredAt };
  await assert.rejects(applyRecoveryBatch({ ...expired, digest: recoveryPlanDigest(expired) }, "test", "Expired plan"), /activation expired/);
  const futureAt = new Date(Date.now() + 60_000).toISOString();
  const future = { ...result, createdAt: futureAt, windowAt: futureAt };
  await assert.rejects(applyRecoveryBatch({ ...future, digest: recoveryPlanDigest(future) }, "test", "Future plan"), /activation expired/);
  await applyRecoveryBatch(result, "test", "Original frozen plan");
  await applyRecoveryBatch(result, "test", "Idempotent original plan");
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='content.processing-recovery.apply' AND subject=${'recovery:' + result.id}`)[0].n, 1);
});

test("a fixed request window survives aging past dynamic48h but cannot anchor arbitrary history", async () => {
  const requestAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const id = await article("frozen-window", { at: new Date(Date.now() - (48 * 60 + 5) * 60_000) });
  await setRecentContentPolicy(true, "test", "Preserve the rolling scope with a narrow request snapshot");
  await assert.rejects(plan("dynamic-too-old", [id]), /initial recent unconfirmed/);
  const result = await plan("request-window", [id], "web-body-recovery", requestAt);
  assert.equal(result.windowAt, requestAt);
  assert.equal((await getRecentContentPriority(id)).reason, "outside-window");
  assert.notEqual(recoveryPlanDigest({ ...result, windowAt: result.createdAt }), result.digest);
  assert.throws(() => parseRecoveryPlan({ ...result, windowAt: undefined }), /window anchor/);
  await applyRecoveryBatch(result, "test", "User approved this fixed recent request window");
  assert.equal((await getRecentContentPriority(id)).reason, "fixed-recovery-batch");
  assert.equal((await getRecentContentPolicy()).enabled, true);
  const tooOld = new Date(Date.now() - 31 * 60_000).toISOString();
  await assert.rejects(plan("old-request-anchor", [id], "web-body-recovery", tooOld), /window anchor/);
  const future = new Date(Date.now() + 60_000).toISOString();
  await assert.rejects(plan("future-request-anchor", [id], "web-body-recovery", future), /window anchor/);
  const forged = { ...result, id: `${prefix}-forged-anchor`, windowAt: tooOld };
  await assert.rejects(applyRecoveryBatch({ ...forged, digest: recoveryPlanDigest(forged) }, "test", "Invalid old anchor"), /window anchor/);
});

test("active admission permits formal state transitions but continually refuses identity drift", async () => {
  const id = await article("ongoing", { state: "failed" });
  const result = await activate("ongoing-plan", [id]);
  const member = result.members[0];
  await sql`UPDATE articles SET body_status='pending',processing_state='new' WHERE id=${id}`;
  assert.ok(await getRecoveryAdmission(id));
  await sql`UPDATE articles SET body_status='ok',processing_state='analyzed' WHERE id=${id}`;
  assert.ok(await getRecoveryAdmission(id));
  await sql`UPDATE articles SET url='https://www.example.com/drift' WHERE id=${id}`;
  assert.equal(await getRecoveryAdmission(id), null);
  assert.equal((await getAdmittedRecoveryMembers()).some(m => m.articleId === id), false);
  await sql`UPDATE articles SET url=${member.url!} WHERE id=${id}`;
  await sql`UPDATE sources SET config='{"cacheToleranceSeconds":60}'::jsonb WHERE id=${sources.rss}`;
  assert.equal(await getRecoveryAdmission(id), null);
  await sql`UPDATE sources SET config='{}'::jsonb WHERE id=${sources.rss}`;
  await sql`UPDATE articles SET published_at=published_at+interval '1 microsecond' WHERE id=${id}`;
  assert.equal(await getRecoveryAdmission(id), null);
  await sql`UPDATE articles SET published_at=${member.publishedAt!}::timestamptz WHERE id=${id}`;
  await sql`UPDATE sources SET enabled=false WHERE id=${sources.rss}`;
  assert.equal(await getRecoveryAdmission(id), null);
  await sql`UPDATE sources SET enabled=true,participation_mode='hot_signal' WHERE id=${sources.rss}`;
  assert.equal(await getRecoveryAdmission(id), null);
  await sql`UPDATE sources SET participation_mode='editorial' WHERE id=${sources.rss}`;
  await sql`UPDATE articles SET source_id=${sources.external} WHERE id=${id}`;
  assert.equal(await getRecoveryAdmission(id), null);
  await sql`UPDATE articles SET source_id=${sources.rss} WHERE id=${id}`;
  assert.ok(await getRecoveryAdmission(id));
});

test("only the exact next official extraction transaction carries the frozen member revision", async () => {
  const id = await article("revision", { state: "analyzed" });
  const result = await activate("revision-plan", [id]);
  await assert.rejects(advanceRecoveryExtractionRevision(id, 1, 3, sql), /advance exactly once/);
  await assert.rejects(sql.begin(async tx => {
    await tx`UPDATE articles SET revision=2,body_status='ok',processing_state='new' WHERE id=${id}`;
    await advanceRecoveryExtractionRevision(id, 1, 2, tx);
    throw new Error("rollback official extraction");
  }), /rollback official extraction/);
  assert.equal((await getRecoveryBatch(result.id))!.currentRevisions[id], undefined);
  await sql.begin(async tx => {
    await tx`UPDATE articles SET revision=2,body_status='ok',processing_state='new' WHERE id=${id}`;
    await advanceRecoveryExtractionRevision(id, 1, 2, tx);
  });
  const batch = (await getRecoveryBatch(result.id))!;
  assert.equal(batch.members[0].revision, 1);
  assert.equal(batch.currentRevisions[id], 2);
  assert.equal(batch.members[0].publishedAt, result.members[0].publishedAt);
  assert.ok(await getRecoveryAdmission(id));
  assert.equal((await sql`SELECT count(*)::int AS n FROM audit_log WHERE action='content.processing-recovery.extraction-revision' AND subject=${'recovery:' + result.id}`)[0].n, 1);
  await sql`UPDATE articles SET revision=3 WHERE id=${id}`;
  assert.equal(await getRecoveryAdmission(id), null);
  await sql`UPDATE articles SET revision=3,url='https://www.example.com/unofficial-url' WHERE id=${id}`;
  await advanceRecoveryExtractionRevision(id, 2, 3, sql);
  assert.equal((await getRecoveryBatch(result.id))!.currentRevisions[id], 2);
});

test("an analyzed web member with a pending body cannot settle without any active job or unknown receipt", async () => {
  const id = await article("analyzed-body-pending", { state: "analyzed" });
  const result = await activate("pending-settlement", [id]);
  await sql`UPDATE articles SET body_status='pending',processing_retry_at=NULL WHERE id=${id}`;
  const status = (await recoveryBatchStatus(result.id))!;
  assert.equal(status.members[0].admission, "admitted");
  assert.equal(status.members[0].state, "analyzed");
  assert.equal(status.members[0].bodyStatus, "pending");
  assert.equal(status.members[0].activeJobs, 0);
  assert.equal(status.members[0].unknownReceipts, 0);
  assert.equal(status.members[0].settled, false);
  assert.equal(status.completeable, false);
  await assert.rejects(stopRecoveryBatch(result.id, "complete", "test", "body extraction still pending"), /unsettled/);
  assert.equal((await getRecoveryBatch(result.id))!.status, "active");
});

for (const body of ["ok", "unconfirmed"]) test(`a terminal ${body} web body preserves job and unknown guards before completing`, async () => {
  const id = await article(`terminal-${body}`, { state: "analyzed" });
  const result = await activate(`terminal-${body}-plan`, [id]);
  await sql`UPDATE articles SET body_status=${body} WHERE id=${id}`;
  const initial = (await recoveryBatchStatus(result.id))!;
  assert.equal(initial.members[0].bodyStatus, body);
  assert.equal(initial.members[0].settled, true);
  assert.equal(initial.completeable, true);
  const job = await queueProcessing(id, { step: "analyze" });
  assert.ok(job);
  const queued = (await recoveryBatchStatus(result.id))!;
  assert.equal(queued.members[0].activeJobs, 1);
  assert.equal(queued.completeable, false);
  await assert.rejects(stopRecoveryBatch(result.id, "complete", "test", "ordinary analysis remains queued"), /unsettled/);
  await sql`DELETE FROM pgboss.job WHERE id=${job}`;
  const [unknown] = await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status)
    VALUES(${prefix + '-terminal-unknown-' + body},'jina','body_fallback',${'article:' + id},'unknown') RETURNING id`;
  try {
    const waiting = (await recoveryBatchStatus(result.id))!;
    assert.equal(waiting.members[0].unknownReceipts, 1);
    assert.equal(waiting.completeable, false);
    await assert.rejects(stopRecoveryBatch(result.id, "complete", "test", "unknown extraction outcome"), /unsettled/);
  } finally { await sql`DELETE FROM receipts WHERE id=${unknown.id}`; }
  assert.equal((await recoveryBatchStatus(result.id))!.completeable, true);
  assert.equal((await stopRecoveryBatch(result.id, "complete", "test", "ordinary work settled")).status, "complete");
});

test("old Bird/model manifests retain their digest and schema without new frozen fields; max118 stays fixed", async () => {
  for (const kind of ["bird-pending", "model-failure"] as const) {
    const id = await article(kind, { kind: kind === "bird-pending" ? "x_search" : "external", body: "ok",
      state: kind === "model-failure" ? "failed" : "new", at: new Date(Date.now() - 5 * 24 * 60 * 60_000) });
    const result = await activate(`old-${kind}`, [id], kind);
    const legacyDigest = createHash("sha256").update(JSON.stringify({ id: result.id, kind: result.kind,
      evidence: result.evidence, members: [...result.members].sort((a, b) => a.articleId.localeCompare(b.articleId)) })).digest("hex");
    assert.equal(result.digest, legacyDigest);
    assert.equal(result.members[0].url, undefined);
    assert.equal(result.members[0].initialProcessingState, undefined);
    assert.equal(result.windowAt, undefined);
    assert.equal(parseRecoveryPlan({ ...result, createdAt: "legacy-compatible-date" }).digest, legacyDigest);
    assert.ok(await getRecoveryAdmission(id));
    await sql`UPDATE articles SET body_status='pending',processing_state='analyzed' WHERE id=${id}`;
    const status = (await recoveryBatchStatus(result.id))!;
    assert.equal(Object.hasOwn(status.members[0], "bodyStatus"), false);
    assert.equal(status.members[0].settled, true);
    assert.equal(status.completeable, true);
  }
  const id = await article("max");
  const result = await plan("max-plan", [id]);
  const tooMany = { ...result, members: Array.from({ length: 119 }, (_, index) => ({ ...result.members[0], articleId: `${id}-${index}` })) };
  assert.throws(() => parseRecoveryPlan({ ...tooMany, digest: recoveryPlanDigest(tooMany) }));
});

test("source acceptance freezes only three explicitly named old public materials and does not widen legacy body recovery", async () => {
  const old = new Date(Date.now() - 5 * 86400_000);
  const approved = await Promise.all(["ok", "pending", "unconfirmed"].map((body, index) => article(`acceptance-${index}`, { kind: ["rss", "web_list", "json_list"][index], body, at: old })));
  const outside = await article("acceptance-not-approved", { body: "ok", at: old });
  await setRecentContentPolicy(true, "test", "Only three old identities may be accepted");
  const budgets = await sql`SELECT * FROM budgets ORDER BY service`;
  await assert.rejects(plan("acceptance-four", [...approved, outside], "source-acceptance"), /at most three/);
  for (const id of approved) await assert.rejects(plan(`legacy-stays-recent-${id.slice(-1)}`, [id]), /initial recent unconfirmed/);
  const result = await plan("acceptance-fixed", approved, "source-acceptance");
  assert.equal(result.windowAt, undefined);
  assert.deepEqual(result.members.map(member => member.initialBodyStatus), ["ok", "pending", "unconfirmed"]);
  assert.ok(result.members.every(member => member.url && member.sourceConfigMd5 && member.publishedAt && member.initialProcessingState === "new"));
  await applyRecoveryBatch(result, "test", "User explicitly named these three old articles");
  assert.equal(await getRecoveryAdmission(outside), null);
  assert.equal(await queueProcessing(outside), null);
  assert.deepEqual(await processArticle(outside), { state: "outside-priority-window" });
  for (const member of result.members) {
    assert.equal((await getRecentContentPriority(member.articleId)).priority, RECOVERY_PRIORITY);
    const job = await queueProcessing(member.articleId, { step: member.initialBodyStatus === "ok" ? "analyze" : "extract" });
    assert.ok(job);
    assert.deepEqual((await sql`SELECT data FROM pgboss.job WHERE id=${job}`)[0].data, { articleId: member.articleId });
  }
  assert.equal((await getRecentContentPolicy()).enabled, true);
  assert.deepEqual(await sql`SELECT * FROM budgets ORDER BY service`, budgets);
  assert.deepEqual((await sql`SELECT processing_attempt_tag FROM articles WHERE id=ANY(${approved}::text[])`).map(row => row.processing_attempt_tag), [null, null, null]);
});

test("source acceptance rejects fresh-plan, identity, date, state and unresolved-receipt drift", async () => {
  const id = await article("acceptance-guards", { body: "ok", at: new Date(Date.now() - 5 * 86400_000) });
  await setRecentContentPolicy(true, "test", "Preserve bounded global processing");
  const result = await plan("acceptance-guards-plan", [id], "source-acceptance");
  for (const age of [-60_000, 31 * 60_000]) {
    const stale = { ...result, createdAt: new Date(Date.now() - age).toISOString() };
    await assert.rejects(applyRecoveryBatch({ ...stale, digest: recoveryPlanDigest(stale) }, "test", "Invalid activation time"), /activation expired/);
  }
  await setRecentContentPolicy(false, "test", "A permit cannot disable the global window");
  await assert.rejects(applyRecoveryBatch(result, "test", "Unbounded global policy"), /must remain enabled/);
  await setRecentContentPolicy(true, "test", "Restore the ordinary gate");
  await sql`UPDATE articles SET published_at=NULL WHERE id=${id}`;
  await assert.rejects(plan("acceptance-unknown-date", [id], "source-acceptance"), /fixed new public/);
  await sql`UPDATE articles SET published_at=now()+interval '1 minute' WHERE id=${id}`;
  await assert.rejects(plan("acceptance-future-date", [id], "source-acceptance"), /fixed new public/);
  await sql`UPDATE articles SET published_at=${result.members[0].publishedAt!}::timestamptz,processing_attempt_tag='manual-other' WHERE id=${id}`;
  await assert.rejects(applyRecoveryBatch(result, "test", "Changed paid identity"), /initial state/);
  await sql`UPDATE articles SET processing_attempt_tag=NULL,revision=2 WHERE id=${id}`;
  await assert.rejects(applyRecoveryBatch(result, "test", "Revision drift"), /revision-changed/);
  await sql`UPDATE articles SET revision=1 WHERE id=${id}`;
  await sql`UPDATE sources SET config='{"parseMode":"html"}'::jsonb WHERE id=${sources.rss}`;
  await assert.rejects(applyRecoveryBatch(result, "test", "Source config drift"), /source-config-changed/);
  await sql`UPDATE sources SET config='{}'::jsonb WHERE id=${sources.rss}`;
  const [receipt] = await sql`INSERT INTO receipts(logical_key,service,purpose,subject,status)
    VALUES(${id + '-unknown'},'llm','structure_article',${'article:' + id + '@1'},'unknown') RETURNING id`;
  try {
    await assert.rejects(plan("acceptance-unresolved", [id], "source-acceptance"), /unresolved paid/);
    await assert.rejects(applyRecoveryBatch(result, "test", "Existing unknown paid answer"), /unresolved paid/);
  } finally { await sql`DELETE FROM receipts WHERE id=${receipt.id}`; }
  await applyRecoveryBatch(result, "test", "Exact original approval");
  await sql`UPDATE articles SET revision=2 WHERE id=${id}`;
  assert.equal(await getRecoveryAdmission(id), null);
  await sql`UPDATE articles SET revision=1 WHERE id=${id}`;
  await sql`UPDATE sources SET config='{"parseMode":"html"}'::jsonb WHERE id=${sources.rss}`;
  assert.equal(await getRecoveryAdmission(id), null);
});

test("three old source acceptance members follow normal body revisions, analysis and historical public settlement", async () => {
  const old = new Date(Date.now() - 5 * 86400_000);
  const approved = await Promise.all(["ok", "pending", "unconfirmed"].map((body, index) => article(`acceptance-chain-${index}`, { kind: ["rss", "web_list", "json_list"][index], body, at: old })));
  const prose = "The original research describes a network model architecture, measured evaluation results and deployment limitations. ".repeat(16);
  await sql`UPDATE articles SET body_text=CASE WHEN body_status='ok' THEN ${prose} ELSE NULL END,backfill=true,timeline_at=published_at WHERE id=ANY(${approved}::text[])`;
  const result = await activate("acceptance-chain-plan", approved, "source-acceptance");
  const dispatcher = getGlobalDispatcher(), mock = new MockAgent();
  mock.disableNetConnect(); mock.enableNetConnect(/127\.0\.0\.1/);
  const previousPrivate = config.allowPrivateNetworkFetch, previousProxy = config.egressProxyUrl;
  config.allowPrivateNetworkFetch = true; config.egressProxyUrl = null; setGlobalDispatcher(mock);
  const calls: string[] = [];
  let index = 0;
  const provider = await stub((_hit, request) => {
    const step = analysisStep(request.body); calls.push(step);
    const data = step === "prefilter" ? { label: "PASS", reason: "Verified original research" }
      : step === "score" ? { attentionScore: selectionThreshold({ tier: "T1" })! - 1 }
      : step === "structure" ? { category: "paper", tags: ["论文/研究"], subjects: [], scope: "single", fact: { title: `Original research ${index}`, evidence: "The original research describes a network model architecture, measured evaluation results and deployment limitations.", conditions: [] } }
      : { itemType: "research_paper", authorRole: "principal", tags: ["论文/研究"], editorialJudgment: "Original technical evidence", titleZh: "原站研究的架构与评测", summaryZh: "原文说明网络模型的架构、评测方法和部署限制，结论按原始实验范围理解。" };
    return { choices: [{ message: { content: JSON.stringify(data) } }] };
  });
  pointModels(provider.url);
  try {
    for (const [number, id] of approved.entries()) {
      index = number;
      if (number) {
        mock.get("https://www.example.com").intercept({ path: "/" + id }).reply(200, `<html><head><title>Offline web body fixture</title></head><body><article><h1>Offline web body fixture</h1><p>${prose}</p></article></body></html>`, { headers: { "content-type": "text/html" } });
        assert.equal(await extractArticleBody(id, false), "ok");
        assert.equal((await getRecoveryBatch(result.id))!.currentRevisions[id], 2);
      }
      assert.ok(await getRecoveryAdmission(id));
      assert.equal((await processArticle(id)).state, "pass");
      await sql`DELETE FROM pgboss.job WHERE data->>'articleId'=${id}`;
      assert.equal((await groupArticle(id)).verdict, "historical", "original dates remain archive dates, never invented current events");
      const [stored] = await sql`SELECT a.revision,a.body_status,a.processing_attempt_tag,a.published_at,p.analysis_id,p.eligible,p.visibility,p.url,p.body_mode,p.selected,p.published_at AS public_date,n.input_revision
        FROM articles a JOIN publications p ON p.article_id=a.id JOIN analyses n ON n.id=p.analysis_id WHERE a.id=${id}`;
      assert.equal(stored.body_status, "ok"); assert.equal(stored.processing_attempt_tag, null);
      assert.equal(stored.revision, number ? 2 : 1); assert.equal(stored.input_revision, stored.revision);
      assert.equal(stored.eligible, true); assert.equal(stored.visibility, "public");
      assert.equal(stored.selected, false, "the recovery permission cannot turn a below-threshold result into a selected report");
      assert.equal(stored.body_mode, "summary", "the source's original full-text licence remains closed");
      assert.equal(stored.published_at.toISOString(), old.toISOString()); assert.equal(stored.public_date.toISOString(), old.toISOString());
      assert.equal(stored.url, result.members[number].url);
    }
    const status = (await recoveryBatchStatus(result.id))!;
    assert.equal(status.completeable, true); assert.equal(status.counts.settled, 3);
    assert.equal((await stopRecoveryBatch(result.id, "complete", "test", "Three normal old source chains settled")).status, "complete");
    assert.equal(calls.filter(step => step === "prefilter").length, 3);
    assert.equal(calls.filter(step => step === "score").length, 2, "the three identical original score inputs reuse the same two independent receipts");
    assert.equal(calls.filter(step => step === "structure").length, 3);
    mock.assertNoPendingInterceptors();
  } finally {
    await provider.close(); setGlobalDispatcher(dispatcher); await mock.close();
    config.allowPrivateNetworkFetch = previousPrivate; config.egressProxyUrl = previousProxy;
  }
});
