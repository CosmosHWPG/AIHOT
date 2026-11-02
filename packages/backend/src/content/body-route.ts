// Pure publisher identity rules shared by normal extraction and the paid-provider prohibition.
import { BODY_ROUTES, JINA_DENIED_BODY_HOSTS } from "@aihot/industry/body-routes";

export type RoutineBodyRoute = { id: string; adapter: "rss" | "mittrchina" | "speechhome"; feedUrl?: string };

function publisher(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    const route = BODY_ROUTES.find(item => (item.hosts as readonly string[]).includes(host));
    return route ? { url, route } : null;
  } catch { return null; }
}

/** A publisher-wide instruction: even an unsupported article path must never buy a Jina answer. */
export function jinaDeniedPublisher(value: string): boolean {
  try { return JINA_DENIED_BODY_HOSTS.includes(new URL(value).hostname.toLowerCase().replace(/\.+$/, '')); }
  catch { return false; }
}

/** Body routing is narrower than Jina denial; a navigation/list page grants no article body. */
export function routineBodyRoute(value: string): RoutineBodyRoute | null {
  const found = publisher(value);
  if (!found) return null;
  const { url, route } = found;
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
  if (route.adapter === "rss") {
    if (!/^\/(?:[^/]+-[a-f0-9]{12}|p\/[a-f0-9]{12})\/?$/i.test(url.pathname)
      || [...url.searchParams.keys()].some(key => !/^(?:utm_[a-z_]+|fbclid|gclid|mc_cid|mc_eid|source)$/i.test(key))) return null;
    return { id: route.id, adapter: route.adapter, feedUrl: route.feedUrl };
  }
  if (url.search) return null;
  if (route.adapter === "mittrchina" && !/^\/news\/detail\/[1-9]\d{0,9}$/.test(url.pathname)) return null;
  if (route.adapter === "speechhome" && !/^\/(?:post|blogs\/all)\/[1-9]\d{0,24}$/.test(url.pathname)) return null;
  return { id: route.id, adapter: route.adapter };
}
