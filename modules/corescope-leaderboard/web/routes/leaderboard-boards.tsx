import type { Screen } from "../../../../apps/web/app/components/shell/screens";
export const handle: Screen = { tab: "leaderboard", name: "模型榜" };
import { SITE } from "@aihot/site";
import { PhoneBar } from "../../../../apps/web/app/components/shell/PhoneBar";
import { Link, Outlet } from "react-router";
import { BoardTabs } from "../features/leaderboard/BoardTabs";
import { IconArrowUpRight } from "../../../../apps/web/app/components/icons";

/** Shared caches may keep this page for five minutes. */
export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

/** Shared frame for the overall and category boards; only the board below it changes. */
export default function LeaderboardFrame() {
  const chip = "inline-flex h-8 items-center gap-1 rounded-full border border-line-strong bg-surface px-3.5 text-ui-caption-lg text-ink-2 transition-colors hover:border-ink-4 hover:text-ink";
  return (
    <div className="pb-10">
      <PhoneBar back={{ to: "/", label: "精选" }} title="模型榜" />
      <header className="flex flex-col gap-3 pb-4 pt-5 sm:flex-row sm:items-end sm:justify-between lg:pt-1">
        <div>
          <div className="mono text-ui-caption-sm font-semibold tracking-[0.16em] text-accent">{SITE.name.toUpperCase()} LEADERBOARD</div>
          <h1 data-page-title="" className="mt-1.5 text-ui-heading-lg font-semibold leading-[1.3] text-ink">AI 模型排行榜</h1>
        </div>
        <div className="flex gap-2">
          <Link to="/leaderboard/sources" className={chip}>
            评测来源 <IconArrowUpRight size={13} />
          </Link>
          <Link to="/leaderboard/rules" className={chip}>
            排名怎么算 <IconArrowUpRight size={13} />
          </Link>
        </div>
      </header>
      <div className="-mx-4 px-4 lg:mx-0 lg:px-0">
        <BoardTabs />
      </div>
      <Outlet />
    </div>
  );
}
