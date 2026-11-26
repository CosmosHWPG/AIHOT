import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { BudgetExceededError, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";

const T = tag();
const service = `budget-switch-${T}`;
after(async () => {
  await sql`DELETE FROM receipts WHERE service=${service}`;
  await sql`DELETE FROM budgets WHERE service=${service}`;
  await closeDb();
});

test("disabled quantity limits still count paid calls, reuse answers and resume limits against retained usage", async () => {
  await sql`INSERT INTO budgets(service,enabled,per_minute,per_hour,per_day) VALUES(${service},false,0,0,0)`;
  let sent = 0;
  const req = { service,purpose: "budget_switch_invariant",identity: { key:T },requireBudget: true };
  const first = await paidRequest(req,async () => { sent++; return { response: { ok:true },cost:{ amount:0.01,currency:"USD",basis:"actual" } }; });
  const repeated = await paidRequest(req,async () => assert.fail("saved answer was sent twice"));
  const second = await paidRequest({ ...req,identity:{ key:`${T}-2` } },async () => { sent++; return { response: {} }; });
  assert.equal(sent,2);
  assert.equal(repeated.reused,true);
  assert.equal(repeated.receiptId,first.receiptId);
  const attempts = await sql`SELECT receipt_id,status,cost FROM receipt_attempts WHERE service=${service} ORDER BY id`;
  assert.equal(attempts.length,2);
  assert.deepEqual(attempts.map(row=>row.status),["received","received"]);
  assert.equal(Number(attempts[0]!.cost),0.01);
  assert.notEqual(first.receiptId,second.receiptId);
  await sql`UPDATE budgets SET enabled=true,per_minute=1,per_hour=1,per_day=1 WHERE service=${service}`;
  await assert.rejects(paidRequest({ ...req,identity:{ key:`${T}-3` } },async () => assert.fail("limits ignored after re-enable")),BudgetExceededError);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE service=${service}`)[0]!.n,2);
});

test("disabled numeric limits do not retry unknown outcomes or bypass provider credit reserves", async () => {
  await sql`UPDATE budgets SET enabled=false WHERE service=${service}`;
  const req = { service,purpose: "budget_switch_invariant",identity: { unknown:T } };
  let sent = 0;
  await assert.rejects(paidRequest(req,async () => { sent++; throw new Error("lost response"); }),/lost response/);
  await assert.rejects(paidRequest(req,async () => assert.fail("unknown resent")),ReceiptUnknownError);
  assert.equal(sent,1);
  await assert.rejects(paidRequest({ service,purpose: "budget_switch_invariant",identity:{ credits:T },creditBudget: {
    maximum:10,dailyLimit:100,reserve:10,availableCredits: async () => 10,
  } },async () => assert.fail("credit reserve ignored")),error=>error instanceof BudgetExceededError && error.message.includes("credits-reserve"));
});

test("a missing required budget still fails closed; enabled zero limits retain pause semantics", async () => {
  await assert.rejects(paidRequest({ service:`${service}-missing`,purpose: "budget_switch_invariant",identity:{ missing:T },requireBudget:true },
    async () => assert.fail("unconfigured service called")),error=>error instanceof BudgetExceededError && error.message.includes("unconfigured"));
  await sql`UPDATE budgets SET enabled=true,per_minute=0,per_hour=0,per_day=0 WHERE service=${service}`;
  await assert.rejects(paidRequest({ service,purpose: "budget_switch_invariant",identity:{ stopped:T } },
    async () => assert.fail("paused service called")),error=>error instanceof BudgetExceededError && error.message.includes("stopped"));
});
