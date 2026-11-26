import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify from "fastify";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { listBudgets, updateBudget } from "@aihot/backend/admin/settings";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { activateTemporaryLlmBudget, restoreExpiredLlmBudget, temporaryLlmBudgetStatus, TEMPORARY_LLM_BUDGET_KEY } from "@aihot/backend/providers/temporary-budget";
import { registerAdmin } from "../apps/api/src/routes/admin.ts";

const T = tag();
const service = `budget-switch-${T}`;
const original = { dev: config.devAdmin,environment: config.environmentName };
const app = Fastify({ logger: false });
registerAdmin(app);
let receiptId = 0;
let birdBefore: unknown;

before(async () => {
  config.devAdmin = { displayName: "Budget switch test" };
  config.environmentName = "development";
  [birdBefore] = await sql`SELECT * FROM budgets WHERE service='bird'`;
  await sql`INSERT INTO budgets (service,per_minute,per_hour,per_day,note) VALUES (${service},20,180,800,'original')`;
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts (logical_key,service,purpose,status,request,attempts)
    VALUES (${`budget-switch-${T}`},${service},'budget_switch_test','completed','{}',2) RETURNING id`;
  receiptId = receipt!.id;
  await sql`INSERT INTO receipt_attempts (receipt_id,attempt,service,status) VALUES (${receiptId},1,${service},'received'),(${receiptId},2,${service},'unknown')`;
});
beforeEach(async () => {
  await sql`UPDATE budgets SET enabled=true,per_minute=20,per_hour=180,per_day=800,note='original',updated_at=clock_timestamp() WHERE service=${service}`;
});
after(async () => {
  assert.deepEqual((await sql`SELECT * FROM budgets WHERE service='bird'`)[0],birdBefore,"Bird's budget was not modified");
  await app.close();
  await sql`DELETE FROM audit_log WHERE subject IN (${`budget:${service}`},${`budget:${service}-new`})`;
  await sql`DELETE FROM receipts WHERE id=${receiptId}`;
  await sql`DELETE FROM budgets WHERE service IN (${service},${service + '-new'})`;
  config.devAdmin = original.dev;
  config.environmentName = original.environment;
  await stopBoss();
  await closeDb();
});

const stored = async () => (await sql`SELECT * FROM budgets WHERE service=${service}`)[0]!;
const put = (payload: Record<string, unknown>, csrf = "dev", target = service) => app.inject({
  method: "PUT",url: `/api/admin/budgets/${target}`,headers: { "x-csrf-token": csrf },payload,
});

test("migration preserves existing services as enabled and the settings API exposes the switch and usage", async () => {
  assert.equal((await stored()).enabled,true);
  const response = await app.inject({ method: "GET",url: "/api/admin/settings" });
  assert.equal(response.statusCode,200);
  const row = response.json().budgets.find((budget: { service: string }) => budget.service === service);
  assert.equal(row.enabled,true);
  assert.equal(row.used_day,2);
  assert.equal(row.used_hour,2);
});

test("switch-only saves preserve limits and all attempts; both directions are atomically audited", async () => {
  const first = await put({ enabled: false,reason: "disable quantity enforcement" });
  assert.equal(first.statusCode,200);
  const disabled = first.json();
  assert.deepEqual([disabled.enabled,disabled.per_minute,disabled.per_hour,disabled.per_day],[false,20,180,800]);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE receipt_id=${receiptId}`).length,2);
  const row = (await listBudgets()).find(budget => budget.service === service)!;
  assert.equal(row.enabled,false);
  assert.equal(row.used_day,2);
  const second = await put({ enabled: true,reason: "restore quantity enforcement",version: disabled.updated_at });
  assert.equal(second.statusCode,200);
  assert.equal(second.json().enabled,true);
  const audit = await sql`SELECT before,after FROM audit_log WHERE subject=${`budget:${service}`} AND reason IN ('disable quantity enforcement','restore quantity enforcement') ORDER BY id`;
  assert.equal(audit.length,2);
  assert.deepEqual(audit.map(entry => [entry.before.enabled,entry.after.enabled]),[[true,false],[false,true]]);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts WHERE receipt_id=${receiptId}`).length,2);
});

test("API validates booleans, bounds and reasons before changing configuration", async () => {
  const before = await stored();
  for (const payload of [
    { enabled: "false",reason: "invalid string" },{ enabled: false,reason: " " },
    { enabled: false,perDay: -1,reason: "negative" },{ perMinute: 2_147_483_648,reason: "overflow" },
    { reason: "no operation" },{ enabled: false,unexpected: true,reason: "unknown property" },
  ]) assert.equal((await put(payload)).statusCode,400);
  assert.deepEqual(await stored(),before);
  assert.equal((await put({ enabled: false,reason: "incomplete new budget" },"dev",`${service}-new`)).statusCode,400);
  assert.equal((await sql`SELECT 1 FROM budgets WHERE service=${service + '-new'}`).length,0);
});

test("zero limits remain stopped when enabled and legacy numeric edits do not silently reenable a disabled budget", async () => {
  await updateBudget(service,{ enabled: false,reason: "keep disabled" },"test");
  const legacy = await put({ perMinute: 20,perHour: 180,perDay: 0,reason: "save existing limits" });
  assert.equal(legacy.statusCode,200);
  assert.deepEqual([legacy.json().enabled,legacy.json().per_day],[false,0]);
  const paused = await put({ enabled: true,reason: "enable configured zero ceiling" });
  assert.deepEqual([paused.json().enabled,paused.json().per_day],[true,0]);
  const created = await put({ perMinute: 1,perHour: 10,perDay: 120,reason: "new configured budget" },"dev",`${service}-new`);
  assert.equal(created.statusCode,200);
  assert.equal(created.json().enabled,true);
});

test("concurrent partial edits retain each other's fields and stale versions are refused", async () => {
  await Promise.all([
    updateBudget(service,{ enabled: false,reason: "parallel switch" },"test"),
    updateBudget(service,{ perDay: 801,reason: "parallel numeric edit" },"test"),
  ]);
  const latest = await stored();
  assert.deepEqual([latest.enabled,latest.per_day],[false,801]);
  await sql`UPDATE budgets SET updated_at=updated_at+interval '1 second' WHERE service=${service}`;
  const beforeStale = await stored();
  const conflict = await put({ enabled: true,reason: "stale browser edit",version: latest.updated_at.toISOString() });
  assert.equal(conflict.statusCode,409);
  assert.deepEqual(await stored(),beforeStale);
});

test("admin session and CSRF guards protect quantity switches", async () => {
  const before = await stored();
  assert.equal((await put({ enabled: false,reason: "wrong csrf" },"wrong")).statusCode,403);
  config.devAdmin = null;
  try { assert.equal((await put({ enabled: false,reason: "signed out" })).statusCode,401); }
  finally { config.devAdmin = { displayName: "Budget switch test" }; }
  assert.deepEqual(await stored(),before);
});

test("a rejected audit rolls the switch and limits back together", async () => {
  const before = await stored();
  const name = `budget_audit_${T}`;
  const actor = `reject-budget-${T}`;
  await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.actor='${actor}' AND NEW.action='budget.update' THEN RAISE EXCEPTION 'fixture rejects budget audit'; END IF;
    RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try { await assert.rejects(updateBudget(service,{ enabled: false,perDay: 1200,reason: "rollback" },actor),/fixture rejects/); }
  finally { await sql.unsafe(`DROP TRIGGER ${name} ON audit_log`); await sql.unsafe(`DROP FUNCTION ${name}()`); }
  assert.deepEqual(await stored(),before);
});

test("LLM switch-off validates the old version before cancelling its lease and inherits the restored 800 limit", async () => {
  const [previous] = await sql`SELECT *,updated_at::text AS precise_at FROM budgets WHERE service='llm'`;
  const [setting] = await sql`SELECT * FROM settings WHERE key=${TEMPORARY_LLM_BUDGET_KEY}`;
  let leaseId = "";
  try {
    await sql`DELETE FROM settings WHERE key=${TEMPORARY_LLM_BUDGET_KEY}`;
    await sql`INSERT INTO budgets (service,enabled,per_minute,per_hour,per_day,note) VALUES ('llm',true,20,180,800,'lease baseline')
      ON CONFLICT (service) DO UPDATE SET enabled=true,per_minute=20,per_hour=180,per_day=800,note='lease baseline',updated_at=clock_timestamp()`;
    const usageBefore = await sql`SELECT id,status,origin,started_at FROM receipt_attempts WHERE service='llm' ORDER BY id`;
    const activated = await activateTemporaryLlmBudget("test-budget-cancel","temporary batch");
    leaseId = activated.lease.id;
    const overview = (await app.inject({ method: "GET",url: "/api/admin/settings" })).json();
    const llm = overview.budgets.find((row: { service: string }) => row.service === "llm");
    assert.deepEqual([llm.enabled,llm.per_day],[true,2000]);
    const stale = await put({ enabled: false,reason: "stale lease view",version: "2000-01-01T00:00:00.000Z" },"dev","llm");
    assert.equal(stale.statusCode,409);
    assert.equal((await temporaryLlmBudgetStatus()).lease!.status,"active");
    assert.equal((await temporaryLlmBudgetStatus()).budget!.perDay,2000);
    const disabled = await put({ enabled: false,reason: "end lease and disable quantity enforcement",version: llm.updated_at },"dev","llm");
    assert.equal(disabled.statusCode,200);
    assert.deepEqual([disabled.json().enabled,disabled.json().per_minute,disabled.json().per_hour,disabled.json().per_day],[false,20,180,800]);
    assert.equal((await temporaryLlmBudgetStatus()).lease!.status,"superseded");
    assert.equal((await restoreExpiredLlmBudget()).restored,false);
    assert.equal((await sql`SELECT enabled FROM budgets WHERE service='llm'`)[0]!.enabled,false);
    assert.deepEqual(await sql`SELECT id,status,origin,started_at FROM receipt_attempts WHERE service='llm' ORDER BY id`,usageBefore);
  } finally {
    await sql`DELETE FROM audit_log WHERE subject='budget:llm' AND (after->>'leaseId'=${leaseId} OR before->>'leaseId'=${leaseId}
      OR reason='end lease and disable quantity enforcement')`;
    if (setting) await sql`INSERT INTO settings (key,value,updated_by) VALUES (${TEMPORARY_LLM_BUDGET_KEY},${sql.json(setting.value as never)},${setting.updated_by})
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by`;
    else await sql`DELETE FROM settings WHERE key=${TEMPORARY_LLM_BUDGET_KEY}`;
    if (previous) await sql`UPDATE budgets SET enabled=${previous.enabled},per_minute=${previous.per_minute},per_hour=${previous.per_hour},per_day=${previous.per_day},
      note=${previous.note},updated_at=${previous.precise_at}::timestamptz WHERE service='llm'`;
    else await sql`DELETE FROM budgets WHERE service='llm'`;
  }
});
