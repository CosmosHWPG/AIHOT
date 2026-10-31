// In-doubt work. A stopped process leaves "pending" receipts and deliveries: they become
// "unknown" and are never re-sent on their own. An unknown receipt is released once automatically after
// half an hour without checking the provider's bill, so a lost answer costs at most one repeat; one that
// turns unknown again waits for the admin, who checks the bill and releases it with a note. A released
// receipt lets its request call again, and an article that stopped on it goes back to processing.
import { audit, Conflict } from "../audit.ts";
import { sql } from "../db.ts";
import { resumeAfterRelease } from "../jobs/content.ts";
import { retryReleasedReceiptJobs } from "../jobs/queue.ts";
import { getProcessingScopeTargets } from "../jobs/recent-content.ts";
import { pageFetchable } from "../content/extract.ts";
import { markStaleDeliveries } from "../notify/deliver.ts";
import { markStalePendingReceipts, releaseUnknownReceipt } from "../providers/receipts.ts";

const AUTO_RELEASE_AFTER_MS = 30 * 60_000;
const AUTO_RELEASE_NOTE = "自动放行：结果未知超过 30 分钟，未核对是否计费";

async function release(id: number, error: string, actor: string, note: string, billed: boolean | null) {
  return sql.begin(async (tx) => {
    const receipt = await releaseUnknownReceipt(tx, id, error);
    if (!receipt) return null;
    const requeued = await resumeAfterRelease({ ...receipt,receiptId: id }, tx);
    await audit(actor, "receipt.release", `receipt:${id}`, note, { status: "unknown" }, { status: "failed", billed, requeued }, { db: tx });
    return { id, status: "failed", subject: receipt.subject, purpose: receipt.purpose, requeued };
  });
}

