import type { FeedItemSummary, PoolResponse, TimelineResponse } from "@aihot/contracts/site";

const HOURS_48 = 48 * 3600_000;
function recent(item: FeedItemSummary, at: number): boolean {
  const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
  return Number.isFinite(published) && published >= at - HOURS_48 && published <= at;
}

/** An explicitly separate public sample while there are no fresh selected reports in this scope. */
export async function recentPublicNews(timeline: Pick<TimelineResponse, "cards" | "generatedAt">,
  readPool: () => Promise<PoolResponse>, signal?: AbortSignal): Promise<FeedItemSummary[]> {
  const at = Date.parse(timeline.generatedAt);
  if (!Number.isFinite(at) || timeline.cards.some(card => card.item.selected && recent(card.item, at))) return [];
  let pool: PoolResponse;
  try { pool = await readPool(); }
  catch (error) {
    if (signal?.aborted) throw error;
    return []; // The auxiliary sample cannot take down the selected timeline.
  }
  // A folded event can retain its older representative while a new selected report is public.
  if (pool.items.some(item => item.selected && recent(item, at))) return [];
  return pool.items.filter(item => !item.selected && recent(item, at))
    .sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!) || b.id.localeCompare(a.id))
    .slice(0, 6);
}
