// Operator settings: about-page QR codes (replaced without a release), notification targets
// (switching a group on records enabled_at so older content is never back-filled) and per-service
// request budgets (the circuit breaker paid calls check before sending).
import type { AdminBudget, AdminBudgetUpdate, AdminNotifyTarget, AdminSettings, BeforeJson } from "@aihot/contracts/admin";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { sha256 } from "../lib/ids.ts";
import { loadContact, type ContactSettings } from "../site/contact.ts";
import { audit, Conflict } from "../audit.ts";
import { cancelTemporaryLlmBudget } from "../providers/temporary-budget.ts";
import { wakeLlmBudgetWaits } from "../jobs/budget-capacity.ts";

const MAX_QR_BYTES = 2 * 1024 * 1024;

export async function replaceContactQr(input: { slot: keyof ContactSettings; data: Buffer }, actor: string) {
  if (input.slot !== "wechatQr" && input.slot !== "feishuQr") throw new Error("unknown slot");
  if (input.data.length > MAX_QR_BYTES) throw new Error("二维码图片最大 2MB");
  const meta = await sharp(input.data).metadata().catch(() => null);
  if (!meta || !["png", "jpeg", "webp"].includes(meta.format ?? "")) throw new Error("需要 PNG、JPG 或 WebP 图片");
  if ((meta.width ?? 0) < 120 || (meta.height ?? 0) < 120) throw new Error("图片太小，二维码可能扫不出来");
  const ext = meta.format === "jpeg" ? "jpg" : meta.format!;
  const name = `qr-${input.slot === "wechatQr" ? "wechat" : "feishu"}-${sha256(input.data).slice(0, 8)}.${ext}`;
  const dir = path.join(config.dataDir, "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), input.data);
  const before = await loadContact();
  const next = { ...before, [input.slot]: `/contact/${name}` };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('contact_qr', ${sql.json(next)}, ${actor})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  await audit(actor, "settings.contact_qr", "settings:contact_qr", null, { [input.slot]: before[input.slot] }, { [input.slot]: next[input.slot] });
  return next;
}

/** The settings page: contact QR codes, content push targets and paid-service budgets. */
export async function settingsOverview(): Promise<BeforeJson<AdminSettings>> {
  const [contact, targets, budgets] = await Promise.all([loadContact(), listTargets(), listBudgets()]);
  return { contact, targets, budgets };
}

export async function listTargets(): Promise<BeforeJson<AdminNotifyTarget>[]> {
  return sql<BeforeJson<AdminNotifyTarget>[]>`
    SELECT t.key, t.purpose, t.kind, t.enabled, t.enabled_at, t.config_ref, t.note, t.updated_at,
           (SELECT count(*)::int FROM deliveries d WHERE d.target_key = t.key AND d.created_at > now() - interval '7 days') AS deliveries_7d,
           (SELECT max(d.sent_at) FROM deliveries d WHERE d.target_key = t.key) AS last_sent_at
    FROM notify_targets t ORDER BY t.purpose, t.key`;
}

export async function setTargetEnabled(key: string, enabled: boolean, reason: string, actor: string) {
  if (!reason?.trim()) throw new Error("reason is required");
  const [before] = await sql`SELECT enabled, enabled_at FROM notify_targets WHERE key = ${key}`;
  if (!before) return null;
  const [after] = await sql`
    UPDATE notify_targets SET enabled = ${enabled}, enabled_at = CASE WHEN ${enabled} AND NOT enabled THEN now() ELSE enabled_at END, updated_at = now()
    WHERE key = ${key} RETURNING key, enabled, enabled_at`;
  await audit(actor, enabled ? "notify.enable" : "notify.disable", `notify-target:${key}`, reason, before, after);
  return { ...after, pushEnabledHere: config.feishuContentPushEnabled };
}

export async function listBudgets(): Promise<BeforeJson<AdminBudget>[]> {
  return sql<BeforeJson<AdminBudget>[]>`
    SELECT b.service, b.enabled, b.per_minute, b.per_hour, b.per_day, b.note, b.updated_at,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 day') AS used_day,
           (SELECT count(*)::int FROM receipt_attempts a WHERE a.service = b.service AND a.origin = 'live' AND a.started_at > now() - interval '1 hour') AS used_hour
    FROM budgets b ORDER BY b.service`;
}

const LIMIT = z.number().int().min(0).max(2_147_483_647);
const BUDGET_UPDATE = z.object({
  enabled: z.boolean().optional(),
  perMinute: LIMIT.optional(),
  perHour: LIMIT.optional(),
  perDay: LIMIT.optional(),
  reason: z.string().trim().min(1),
  version: z.string().optional(),
}).strict().refine(value => value.enabled !== undefined || value.perMinute !== undefined || value.perHour !== undefined || value.perDay !== undefined,
  { message: "a budget switch or limit is required" });

export async function updateBudget(service: string, input: AdminBudgetUpdate, actor: string) {
  const patch = BUDGET_UPDATE.parse(input);
  return sql.begin(async tx => {
    // Share the paid-request/lease lock, so a claim cannot race a disabled/enabled transition.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`budget:${service}`}))`;
    const [before] = await tx<{ service: string; enabled: boolean; per_minute: number; per_hour: number; per_day: number; note: string | null; updated_at: Date }[]>`
      SELECT service,enabled,per_minute,per_hour,per_day,note,updated_at FROM budgets WHERE service=${service} FOR UPDATE`;
    if (patch.version !== undefined && (!before || before.updated_at.toISOString() !== patch.version)) {
      throw new Conflict("预算已被其他操作修改，请刷新后再改");
    }
    if (!before && (patch.perMinute === undefined || patch.perHour === undefined || patch.perDay === undefined)) {
      throw Object.assign(new Error("new budgets require perMinute, perHour and perDay"),{ statusCode: 400 });
    }
    // Validate the browser version before cancellation changes the budget's fingerprint. Only an
    // explicit LLM switch-off ends its temporary lease; omitted limits inherit the restored values.
    if (service === "llm" && patch.enabled === false) await cancelTemporaryLlmBudget(actor,patch.reason,tx);
    const [current] = await tx<{ enabled: boolean; per_minute: number; per_hour: number; per_day: number }[]>`
      SELECT enabled,per_minute,per_hour,per_day FROM budgets WHERE service=${service}`;
    const [after] = await tx`
      INSERT INTO budgets (service,enabled,per_minute,per_hour,per_day,note)
      VALUES (${service},${patch.enabled ?? current?.enabled ?? true},${patch.perMinute ?? current!.per_minute},
        ${patch.perHour ?? current!.per_hour},${patch.perDay ?? current!.per_day},${patch.reason})
      ON CONFLICT (service) DO UPDATE SET enabled=EXCLUDED.enabled,per_minute=EXCLUDED.per_minute,
        per_hour=EXCLUDED.per_hour,per_day=EXCLUDED.per_day,note=EXCLUDED.note,updated_at=clock_timestamp()
      RETURNING service,enabled,per_minute,per_hour,per_day,note,updated_at`;
    await audit(actor,"budget.update",`budget:${service}`,patch.reason,before ?? null,after,{ db: tx });
    if (service === "llm") await wakeLlmBudgetWaits(tx);
    return after;
  });
}
