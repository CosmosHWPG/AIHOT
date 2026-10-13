import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { activateTemporaryLlmBudget, restoreExpiredLlmBudget, temporaryLlmBudgetStatus, temporaryLlmAllowance, TEMPORARY_LLM_BUDGET_KEY } from "@aihot/backend/providers/temporary-budget";
import { BudgetExceededError, logicalKeyFor, paidRequest } from "@aihot/backend/providers/receipts";

const T = tag();
const actor = `temporary-budget-test-${T}`;
let previousBudget: { per_minute: number; per_hour: number; per_day: number; note: string | null; at: string } | undefined;
let previousLease: { value: unknown; updated_by: string | null } | undefined;
const receiptIds: number[] = [];
const leaseIds: string[] = [];

before(async () => {
  [previousBudget] = await sql`SELECT per_minute,per_hour,per_day,note,updated_at::text AS at FROM budgets WHERE service='llm'`;
  [previousLease] = await sql`SELECT value,updated_by FROM settings WHERE key=${TEMPORARY_LLM_BUDGET_KEY}`;
});
beforeEach(async () => {
  await sql`DELETE FROM receipts WHERE id=ANY(${receiptIds}::bigint[])`;
  await sql`DELETE FROM settings WHERE key=${TEMPORARY_LLM_BUDGET_KEY}`;
  await sql`INSERT INTO budgets (service,per_minute,per_hour,per_day,note) VALUES ('llm',20,180,800,'baseline')
    ON CONFLICT (service) DO UPDATE SET per_minute=20,per_hour=180,per_day=800,note='baseline',updated_at=clock_timestamp()`;
});
after(async () => {
  await sql`DELETE FROM receipts WHERE id=ANY(${receiptIds}::bigint[])`;
  await sql`DELETE FROM audit_log WHERE action IN ('budget.temporary.activate','budget.temporary.restore','budget.temporary.superseded')
    AND (after->>'leaseId'=ANY(${leaseIds}::text[]) OR before->>'leaseId'=ANY(${leaseIds}::text[]))`;
  if (previousLease) await sql`INSERT INTO settings (key,value,updated_by) VALUES (${TEMPORARY_LLM_BUDGET_KEY},${sql.json(previousLease.value as never)},${previousLease.updated_by})
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by`;
  else await sql`DELETE FROM settings WHERE key=${TEMPORARY_LLM_BUDGET_KEY}`;
  if (previousBudget) await sql`UPDATE budgets SET per_minute=${previousBudget.per_minute},per_hour=${previousBudget.per_hour},per_day=${previousBudget.per_day},
    note=${previousBudget.note},updated_at=${previousBudget.at}::timestamptz WHERE service='llm'`;
  else await sql`DELETE FROM budgets WHERE service='llm'`;
  await closeDb();
});

async function activate() {
  const result = await activateTemporaryLlmBudget(actor,"authorized 24-hour processing batch");
  leaseIds.push(result.lease.id);
  return result;
}
async function expire() {
  await sql`UPDATE settings SET value=jsonb_set(value,'{expiresAt}',to_jsonb((now()-interval '1 second')::text))
    WHERE key=${TEMPORARY_LLM_BUDGET_KEY}`;
}

test("activation changes only the daily ceiling, persists a 24-hour lease and audits atomically", async () => {
  const before = await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE service='llm'`;
  const result = await activate();
  assert.equal(Date.parse(result.expiresAt)-Date.parse(result.lease.activatedAt),86_400_000);
  assert.equal(result.lease.status,"active");
  const status = await temporaryLlmBudgetStatus();
  assert.deepEqual([status.budget!.perMinute,status.budget!.perHour,status.budget!.perDay],[20,180,2000]);
  assert.equal(status.lease!.id,result.lease.id);
  const [audit] = await sql`SELECT before,after FROM audit_log WHERE action='budget.temporary.activate' AND after->>'leaseId'=${result.lease.id}`;
  assert.equal(audit!.before.budget.perDay,800);
  assert.equal(audit!.after.budget.perDay,2000);
  assert.deepEqual(await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE service='llm'`,before,"rolling usage was not reset");
  assert.equal((await restoreExpiredLlmBudget()).status,"active");
});

