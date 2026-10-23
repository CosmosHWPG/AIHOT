import { SITE } from "@aihot/industry/site";
import { useRef, useState } from "react";
import type { AdminSettings } from "@aihot/contracts/admin";
import type { Route } from "./+types/settings";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Input, ReasonDialog } from "../../features/admin/ui";
import { toast } from "../../features/admin/toast";
import { budgetChanged, budgetDraft, budgetUpdate } from "../../features/admin/budget";


export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<AdminSettings>(request, "/api/admin/settings");
}

export const meta: Route.MetaFunction = () => [{ title: `设置 · ${SITE.name} 后台` }];

function QrSlot({ slot, label, src }: { slot: "wechatQr" | "feishuQr"; label: string; src: string | null }) {
  const { run, pending } = useAdminAction();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-4">
      {src ? <img src={src} alt={label} className="size-28 rounded-card bg-white object-contain p-1.5 ring-1 ring-line" /> : <div className="flex size-28 shrink-0 items-center justify-center rounded-card bg-surface text-sm text-ink-4 ring-1 ring-line">未设置</div>}
      <div>
        <div className="text-[14px] font-medium text-ink">{label}</div>
        <div className="mt-0.5 break-all font-mono text-[11.5px] text-ink-4">{src}</div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.size > 2 * 1024 * 1024) return toast("图片最大 2MB", "error");
            const image = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            await run("POST", "/api/admin/settings/contact-qr", { slot, image }, { label: `qr-${slot}`, success: `${label}已更换，关于页 5 分钟内更新` });
          }}
        />
        <Button className="mt-2" size="sm" busy={pending === `qr-${slot}`} onClick={() => input.current?.click()}>更换图片</Button>
      </div>
    </div>
  );
}

function BudgetRow({ b }: { b: AdminSettings["budgets"][number] }) {
  const { run, pending } = useAdminAction();
  const [v, setV] = useState(() => budgetDraft(b));
  const [reason, setReason] = useState("");
  const changed = budgetChanged(b, v);
  const update = budgetUpdate(b, v, reason);
  const saving = pending === "budget";
  return (
    <tr className="border-b border-line/70 last:border-0">
      <td className="px-3 py-2 font-mono text-[12.5px]">{b.service}</td>
      <td className="px-3 py-2">
        <label className="flex items-center gap-2 whitespace-nowrap text-[12.5px] text-ink">
          <input type="checkbox" checked={v.enabled} disabled={saving} className="size-4 accent-accent"
            aria-label={`${b.service} 启用额度限制`}
            onChange={(event) => setV({ ...v, enabled: event.target.checked })} />
          启用额度限制
        </label>
        <div className="mt-1 max-w-52 text-[11.5px] text-ink-4">
          {v.enabled ? "超过上限后等待窗口恢复；0 会暂停服务。" : "请求照常计费，使用次数继续记录。"}
        </div>
      </td>
      {(["perMinute", "perHour", "perDay"] as const).map((k) => (
        <td key={k} className="px-3 py-2">
          <Input type="number" min={0} step={1} disabled={!v.enabled || saving}
            aria-label={`${b.service} ${k === "perMinute" ? "每分钟" : k === "perHour" ? "滚动小时" : "滚动24小时"}上限`}
            className="!w-24 !py-1 text-right disabled:opacity-50" value={Number.isFinite(v[k]) ? v[k] : ""}
            onChange={(e) => setV({ ...v, [k]: e.target.valueAsNumber })} />
        </td>
      ))}
      <td className="num px-3 py-2 text-right text-ink-3">{num(b.used_hour)} / {num(b.used_day)}</td>
      <td className="px-3 py-2">
        <Input value={reason} disabled={saving} placeholder="修改原因（写入审计）" aria-label={`${b.service} 修改原因`}
          className="!min-w-44 !py-1" onChange={(event) => setReason(event.target.value)} />
      </td>
      <td className="px-3 py-2 text-right">
        <Button size="sm" tone="primary" busy={saving} disabled={!update} title={changed && !reason.trim() ? "请填写修改原因" : undefined}
          onClick={async () => {
            if (!update) return;
            await run("PUT", `/api/admin/budgets/${encodeURIComponent(b.service)}`, update,
              { label: "budget", success: v.enabled ? "额度限制已更新" : "额度限制已关闭，计数继续记录" });
          }}>保存</Button>
      </td>
    </tr>
  );
}

