// An explicitly authorized 24-hour capacity lease. It never resets rolling attempt counts.
import { randomUUID } from "node:crypto";
import { sql, type Db } from "../db.ts";
import { audit } from "../audit.ts";

export const TEMPORARY_LLM_BUDGET_KEY = "corescope.temporary_llm_budget";
export const TEMPORARY_LLM_NEW_ATTEMPTS = 1200;
type Budget = { perMinute: number; perHour: number; perDay: number; note: string | null; updatedAt: string };
export interface TemporaryLlmBudgetLease {
  version: 1;
  id: string;
  service: "llm";
  status: "active" | "restored" | "superseded";
  actor: string;
  reason: string;
  activatedAt: string;
  expiresAt: string;
  original: Budget;
  temporary: Budget;
  endedAt?: string;
}
export interface TemporaryLlmBudgetRestore {
  restored: boolean;
  status: "none" | "active" | "restored" | "superseded";
  expiresAt?: string;
}
export interface TemporaryLlmAllowance {
  exhausted: boolean;
  retryAfterSeconds: number;
  used: number;
  limit: 1200;
}

async function budgetRow(db: Db, lock = false): Promise<Budget | null> {
  const [row] = await db<Budget[]>`SELECT per_minute AS "perMinute",per_hour AS "perHour",per_day AS "perDay",note,
    to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
    FROM budgets WHERE service='llm' ${lock ? db`FOR UPDATE` : db``}`;
  return row ?? null;
}

function parseLease(value: unknown): TemporaryLlmBudgetLease {
  const lease = value as TemporaryLlmBudgetLease | null;
  if (!lease || lease.version !== 1 || lease.service !== "llm" || typeof lease.id !== "string" ||
      !["active","restored","superseded"].includes(lease.status) || !Number.isFinite(Date.parse(lease.activatedAt)) || !Number.isFinite(Date.parse(lease.expiresAt)) ||
      !lease.original || !lease.temporary || !Number.isFinite(Date.parse(lease.temporary.updatedAt)) ||
      lease.original.perMinute !== 20 || lease.original.perHour !== 180 || lease.original.perDay !== 800 ||
      lease.temporary.perMinute !== 20 || lease.temporary.perHour !== 180 || lease.temporary.perDay !== 2000) {
    // Do not continue sending against a larger budget whose expiration cannot be established.
    throw new Error("Temporary LLM budget lease is invalid; administrator review is required");
  }
  return lease;
}

async function saveLease(db: Db, lease: TemporaryLlmBudgetLease, actor: string) {
  await db`INSERT INTO settings (key,value,updated_by) VALUES (${TEMPORARY_LLM_BUDGET_KEY},${db.json(lease as never)},${actor})
    ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`;
}

async function lockedRestore(db: Db): Promise<TemporaryLlmBudgetRestore> {
  await db`SELECT pg_advisory_xact_lock(hashtext('budget:llm'))`;
  const [saved] = await db<{ value: unknown }[]>`SELECT value FROM settings WHERE key=${TEMPORARY_LLM_BUDGET_KEY} FOR UPDATE`;
  if (!saved) return { restored: false,status: "none" };
  const lease = parseLease(saved.value);
  if (lease.status !== "active") return { restored: false,status: lease.status,expiresAt: lease.expiresAt };
  const [clock] = await db<{ expired: boolean; text: string }[]>`SELECT clock_timestamp()>=${lease.expiresAt}::timestamptz AS expired,
    to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS text`;
  const before = await budgetRow(db,true);
  const expected = lease.temporary;
  const same = before && before.perMinute === expected.perMinute && before.perHour === expected.perHour &&
    before.perDay === expected.perDay && before.note === expected.note && before.updatedAt === expected.updatedAt;
  if (same && !clock!.expired) return { restored: false,status: "active",expiresAt: lease.expiresAt };
  if (same) {
    const original = lease.original;
    await db`UPDATE budgets SET per_minute=${original.perMinute},per_hour=${original.perHour},per_day=${original.perDay},
      note=${original.note},updated_at=clock_timestamp() WHERE service='llm'`;
  }
  const ended: TemporaryLlmBudgetLease = { ...lease,status: same ? "restored" : "superseded",endedAt: clock!.text };
  await saveLease(db,ended,"system:temporary-budget");
  await audit("system:temporary-budget",same ? "budget.temporary.restore" : "budget.temporary.superseded","budget:llm",
    same ? "24-hour temporary LLM budget expired" : "Budget changed after temporary activation; preserve administrator settings",
    { leaseId: lease.id,budget: before },{ leaseId: lease.id,status: ended.status,budget: await budgetRow(db) },{ db });
  return { restored: !!same,status: ended.status,expiresAt: lease.expiresAt };
}