test("activation requires the authorized baseline and explicit actor/reason", async () => {
  await assert.rejects(activateTemporaryLlmBudget("","reason"),/actor and reason/);
  await assert.rejects(activateTemporaryLlmBudget(actor," "),/actor and reason/);
  await sql`UPDATE budgets SET per_day=799 WHERE service='llm'`;
  await assert.rejects(activateTemporaryLlmBudget(actor,"reason"),/existing LLM budget/);
  assert.equal((await temporaryLlmBudgetStatus()).lease,null);
});

test("concurrent activation allows one lease and cannot extend it by overlapping requests", async () => {
  const results = await Promise.allSettled([
    activateTemporaryLlmBudget(actor,"batch one"),activateTemporaryLlmBudget(actor,"batch two"),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length,1);
  for (const result of results) if (result.status === "fulfilled") leaseIds.push(result.value.lease.id);
  const rejected = results.find(r => r.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected" && /unexpired/.test(String(rejected.reason)));
});

test("expiry after a restart restores the original budget and note exactly once", async () => {
  const result = await activate();
  await expire();
  const restored = await restoreExpiredLlmBudget();
  assert.deepEqual([restored.restored,restored.status],[true,"restored"]);
  const status = await temporaryLlmBudgetStatus();
  assert.deepEqual([status.budget!.perMinute,status.budget!.perHour,status.budget!.perDay,status.budget!.note],[20,180,800,"baseline"]);
  assert.equal(status.lease!.status,"restored");
  assert.equal((await restoreExpiredLlmBudget()).restored,false);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action='budget.temporary.restore' AND after->>'leaseId'=${result.lease.id}`).length,1);
});

test("expiry preserves an administrator's later numeric and note changes", async () => {
  await activate();
  await sql`UPDATE budgets SET per_day=1900,note='administrator decision',updated_at=clock_timestamp()+interval '1 second' WHERE service='llm'`;
  await expire();
  const result = await restoreExpiredLlmBudget();
  assert.deepEqual([result.restored,result.status],[false,"superseded"]);
  const status = await temporaryLlmBudgetStatus();
  assert.deepEqual([status.budget!.perDay,status.budget!.note],[1900,"administrator decision"]);
});

test("a changed updated_at fingerprint is preserved even when the numeric limits are identical", async () => {
  await activate();
  await sql`UPDATE budgets SET updated_at=clock_timestamp()+interval '1 second' WHERE service='llm'`;
  assert.equal((await restoreExpiredLlmBudget()).status,"superseded");
  assert.equal((await temporaryLlmBudgetStatus()).budget!.perDay,2000);
  assert.equal(await temporaryLlmAllowance(),null,"an administrator decision supersedes the extra-attempt gate before expiry");
});

test("an expired lease is committed before a blocked paid claim and sends no request over 800/day", async () => {
  await activate();
  const [seed] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key,service,purpose,subject,status,request,attempts)
    VALUES (${`temporary-budget-seed-${T}`},'llm','temporary_budget_invariant',${`seed-${T}`},'completed','{}',801) RETURNING id`;
  receiptIds.push(seed!.id);
  await sql`INSERT INTO receipt_attempts (receipt_id,attempt,service,status,started_at)
    SELECT ${seed!.id},n,'llm','received',now()-interval '2 hours' FROM generate_series(1,801) n`;
  await expire();
  let calls = 0;
  await assert.rejects(paidRequest({ service: "llm",purpose: "temporary_budget_invariant",identity: { blocked: T } },async () => {
    calls++;
    return { response: {} };
  }),BudgetExceededError);
  assert.equal(calls,0);
  const status = await temporaryLlmBudgetStatus();
  assert.equal(status.budget!.perDay,800,"restoration did not roll back with the rejected claim");
  assert.equal(status.lease!.status,"restored");
  await sql`DELETE FROM receipts WHERE id=${seed!.id}`;
});

test("a saved answer is still reused after expiry while the budget is restored independently", async () => {
  await activate();
  const req = { service: "llm",purpose: "temporary_budget_invariant",identity: { reused: T } };
  const [seed] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key,service,purpose,status,request,response,attempts)
    VALUES (${logicalKeyFor(req)},'llm','temporary_budget_invariant','completed','{}','{"ok":true}',1) RETURNING id`;
  receiptIds.push(seed!.id);
  await expire();
  const result = await paidRequest(req,async () => assert.fail("saved response was sent again"));
  assert.equal(result.reused,true);
  assert.equal((await temporaryLlmBudgetStatus()).budget!.perDay,800);
});

test("an invalid expiry fails closed instead of leaving an unbounded larger allowance", async () => {
  await activate();
  await sql`UPDATE settings SET value=jsonb_set(value,'{expiresAt}','"invalid"') WHERE key=${TEMPORARY_LLM_BUDGET_KEY}`;
  let calls = 0;
  await assert.rejects(paidRequest({ service: "llm",purpose: "temporary_budget_invariant",identity: { invalid: T } },async () => {
    calls++;
    return { response: {} };
  }),/lease is invalid/);
  assert.equal(calls,0);
});

test("activation participates in an existing transaction and rolls back every budget/settings write", async () => {
  await assert.rejects(sql.begin(async tx => {
    const result = await activateTemporaryLlmBudget(actor,"transaction batch",tx);
    leaseIds.push(result.lease.id);
    throw new Error("cancel transaction");
  }),/cancel transaction/);
  const status = await temporaryLlmBudgetStatus();
  assert.equal(status.lease,null);
  assert.equal(status.budget!.perDay,800);
});

async function seedAttempts(suffix: string, count: number, age: string, origin = "live", service = "llm") {
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key,service,purpose,status,request,attempts)
    VALUES (${`lease-bound-${T}-${suffix}`},${service},'temporary_budget_invariant','completed','{}',${count}) RETURNING id`;
  receiptIds.push(receipt!.id);
  await sql`INSERT INTO receipt_attempts (receipt_id,attempt,service,origin,status,started_at)
    SELECT ${receipt!.id},n,${service},${origin},
      CASE n%4 WHEN 0 THEN 'received' WHEN 1 THEN 'failed' WHEN 2 THEN 'unknown' ELSE 'pending' END,
      clock_timestamp()-${age}::interval FROM generate_series(1,${count}) n`;
}

test("the 1200 new-attempt gate holds after the original 800 roll out, while saved answers remain reusable", async () => {
  await activate();
  await sql`UPDATE settings SET value=jsonb_set(jsonb_set(value,'{activatedAt}',to_jsonb((now()-interval '3 hours')::text)),
    '{expiresAt}',to_jsonb((now()+interval '21 hours')::text)) WHERE key=${TEMPORARY_LLM_BUDGET_KEY}`;
  await seedAttempts("original-800",800,"25 hours");
  const baseline = (await temporaryLlmAllowance())!.used;
  assert.ok(baseline<1200);
  await seedAttempts("new-1200",1200-baseline,"2 hours");
  const allowance = await temporaryLlmAllowance();
  assert.deepEqual([allowance!.used,allowance!.limit,allowance!.exhausted],[1200,1200,true]);
  const req = { service: "llm",purpose: "temporary_budget_invariant",identity: { maximum: T } };
  let sent = 0;
  await assert.rejects(paidRequest(req,async () => { sent++; return { response: {} }; }),
    error => error instanceof BudgetExceededError && error.message === "Budget for llm exhausted (temporary)");
  assert.equal(sent,0);
  assert.equal((await temporaryLlmAllowance())!.used,1200,"the 1201st request did not reserve an attempt");
  assert.equal((await sql`SELECT 1 FROM receipts WHERE logical_key=${logicalKeyFor(req)}`).length,0);

  const cached = { ...req,identity: { maximumCached: T } };
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key,service,purpose,status,request,response)
    VALUES (${logicalKeyFor(cached)},'llm','temporary_budget_invariant','completed','{}','{"ok":true}') RETURNING id`;
  receiptIds.push(receipt!.id);
  assert.equal((await paidRequest(cached,async () => assert.fail("cached result was sent again"))).reused,true);
  assert.equal((await temporaryLlmAllowance())!.used,1200);
});

test("the lease counter includes every live LLM status and excludes replay, import, other services and pre-activation work", async () => {
  await activate();
  const baseline = (await temporaryLlmAllowance())!.used;
  await seedAttempts("live-statuses",4,"0 seconds");
  await seedAttempts("replayed",2,"0 seconds","replay");
  await seedAttempts("imported",3,"0 seconds","imported");
  await seedAttempts("other-service",1,"0 seconds","live","embedding");
  await seedAttempts("before-activation",1,"1 hour");
  const allowance = await temporaryLlmAllowance();
  assert.equal(allowance!.used,baseline+4);
  assert.equal(allowance!.exhausted,false);
  await expire();
  assert.equal((await restoreExpiredLlmBudget()).restored,true);
  assert.equal(await temporaryLlmAllowance(),null);
  assert.equal((await temporaryLlmBudgetStatus()).budget!.perDay,800);
});
