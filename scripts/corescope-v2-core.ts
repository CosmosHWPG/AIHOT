// Internal raw-material bridge. It deliberately uses the same material, queue,
// receipts and public projection as native collectors; V2 analysis is metadata.
import { sql, type Db } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { normalizeUrl } from "@aihot/backend/lib/url";

export interface BridgeCursor {
  updatedAt: string; id: number;
  scanAfter?: { updatedAt: string; id: number } | null;
  liveFloor?: { updatedAt: string; id: number };
}
export interface BridgeSource {
  id: string; name: string; kind: string; config: Record<string, unknown>; tier: string;
  first_party: boolean; owner_entity_id: string | null; signal_group_id: string | null;
  participation_mode: string; interval_minutes: number; tags: string[];
  site_fulltext: boolean; syndicate_fulltext: boolean; enabled: boolean;
}
export interface BridgeItem {
  v2Id: number; v2ArticleId: string | null; v2SourceId: string | null; sourceId: string; sourceAlias: string;
  title: string; url: string; language: string | null; publishedAt: string | null; discoveredAt: string | null;
  updatedAt: string | null; excerpt: string | null; bodyText: string | null;
  bodyStatus: "pending" | "unconfirmed"; fingerprint: string;
  bodyEvidence: Record<string, unknown>; sourceEvidence: Record<string, unknown>[]; v2Metadata: Record<string, unknown>;
}
export interface BridgeBatch {
  schemaVersion: number; client: string; generatedAt: string; initialSince: string;
  cursorBefore: BridgeCursor | null; cursorAfter: BridgeCursor | null; hasMore: boolean;
  sources: BridgeSource[]; items: BridgeItem[]; dataLatest: Record<string, unknown>;
}

function date(value: string | null): Date | null {
  const d = value ? new Date(value) : null;
  return d && Number.isFinite(d.getTime()) ? d : null;
}

export function validateBatch(input: unknown): BridgeBatch {
  if (!input || typeof input !== "object") throw new Error("Bridge batch must be an object");
  const b = input as BridgeBatch;
  if (b.schemaVersion !== 1 || b.client !== "corescope-v2" || !Array.isArray(b.items) || !Array.isArray(b.sources)) {
    throw new Error("Unsupported bridge batch");
  }
  if (b.items.length > 60) throw new Error("A bridge batch is limited to 60 materials");
  if (!date(b.initialSince)) throw new Error("initialSince must be an ISO timestamp");
  const ids = new Set(b.sources.map((s) => s.id));
  for (const it of b.items) {
    if (!Number.isSafeInteger(it.v2Id) || !it.title?.trim() || !ids.has(it.sourceId) || !/^[a-f0-9]{64}$/.test(it.fingerprint)) {
      throw new Error("Invalid bridge material identity or source");
    }
    const url = new URL(it.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || [...url.searchParams.keys()].some((k) => /token|secret|password|api[-_]?key|auth|signature|cookie|credential/i.test(k))) {
      throw new Error(`Unsafe original URL for V2 material ${it.v2Id}`);
    }
    if (!date(it.discoveredAt)) throw new Error(`Missing original discovery time for V2 material ${it.v2Id}`);
    if (!["pending", "unconfirmed"].includes(it.bodyStatus) || it.bodyEvidence?.fulltextVerified !== false) {
      throw new Error("V2 raw content has no fulltext verification contract");
    }
  }
  return b;
}

async function seedSources(sources: BridgeSource[], db: Db) {
  for (const s of sources) {
    await db`
      INSERT INTO sources (id,name,kind,config,tier,first_party,owner_entity_id,signal_group_id,
        participation_mode,interval_minutes,tags,site_fulltext,syndicate_fulltext,enabled,next_fetch_at,imported_from)
      VALUES (${s.id},${s.name},${s.kind},${db.json(s.config as never)},${s.tier},${s.first_party},${s.owner_entity_id},
        ${s.signal_group_id},${s.participation_mode},${s.interval_minutes},${s.tags},false,false,${s.enabled},now(),'corescope-source-fusion')
      ON CONFLICT (id) DO NOTHING`;
    // Upstream seed.ts does not yet import signal_group_id. Fill that omission,
    // preserving an operator's existing explicit independent-subject grouping.
    await db`UPDATE sources SET signal_group_id = ${s.signal_group_id}
             WHERE id = ${s.id} AND signal_group_id IS NULL AND ${s.signal_group_id}::text IS NOT NULL`;
  }
}