/** Use the same transaction when called after paidRequest's budget lock; standalone calls commit independently. */
export async function restoreExpiredLlmBudget(db: Db = sql): Promise<TemporaryLlmBudgetRestore> {
  return "begin" in db ? (db as typeof sql).begin(lockedRestore) : lockedRestore(db);
}

export async function activateTemporaryLlmBudget(actor: string, reason: string, db: Db = sql): Promise<{ lease: TemporaryLlmBudgetLease; expiresAt: string }> {
  if (!actor.trim() || !reason.trim()) throw new Error("actor and reason are required");
  const run = async (tx: Db) => {
    await lockedRestore(tx);
    const [saved] = await tx<{ value: unknown }[]>`SELECT value FROM settings WHERE key=${TEMPORARY_LLM_BUDGET_KEY} FOR UPDATE`;
    if (saved && parseLease(saved.value).status === "active") throw new Error("An unexpired temporary LLM budget lease already exists");
    const original = await budgetRow(tx,true);
    if (!original || original.perMinute !== 20 || original.perHour !== 180 || original.perDay !== 800) {
      throw new Error("Temporary activation requires the existing LLM budget 20/minute, 180/hour, 800/day");
    }
    const [clock] = await tx<{ at: string; expires: string }[]>`SELECT
      to_char(t.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
      to_char((t.at+interval '24 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires
      FROM (SELECT clock_timestamp() AS at) t`;
    await tx`UPDATE budgets SET per_day=2000,updated_at=clock_timestamp() WHERE service='llm'`;
    const temporary = (await budgetRow(tx))!;
    const lease: TemporaryLlmBudgetLease = {
      version: 1,id: randomUUID(),service: "llm",status: "active",actor,reason,activatedAt: clock!.at,expiresAt: clock!.expires,original,temporary,
    };
    await saveLease(tx,lease,actor);
    await audit(actor,"budget.temporary.activate","budget:llm",reason,
      { budget: original },{ leaseId: lease.id,budget: temporary,expiresAt: lease.expiresAt,maximumNewAttempts: TEMPORARY_LLM_NEW_ATTEMPTS },{ db: tx });
    return { lease,expiresAt: lease.expiresAt };
  };
  return "begin" in db ? (db as typeof sql).begin(run) : run(db);
}

/** Status is read-only; displaying a budget never extends or activates a lease. */
export async function temporaryLlmBudgetStatus(db: Db = sql): Promise<{ lease: TemporaryLlmBudgetLease | null; budget: Budget | null }> {
  const [saved] = await db<{ value: unknown }[]>`SELECT value FROM settings WHERE key=${TEMPORARY_LLM_BUDGET_KEY}`;
  return { lease: saved ? parseLease(saved.value) : null,budget: await budgetRow(db) };
}

/** Read under the receipt's budget:llm lock, after expiration/supersession checks. Saved answers do not reserve an attempt. */
export async function temporaryLlmAllowance(db: Db = sql): Promise<TemporaryLlmAllowance | null> {
  const [saved] = await db<{ value: unknown }[]>`SELECT value FROM settings WHERE key=${TEMPORARY_LLM_BUDGET_KEY}`;
  if (!saved) return null;
  const lease = parseLease(saved.value);
  if (lease.status !== "active") return null;
  const current = await budgetRow(db);
  const expected = lease.temporary;
  if (!current || current.perMinute !== expected.perMinute || current.perHour !== expected.perHour ||
      current.perDay !== expected.perDay || current.note !== expected.note || current.updatedAt !== expected.updatedAt) return null;
  const [row] = await db<{ used: number; remaining: number }[]>`SELECT
    (SELECT count(*)::int FROM receipt_attempts WHERE service='llm' AND origin='live' AND started_at>=${lease.activatedAt}::timestamptz) AS used,
    ceil(extract(epoch FROM (${lease.expiresAt}::timestamptz-clock_timestamp())))::int AS remaining`;
  if (row!.remaining <= 0) return null;
  return { exhausted: row!.used>=TEMPORARY_LLM_NEW_ATTEMPTS,retryAfterSeconds: Math.max(1,row!.remaining),used: row!.used,limit: TEMPORARY_LLM_NEW_ATTEMPTS };
}
