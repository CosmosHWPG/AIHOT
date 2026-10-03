import { Link, useSearchParams } from "react-router";
import { isCrossPerspective, perspectiveFilters, PERSPECTIVES } from "@aihot/industry/perspectives";
import { PillTabs } from "../../components/ui/Tabs";
import { hrefWith } from "./Filters";

/** A perspective is a real persisted article tag; other feed filters stay in place. */
export function PerspectiveBar({ base, tag, topic }: { base: "/" | "/all"; tag: string | null; topic?: string | null }) {
  const [params] = useSearchParams();
  const perspective = PERSPECTIVES.find((p) => p.tag === tag);
  const cross = isCrossPerspective(tag, topic);
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-line-soft pb-3 pt-1">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0 text-[12px] text-ink-4">阅读视角</span>
        <PillTabs
          label="领域视角"
          size="xs"
          layoutId={`${base === "/" ? "home" : "all"}-perspective`}
          active={cross ? "cross" : perspective?.key ?? "all"}
          items={[
            { key: "all", label: "全部", to: hrefWith(base, params, perspectiveFilters("all")) },
            ...PERSPECTIVES.map((p) => ({ key: p.key, label: p.label, to: hrefWith(base, params, perspectiveFilters(p.key)) })),
            { key: "cross", label: "交叉", to: hrefWith(base, params, perspectiveFilters("cross")) },
          ]}
        />
      </div>
      {cross && <span className="text-[12px] text-ink-4">核心网 × AI</span>}
      <Link to={perspective ? `/topics?focus=${perspective.key}` : "/topics"} prefetch="intent" className="text-[12px] text-ink-3 transition-colors hover:text-accent">
        {perspective ? `${perspective.label}主题` : "技术主题"} <span aria-hidden="true">→</span>
      </Link>
    </div>
  );
}
