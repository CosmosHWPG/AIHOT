import { data as withHeaders, Link, useLoaderData } from "react-router";
import { subjectAfter, withSubject } from "@aihot/industry/site";
import catalog from "@aihot/industry/topics.json";
import { PERSPECTIVES } from "@aihot/industry/perspectives";
import type { Route } from "./+types/topics";
import { apiGet, releaseBoundCache } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PillTabs } from "../components/ui/Tabs";

interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function loader({ request }: { request: Request }) {
  const focusParam = new URL(request.url).searchParams.get("focus");
  const focus = PERSPECTIVES.find((p) => p.key === focusParam)?.key ?? "all";
  const upstream = new Headers();
  const data = await apiGet<{ topics: TopicSummary[]; refreshAt: string | null }>("/api/site/topics", { signal: request.signal, responseHeaders: upstream });
  return withHeaders({ ...data, groups: catalog.groups, focus }, { headers: releaseBoundCache(data.refreshAt, 300, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const description = loaderData
    ? `${subjectAfter(`按${loaderData.groups.map((g) => g.name).join("、")}聚合的`, "主题页")}，共 ${loaderData.topics.length} 个主题。`
    : withSubject("主题页");
  return pageMeta({ title: "主题", description, path: "/topics", image: "/og/pages/topics.png" });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export default function TopicsPage() {
  const { topics, groups, focus } = useLoaderData<typeof loader>();
  const perspective = PERSPECTIVES.find((p) => p.key === focus);
  const visible = perspective ? topics.filter((t) => t.group === "genre" || (perspective.topics as readonly string[]).includes(t.slug)) : topics;
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">技术主题</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          按技术问题、实际主体与内容形态积累精选，服务架构、标准、安全与商业决策。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <PillTabs label="主题领域" size="sm" layoutId="topics-perspective" active={focus} items={[
            { key: "all", label: "全部主题", to: "/topics" },
            ...PERSPECTIVES.map((p) => ({ key: p.key, label: p.label, to: `/topics?focus=${p.key}` })),
          ]} />
          <span className="text-[12px] text-ink-4">{perspective?.description ?? "核心网与 AI 的长期阅读索引"} · <span className="num">{visible.length}</span> 个主题</span>
        </div>
        {perspective && <p className="mt-2 text-[12px] text-ink-4">按领域浏览主题目录，通用主题同时涵盖核心网与 AI。</p>}
      </header>
      {groups.filter((g) => visible.some((t) => t.group === g.key)).map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[15px] font-bold text-ink">
              {g.name}
            </h2>
            <p className="text-[12px] text-ink-4">{g.blurb}</p>
          </div>
          <ul className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visible
              .filter((t) => t.group === g.key)
              .map((t) => (
                <li key={t.slug}>
                  <Link
                    to={`/topics/${t.slug}`}
                    prefetch="intent"
                    aria-label={`查看${t.name}相关精选文章`}
                    className="card card-hover group flex h-full flex-col px-5 py-[18px]"
                  >
                    <span className="text-[15px] font-bold text-ink transition-colors group-hover:text-accent">{t.name}</span>
                    <span className="mt-1.5 line-clamp-2 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{t.definition}</span>
                    <span className="mt-3 flex items-center justify-between gap-2 text-[11.5px]">
                      <span className="mono text-accent">{t.total} 条精选 <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">→</span></span>
                      <span className="text-ink-4">近 30 天 <span className="num">{t.recent}</span></span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