function sameCursor(a: BridgeCursor | null, b: BridgeCursor | null): boolean {
  if (!a || !b) return a === b;
  return a.updatedAt === b.updatedAt && a.id === b.id
    && (a.scanAfter?.updatedAt ?? null) === (b.scanAfter?.updatedAt ?? null)
    && (a.scanAfter?.id ?? null) === (b.scanAfter?.id ?? null)
    && (a.liveFloor?.updatedAt ?? null) === (b.liveFloor?.updatedAt ?? null)
    && (a.liveFloor?.id ?? null) === (b.liveFloor?.id ?? null);
}

/** Atomic progress: no cursor acknowledgment can survive a failed material/queue write. */
export async function importBatch(input: unknown, opts: { queue?: boolean; db?: typeof sql } = {}) {
  const batch = validateBatch(input);
  const connection = opts.db ?? sql;
  return connection.begin(async (tx) => {
    await tx`INSERT INTO corescope_bridge_state (client,initial_since) VALUES (${batch.client},${date(batch.initialSince)})
             ON CONFLICT (client) DO NOTHING`;
    const [state] = await tx<{ cursor: BridgeCursor | null }[]>`SELECT cursor FROM corescope_bridge_state WHERE client=${batch.client} FOR UPDATE`;
    const cursorMatches = sameCursor(state!.cursor, batch.cursorBefore);
    if (!cursorMatches) {
      // A retried already-committed file succeeds without rolling progress back.
      const ids = batch.items.map((i) => i.v2Id);
      const known = ids.length ? await tx<{ upstream_id: number; raw_fingerprint: string }[]>`
        SELECT upstream_id,raw_fingerprint FROM corescope_bridge_ledger WHERE client=${batch.client} AND upstream_id=ANY(${ids})` : [];
      const fingerprints = new Map(known.map((r) => [r.upstream_id, r.raw_fingerprint]));
      if (batch.items.length && batch.items.every((i) => fingerprints.get(i.v2Id) === i.fingerprint)) {
        return { received: batch.items.length, created: 0, revised: 0, unchanged: batch.items.length, queued: 0, replayed: true };
      }
      if (batch.items.length || !sameCursor(state!.cursor, batch.cursorAfter)) {
        throw new Error("Bridge cursor changed: export a fresh batch before importing");
      }
    }
    await seedSources(batch.sources, tx);
    let created = 0, revised = 0, unchanged = 0, queued = 0, nativeSkipped = 0;
    for (const it of batch.items) {
      const [source] = await tx<{ enabled: boolean; kind: string }[]>`SELECT enabled,kind FROM sources WHERE id=${it.sourceId} FOR SHARE`;
      if (!source?.enabled) throw new Error(`Bridge source ${it.sourceId} is paused; progress stays unchanged`);
      if (source.kind !== "external") {
        // An operator may promote this canonical source to native RSS. Its own
        // collector then owns updates; the bridge must not alternate revisions.
        nativeSkipped += 1;
        continue;
      }
      const [previous] = await tx<{ raw_fingerprint: string }[]>`
        SELECT raw_fingerprint FROM corescope_bridge_ledger WHERE client=${batch.client} AND upstream_id=${it.v2Id}`;
      if (previous?.raw_fingerprint === it.fingerprint) {
        unchanged += 1;
        continue;
      }
      const raw = { v2: { id: it.v2Id, articleId: it.v2ArticleId, sourceId: it.v2SourceId, sourceAlias: it.sourceAlias,
                         updatedAt: it.updatedAt, bodyEvidence: it.bodyEvidence, sourceEvidence: it.sourceEvidence,
                         priorAnalysis: it.v2Metadata }, bridge: { client: batch.client, rawFingerprint: it.fingerprint } };
      const normalizedUrl = normalizeUrl(it.url);
      if (!normalizedUrl) throw new Error(`Invalid original URL for V2 material ${it.v2Id}`);
      const result = await upsertMaterial({ sourceId: it.sourceId, url: normalizedUrl, title: it.title,
        language: it.language, publishedAt: date(it.publishedAt), discoveredAt: date(it.discoveredAt)!,
        excerpt: it.excerpt, bodyText: it.bodyText, bodyStatus: it.bodyStatus, raw, via: "ingest" }, tx);
      created += Number(result.created);
      revised += Number(result.revised);
      unchanged += Number(!result.created && !result.revised);
      // Changed evidence is retained even if the raw body is identical; it does
      // not manufacture a content revision or a paid analysis job.
      await tx`UPDATE articles SET raw = coalesce(raw,'{}'::jsonb) || ${tx.json(raw as never)}::jsonb
               WHERE id=${result.articleId} AND source_id=${it.sourceId}`;
      if ((result.created || result.revised) && opts.queue !== false) {
        queued += Number(!!(await queueProcessing(result.articleId, { db: tx })));
      }
      await tx`
        INSERT INTO corescope_bridge_ledger (client,upstream_id,upstream_article_id,source_alias,source_id,article_id,
          raw_fingerprint,upstream_updated_at,body_evidence,source_evidence)
        VALUES (${batch.client},${it.v2Id},${it.v2ArticleId},${it.sourceAlias},${it.sourceId},${result.articleId},${it.fingerprint},
          ${date(it.updatedAt)},${tx.json(it.bodyEvidence as never)},${tx.json(it.sourceEvidence as never)})
        ON CONFLICT (client,upstream_id) DO UPDATE SET
          article_id=excluded.article_id,source_alias=excluded.source_alias,source_id=excluded.source_id,
          raw_fingerprint=excluded.raw_fingerprint,upstream_updated_at=excluded.upstream_updated_at,
          body_evidence=excluded.body_evidence,source_evidence=excluded.source_evidence,acknowledged_at=now()`;
      await tx`UPDATE sources SET last_fetch_at=now(),last_ok_at=now(),health='ok',last_error=NULL WHERE id=${it.sourceId}`;
    }
    await tx`UPDATE corescope_bridge_state SET cursor=${batch.cursorAfter ? tx.json(batch.cursorAfter as never) : null},
      last_ok_at=now(),last_error=NULL,last_error_at=NULL,imported_count=imported_count+${created},updated_at=now()
      WHERE client=${batch.client}`;
    await tx`INSERT INTO ingest_events (client,kind,status,summary) VALUES (${batch.client},'items','ok',
      ${tx.json({ received: batch.items.length, created, revised, unchanged, queued, nativeSkipped, dataLatest: batch.dataLatest } as never)})`;
    return { received: batch.items.length, created, revised, unchanged, queued, nativeSkipped, replayed: false };
  });
}

export async function exportState() {
  const [state] = await sql<{ cursor: BridgeCursor | null; initial_since: Date | null }[]>`
    SELECT cursor,initial_since FROM corescope_bridge_state WHERE client='corescope-v2'`;
  const overlapAt = state?.cursor ? new Date(new Date(state.cursor.updatedAt).getTime() - 30 * 60_000) : new Date(0);
  const rows = state?.cursor ? await sql<{ upstream_id: number; raw_fingerprint: string }[]>`
    SELECT upstream_id,raw_fingerprint FROM corescope_bridge_ledger
    WHERE client='corescope-v2' AND upstream_updated_at >= ${overlapAt}` : [];
  const known = state?.cursor ? await sql<{ upstream_id: number }[]>`
    SELECT upstream_id FROM corescope_bridge_ledger WHERE client='corescope-v2'` : [];
  return { cursor: state?.cursor ?? null, initialSince: state?.initial_since?.toISOString() ?? null,
           seen: Object.fromEntries(rows.map((r) => [String(r.upstream_id), r.raw_fingerprint])),
           knownIds: known.map((r) => r.upstream_id) };
}