/** Admin, after checking the provider's console: records whether it was billed and releases it. */
export async function releaseReceipt(id: number, input: { billed: boolean; note: string }, actor: string) {
  if (!input.note?.trim()) throw new Error("note is required");
  const [row] = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE id = ${id}`;
  if (!row) return null;
  if (row.status !== "unknown") throw new Conflict("只有结果未知的回执需要人工核对");
  const error = `人工核对：${input.billed ? "供应商已计费但结果未取回" : "供应商未计费"}。${input.note}`;
  return release(id, error, actor, input.note, input.billed);
}

/**
 * Unknown receipts older than half an hour, released without checking the provider's bill. A request
 * released this way once and unknown again stays for the admin (the daily ops digest lists it).
 */
export async function autoReleaseUnknownReceipts(now = Date.now()) {
  const rows = await sql<{ id: number }[]>`
    SELECT r.id FROM receipts r
    WHERE r.status = 'unknown' AND r.updated_at < ${new Date(now - AUTO_RELEASE_AFTER_MS)}
      AND NOT EXISTS (SELECT 1 FROM receipt_attempts a WHERE a.receipt_id = r.id AND a.error LIKE ${AUTO_RELEASE_NOTE + "%"})
    ORDER BY r.id LIMIT 200`;
  let released = 0;
  let requeued = 0;
  for (const r of rows) {
    const done = await release(r.id, AUTO_RELEASE_NOTE, "ops.recover", "结果未知，自动放行一次", null);
    if (done) released += 1;
    if (done?.requeued) requeued += 1;
  }
  return { released, requeued };
}

/** Finish a recorded release's missing body handoff once; this never releases a receipt again. */
export async function resumeReleasedBodyHandoffs(): Promise<{ resumed: number }> {
  const scope = await getProcessingScopeTargets();
  if (!scope.enabled) return { resumed: 0 }; // This repair stays within the existing bounded scope.
  const rows = await sql<{ receipt_id: number; release_audit_id: number; url: string; kind: string }[]>`
    WITH active_articles AS MATERIALIZED (
      SELECT DISTINCT data->>'articleId' AS id FROM pgboss.job WHERE state IN ('created','retry','active')
    ), unresolved AS MATERIALIZED (
      SELECT substring(subject from '^article:([^@:#]+)') AS article_id,service,request->>'url' AS url
      FROM receipts WHERE status IN ('pending','unknown')
    ) SELECT DISTINCT ON(a.id) r.id AS receipt_id,e.id AS release_audit_id,a.url,s.kind
    FROM audit_log e JOIN receipts r ON e.subject='receipt:'||r.id
      JOIN articles a ON substring(r.subject from '^article:([^@:#]+)')=a.id JOIN sources s ON s.id=a.source_id
    WHERE e.action='receipt.release' AND e.after->>'requeued'='false'
      AND r.service='jina' AND r.purpose='body_fallback' AND r.status='failed'
      AND a.processing_state IN ('new','failed','analyzed') AND a.body_status IN ('pending','unconfirmed')
      AND (a.processing_retry_at IS NULL OR a.processing_retry_at<=now())
      AND s.enabled AND s.participation_mode='editorial' AND s.kind NOT IN ('x_search','mp_account')
      AND a.x_post->>'tweetId' IS NULL
      AND (coalesce(NOT(r.request?'url'),true) OR (jsonb_typeof(r.request->'url')='string' AND r.request->>'url'=a.url))
      AND a.id=ANY(${scope.articleIds}::text[])
      AND NOT EXISTS(SELECT 1 FROM active_articles j WHERE j.id=a.id)
      AND NOT EXISTS(SELECT 1 FROM unresolved u WHERE u.article_id=a.id OR (u.service='jina' AND u.url=a.url))
      AND NOT EXISTS(SELECT 1 FROM event_job_deferrals d WHERE d.data->>'articleId'=a.id)
      AND NOT EXISTS(SELECT 1 FROM audit_log later WHERE later.subject=e.subject AND later.action='receipt.release' AND later.id>e.id)
      AND NOT EXISTS(SELECT 1 FROM audit_log done WHERE done.subject=e.subject AND done.action='receipt.body-resumed'
        AND done.after->>'releaseAuditId'=e.id::text)
      AND NOT EXISTS(SELECT 1 FROM receipt_attempts t JOIN receipts used ON used.id=t.receipt_id
        WHERE used.service='jina' AND used.purpose='body_fallback'
          AND (substring(used.subject from '^article:([^@:#]+)')=a.id OR used.request->>'url'=a.url)
          AND (t.started_at>=e.created_at OR t.finished_at>=e.created_at))
    ORDER BY a.id,e.id DESC`;
  // At most one candidate per admitted article; exact URL parsing precedes the handoff limit.
  const candidates = rows.filter(row => pageFetchable(row.url,row.kind)).sort((a,b) => a.release_audit_id-b.release_audit_id).slice(0,200);
  let resumed = 0;
  for (const row of candidates) {
    const done = await sql.begin(async tx => {
      const [r] = await tx<{ purpose: string; subject: string | null }[]>`SELECT purpose,subject FROM receipts
        WHERE id=${row.receipt_id} AND service='jina' AND purpose='body_fallback' AND status='failed' FOR UPDATE`;
      if (!r) return false;
      const [eligible] = await tx`SELECT 1 FROM audit_log e JOIN articles a ON a.id=substring(${r.subject}::text from '^article:([^@:#]+)')
        WHERE e.id=${row.release_audit_id} AND e.action='receipt.release'
        AND e.subject=${'receipt:' + row.receipt_id} AND e.after->>'requeued'='false'
        AND (a.processing_retry_at IS NULL OR a.processing_retry_at<=now())
        AND NOT EXISTS(SELECT 1 FROM audit_log later WHERE later.subject=e.subject AND later.action='receipt.release' AND later.id>e.id)
        AND NOT EXISTS(SELECT 1 FROM audit_log done WHERE done.subject=e.subject AND done.action='receipt.body-resumed'
          AND done.after->>'releaseAuditId'=e.id::text)
        AND NOT EXISTS(SELECT 1 FROM receipt_attempts t JOIN receipts used ON used.id=t.receipt_id
          WHERE used.service='jina' AND used.purpose='body_fallback'
            AND (substring(used.subject from '^article:([^@:#]+)')=a.id OR used.request->>'url'=a.url)
            AND (t.started_at>=e.created_at OR t.finished_at>=e.created_at))`;
      if (!eligible || !(await resumeAfterRelease({ ...r,receiptId: row.receipt_id,respectRetry: true },tx))) return false;
      await audit("ops.recover","receipt.body-resumed",'receipt:' + row.receipt_id,
        "Complete the existing released receipt's missing body extraction handoff",null,
        { releaseAuditId: row.release_audit_id,requeued: true },{ db: tx });
      return true;
    });
    if (done) resumed++;
  }
  return { resumed };
}

/** ops.recover, every 10 minutes and before the alerts look. */
export async function recoverStaleWork() {
  return { receipts: await markStalePendingReceipts(), released: await autoReleaseUnknownReceipts(), bodies: await resumeReleasedBodyHandoffs(), jobs: await retryReleasedReceiptJobs(), deliveries: await markStaleDeliveries() };
}
