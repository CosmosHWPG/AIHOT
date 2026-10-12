// Public directory metadata only. Isolated resource material never bypasses news publication rules.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";

export interface ResourceEntry {
  id: string;
  name: string;
  category: string;
  url: string | null;
  description: string;
  status: "monitored" | "needs_scope" | "reference" | "paused";
  checkedAt: string | null;
}

interface SourceDefinition { id: string; name: string; tags?: string[] }
interface Profile {
  nonArticle?: boolean;
  policy: string;
  verification?: { checkedAt?: string };
  catalogPlan?: { publicURL?: string; publicUrl?: string; title?: string; category?: string; description?: string; type?: string; required?: string; status?: string };
}
interface SourceStatus { id: string; enabled: boolean; last_fetch_at: Date | null }

function publicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (/\[REDACTED\]/i.test(value) || [...url.searchParams.keys()].some((key) => /token|secret|password|api.?key|auth|signature|cookie|credential/i.test(key))) return null;
    return url.toString();
  } catch { return null; }
}

/** Explicitly project a public shape; adapters, verification samples and private raw material stay private. */
export function resourceDirectory(sources: SourceDefinition[], profiles: Record<string, Profile>, originals: Map<string, string>, statuses: SourceStatus[] = []): ResourceEntry[] {
  const state = new Map(statuses.map((source) => [source.id, source]));
  return sources.filter((source) => profiles[source.id]?.nonArticle === true).map((source) => {
    const profile = profiles[source.id]!;
    const plan = profile.catalogPlan;
    const current = state.get(source.id);
    const verified = profile.policy === "native";
    const checked = current?.last_fetch_at?.toISOString() ?? profile.verification?.checkedAt;
    const checkedAt = checked && Number.isFinite(Date.parse(checked)) ? new Date(checked).toISOString() : null;
    return {
      id: source.id,
      name: plan?.title || source.name,
      category: plan?.category || "研究与开发资源",
      url: publicUrl(plan?.publicURL ?? plan?.publicUrl) ?? publicUrl(originals.get(source.id)),
      description: plan?.description || (verified ? "按明确条目监测资源更新，保留原始链接。" : "保留目录入口；确定关注对象后再监测具体更新。"),
      status: current && verified && !current.enabled ? "paused" : verified ? "monitored" : plan?.status === "needs_scope" ? "needs_scope" : "reference",
      checkedAt,
    };
  });
}

export async function loadResourceDirectory() {
  const profilesFile = path.join(REPO_ROOT, "industry/corescope-source-profiles.json");
  if (!existsSync(profilesFile)) return { resources: [] as ResourceEntry[] };
  const sources = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/sources.json"), "utf8")).sources as SourceDefinition[];
  const profiles = JSON.parse(readFileSync(profilesFile, "utf8")).profiles as Record<string, Profile>;
  const mapping = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs/corescope-v2-sources.json"), "utf8")).sources as Array<{ canonical_source_id: string | null; original_url?: string }>;
  const originals = new Map<string, string>();
  for (const source of mapping) if (source.canonical_source_id && source.original_url && !originals.has(source.canonical_source_id)) originals.set(source.canonical_source_id, source.original_url);
  const ids = sources.filter((source) => profiles[source.id]?.nonArticle === true).map((source) => source.id);
  const statuses = ids.length ? await sql<SourceStatus[]>`SELECT id,enabled,last_fetch_at FROM sources WHERE id = ANY(${ids}::text[])` : [];
  return { resources: resourceDirectory(sources, profiles, originals, statuses) };
}
