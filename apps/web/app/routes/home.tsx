import { isCrossPerspective } from "@aihot/industry/perspectives";
import { PerspectiveBar } from "../features/feed/PerspectiveBar";
import { Link, redirect, useLoaderData } from "react-router";
import { SITE } from "@aihot/site";
import type { Route } from "./+types/home";
import type { PoolResponse, TimelineResponse } from "@aihot/contracts/site";
import { apiGet, cachedPage, loadOr404 } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { filterParams, hasFeedFilters, itemListLd, listPath, pageMeta, readFilters, siteLd } from "../lib/seo";
import { hotInNav } from "../components/shell/nav";
import type { Screen } from "../components/shell/screens";
import { Timeline } from "../features/feed/Timeline";
import { DayList } from "../features/feed/DayList";
import { recentPublicNews } from "../features/feed/recent-news";
import { HotTopics } from "../features/feed/HotTopics";
import { ActiveFilters, CategoryTabs, FeedBar, SearchField } from "../features/feed/Filters";

export const handle: Screen = { tab: "featured", name: "精选" };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const filters = readFilters(url.searchParams);
  const upstream = new Headers();
  const data = await loadOr404<TimelineResponse>(listPath("/api/site/timeline", filterParams(filters)), { responseHeaders: upstream, signal: request.signal });
  const recentNews = await recentPublicNews(data, () => apiGet<PoolResponse>(listPath("/api/site/pool", filterParams(filters)), { signal: request.signal }), request.signal);
  const allHref = listPath("/all", filterParams(filters));
  // A minute at most, here and on /all: new selections must not wait longer at the edge or in a browser.
  return cachedPage(60, { data, filters, recentNews, allHref }, upstream);
}

export function meta({ loaderData }: Route.MetaArgs) {
  const path = listPath("/", loaderData ? filterParams(loaderData.filters) : {});
  const titles = loaderData?.data.cards.map((c) => c.item.title) ?? [];
  const tags = pageMeta({ path, noindex: hasFeedFilters(loaderData?.filters), jsonLd: path === "/" ? [...siteLd(), itemListLd("/", "精选", titles)] : undefined });
  // Webmaster platforms look for their verification tag on the home page only.
  if (path !== "/") return tags;
  return [...tags, ...Object.entries(SITE.siteVerification).map(([name, content]) => ({ name, content }))];
}

export default function Home() {
  const { data, filters, recentNews, allHref } = useLoaderData<typeof loader>();
  const title = isCrossPerspective(filters.tag, filters.topic) ? "核心网 × AI 精选" : filters.tag ? `${filters.tag}精选` : "精选洞察";
  return (
    <div className="pb-6">
      {/* Phones: the bar (精选 | 全部, filter, search), the filter in use, today's hot topics, the feed. */}
      <FeedBar base="/" category={filters.category} channel={filters.channel} />
      <ActiveFilters base="/" category={filters.category} channel={filters.channel} tag={filters.tag} topic={filters.topic} />
      <PerspectiveBar base="/" tag={filters.tag} topic={filters.topic} />
      <h1 className="sr-only lg:not-sr-only lg:text-ui-heading-lg lg:font-semibold lg:leading-[1.3] lg:text-ink">
        {title}
      </h1>
      <div className="mb-5 mt-4 hidden items-center justify-between gap-4 lg:flex">
        <CategoryTabs base="/" category={filters.category} channel={filters.channel} layoutId="home-cat-desk" className="min-w-0" />
        <SearchField keep={{ ...filterParams(filters) }} />
      </div>

      {data.hot && hotInNav && <HotTopics entries={data.hot} />}

      {recentNews.length > 0 && (
        <section aria-label="最新公开动态" className="mb-7 mt-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[19px] font-semibold text-ink">最新公开动态</h2>
            <Link to={allHref} className="shrink-0 text-[12.5px] text-ink-3 hover:text-accent">查看全部动态 →</Link>
          </div>
          <p className="mb-2 mt-1 text-[12.5px] leading-6 text-ink-3">近48小时已分析公开的动态，按发布时间排列。下方保留精选洞察。</p>
          <DayList items={recentNews} timeBy="published" />
        </section>
      )}
      {recentNews.length > 0 && <h2 className="mb-1 text-[19px] font-semibold text-ink">精选洞察</h2>}
      <Timeline initial={data} filters={data.filters} />
    </div>
  );
}
