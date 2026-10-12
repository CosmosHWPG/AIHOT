import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/resources";
import { apiGet } from "../lib/api.server";
import { pageMeta } from "../lib/seo";

interface Resource {
  id: string; name: string; category: string; url: string | null; description: string;
  status: "monitored" | "needs_scope" | "reference" | "paused"; checkedAt: string | null;
}
const LABELS: Record<Resource["status"], string> = { monitored: "监测更新", needs_scope: "待确定关注对象", reference: "目录入口", paused: "监测已暂停" };

export async function loader({ request }: { request: Request }) {
  const result = await apiGet<{ resources: Resource[] }>("/api/site/resources", { signal: request.signal });
  return data(result, { headers: { "Cache-Control": "public, max-age=0, s-maxage=60" } });
}
export function headers({ loaderHeaders }: Route.HeadersArgs) { return loaderHeaders; }
export function meta() { return pageMeta({ title: "研究与开发资源", path: "/resources", description: "模型、软件包、社区与研究目录，按资源类型浏览和跟踪。" }); }

export default function ResourcesPage() {
  const { resources } = useLoaderData<typeof loader>();
  return <div className="pb-10">
    <header className="pb-5 pt-5 lg:pt-1">
      <h1 className="text-[24px] font-semibold text-ink">研究与开发资源</h1>
      <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-ink-3">模型、软件包、开源项目、播客与研究目录单独浏览。各资源按注明的范围单独采集与保存，可通过原始入口查看对应内容。</p>
    </header>
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {resources.map((resource) => <li key={resource.id} className="card flex flex-col p-5">
        <div className="flex items-start justify-between gap-3"><h2 className="text-[15px] font-bold text-ink">{resource.name}</h2><span className="whitespace-nowrap rounded bg-bg-sunk px-2 py-1 text-[10px] text-ink-3">{LABELS[resource.status]}</span></div>
        <p className="mt-2 text-[11px] text-accent">{resource.category}</p>
        <p className="mt-2 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{resource.description}</p>
        {resource.url && <a href={resource.url} target="_blank" rel="noopener noreferrer" className="mt-4 text-[12px] font-medium text-accent hover:underline">打开原始目录 →</a>}
      </li>)}
    </ul>
    {!resources.length && <p className="text-[13px] text-ink-3">资源目录尚未配置。</p>}
  </div>;
}