function TargetToggle({ t }: { t: AdminSettings["targets"][number] }) {
  const { run, pending } = useAdminAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" tone={t.enabled ? "danger" : "primary"} onClick={() => setOpen(true)}>{t.enabled ? "停用" : "启用"}</Button>
      <ReasonDialog
        open={open}
        title={`${t.enabled ? "停用" : "启用"}：${t.note ?? t.key}`}
        description={t.enabled ? "停用后新的推送不再发往这个群。" : "启用时间会被记录：启用之前的内容不会补推。开发与彩排环境即使启用也不会真的发出。"}
        danger={t.enabled}
        confirmLabel={t.enabled ? "停用" : "启用"}
        busy={pending === "target"}
        onClose={() => setOpen(false)}
        onSubmit={async (reason) => (await run("POST", `/api/admin/notify-targets/${encodeURIComponent(t.key)}`, { enabled: !t.enabled, reason }, { label: "target", success: "已更新" })) !== null}
      />
    </>
  );
}

export default function SettingsAdmin({ loaderData: s }: Route.ComponentProps) {
  return (
    <AdminPage title="设置" subtitle="不改代码即可替换的运营设置。每次修改都写入审计记录。">
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="关于页二维码">
          <div className="space-y-5">
            <QrSlot slot="wechatQr" label="微信公众号二维码" src={s.contact.wechatQr} />
            <QrSlot slot="feishuQr" label="飞书群二维码" src={s.contact.feishuQr} />
          </div>
        </Card>
        <Card title="通知目的地" pad={false}>
          <DataTable
            rows={s.targets}
            rowKey={(t) => t.key}
            columns={[
              { key: "k", label: "目的地", render: (t) => <div><div className="font-medium text-ink">{t.note ?? t.key}</div><div className="font-mono text-[11.5px] text-ink-4">{t.key} · {t.config_ref}</div></div> },
              { key: "e", label: "状态", render: (t) => (t.enabled ? <Badge tone="ok">启用于 {bj(t.enabled_at)}</Badge> : <Badge>停用</Badge>) },
              { key: "d", label: "7 天投递", align: "right", render: (t) => num(t.deliveries_7d) },
              { key: "a", label: "", align: "right", render: (t) => <TargetToggle t={t} /> },
            ]}
          />
        </Card>
      </div>
      <Card className="mt-5" title="付费请求预算" right={<span>已用：滚动 1 小时 / 滚动 24 小时</span>} pad={false}>
        <p className="border-b border-line px-4 py-3 text-[12.5px] text-ink-3">
          各服务独立设置。关闭额度限制后继续记录使用次数，请求仍会产生费用；保留的上限在重新启用后生效。
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1024px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-ink-3">
                <th className="px-3 py-2 font-medium">服务</th>
                <th className="px-3 py-2 font-medium">额度开关</th>
                <th className="px-3 py-2 font-medium">每分钟</th>
                <th className="px-3 py-2 font-medium">滚动小时</th>
                <th className="px-3 py-2 font-medium">滚动24小时</th>
                <th className="px-3 py-2 text-right font-medium">已用</th>
                <th className="px-3 py-2 font-medium">修改原因</th>
                <th />
              </tr>
            </thead>
            <tbody>{s.budgets.map((b) => <BudgetRow key={`${b.service}-${b.updated_at}`} b={b} />)}</tbody>
          </table>
        </div>
      </Card>
    </AdminPage>
  );
}
