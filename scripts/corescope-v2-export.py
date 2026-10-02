"""Read-only V2 source fusion and bounded raw-material export for CoreScope.

No V2 imports, HTTP requests, model calls or writes. Batch progress is committed by
the PostgreSQL importer, never by this exporter. Files containing bodies belong
under .data/, which is excluded from Git.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import html
from html.parser import HTMLParser
import json
import pathlib
import re
import sqlite3
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[1]
INACTIVE = {"暂停", "需删除", "去激活", "非文章页"}
LOOP_IDS = {9285, 9614, 9615, 9616, 9617}
PRIVATE = re.compile(r"token|secret|password|passwd|api[-_]?key|auth|signature|cookie|credential|access[-_]?key", re.I)
SUBSCRIPTION_FEED_HOSTS = {"rss.app", "www.rss.app", "kill-the-newsletter.com", "www.kill-the-newsletter.com"}
SOURCE_FIELDS = "id,source_id,name,status,source_channel_type,source_type,source_info_category,primary_board,board,access_method,language,source_tier,rss_url,original_url,created_at,updated_at,last_crawled_at,consecutive_failures,cooldown_until,last_ingest_failure_at"
OFFICIAL_OWNERS = {
    "openai.com": "openai", "anthropic.com": "anthropic", "deepmind.google": "google",
    "research.google": "google", "blog.google": "google", "huggingface.co": "hugging-face",
    "cloud.google.com": "google", "vllm.ai": "vllm", "qwen.ai": "alibaba",
    "ai.meta.com": "meta", "cncf.io": "cncf", "cisco.com": "cisco", "redhat.com": "red-hat",
    "microsoft.com": "microsoft", "nvidia.com": "nvidia", "aws.amazon.com": "amazon",
    "github.blog": "github", "mistral.ai": "mistral", "bair.berkeley.edu": "berkeley",
    "intel.com": "intel", "ericsson.com": "ericsson", "nokia.com": "nokia",
    "huawei.com": "huawei", "zte.com.cn": "zte", "3gpp.org": "3gpp",
    "etsi.org": "etsi", "itu.int": "itu", "gsma.com": "gsma", "o-ran.org": "o-ran",
    "tmforum.org": "tm-forum", "linuxfoundation.org": "linux-foundation",
}
PUBLISHER_GROUPS = {
    **OFFICIAL_OWNERS, "infoq.cn": "infoq-cn", "infoq.com": "infoq",
    "techcrunch.com": "techcrunch", "theverge.com": "the-verge",
    "arstechnica.com": "ars-technica", "technologyreview.com": "mit-tech-review",
    "the-decoder.com": "the-decoder", "simonwillison.net": "simon-willison",
    "importai.substack.com": "import-ai", "latent.space": "latent-space",
}


def url_parts(value: str | None):
    try:
        return urllib.parse.urlsplit(value or "")
    except ValueError:
        return urllib.parse.urlsplit("")


def credentialed(value: str | None) -> bool:
    p = url_parts(value)
    return bool(p.username or p.password or any(PRIVATE.search(k) for k, _ in urllib.parse.parse_qsl(p.query)))


def private_subscription_path(value: str | None) -> bool:
    p = url_parts(value)
    # These hosted feed routes use opaque subscription identifiers. Redact the
    # public audit copy only; the original feed still defines source identity.
    return bool((p.hostname or "").lower() in SUBSCRIPTION_FEED_HOSTS
                and p.path.startswith("/feeds/") and p.path[len("/feeds/"):])


def safe_url(value: str | None, *, subscription_entry: bool = False) -> str:
    p = url_parts(value)
    if not p.scheme:
        return ""
    hostname = p.hostname or ""
    if ":" in hostname:
        hostname = f"[{hostname}]"
    try:
        if p.port:
            hostname += f":{p.port}"
    except ValueError:
        return ""
    q = [(k, "[REDACTED]" if PRIVATE.search(k) else v) for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True)]
    redact_path = subscription_entry and private_subscription_path(value)
    path = "/feeds/[REDACTED]" + (".xml" if p.path.endswith(".xml") else "") if redact_path else p.path
    return urllib.parse.urlunsplit((p.scheme, hostname, path, urllib.parse.urlencode(q), ""))


def normalized_feed(value: str | None) -> str:
    if not value or credentialed(value):
        return ""
    p = url_parts(value)
    if p.scheme not in {"http", "https", "rsshub", "wx", "wechat"}:
        return ""
    # Preserve path case and all query/filter values. Never merge by domain alone.
    return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"), p.query, ""))


def mapped_host(value: str | None, mapping: dict[str, str]) -> str | None:
    h = (url_parts(value).hostname or "").lower()
    return next((owner for host, owner in mapping.items() if h == host or h.endswith("." + host)), None)


def loop(row: dict, self_hosts: set[str]) -> bool:
    if row.get("id") in LOOP_IDS or "aihot" in (row.get("name") or "").lower():
        return True
    return any("aihot" in (url_parts(row.get(k)).hostname or "").lower()
               or url_parts(row.get(k)).netloc.lower() in self_hosts
               for k in ("rss_url", "original_url", "url"))


def source_pack(rows: list[dict], upstream: list[dict], self_hosts: set[str]) -> tuple[list[dict], list[dict], dict]:
    mapping: list[dict] = []
    canonical: dict[str, dict] = {}
    sources: list[dict] = []
    for row in sorted(rows, key=lambda r: (r.get("status") != "已接入", r["id"])):
        source_id = f"v2-source-{row['id']}"
        reason = "AIHOT/self-site feedback loop" if loop(row, self_hosts) else None
        # Two non-RSS website adapters can have different parsers. Only a complete,
        # identical feed address is sufficient evidence to collapse V2 entries.
        feed = normalized_feed(row.get("rss_url"))
        existing = canonical.get(feed) if feed else None
        canonical_id = existing["id"] if existing else source_id
        owner = mapped_host(row.get("original_url"), OFFICIAL_OWNERS)
        if not owner and row.get("source_channel_type") in {"官方公告/新闻稿", "标准组织/产业联盟"}:
            owner = mapped_host(row.get("rss_url"), OFFICIAL_OWNERS)
        publisher = mapped_host(row.get("original_url"), PUBLISHER_GROUPS)
        if not publisher:
            # RSSHub hosts are transports, not publishers. A public direct feed
            # can identify its publisher; a shared relay cannot.
            publisher = mapped_host(row.get("rss_url"), PUBLISHER_GROUPS)
        signal_group = f"publisher:{publisher}" if publisher else None
        if not signal_group and feed:
            signal_group = "feed:" + hashlib.sha256(feed.encode()).hexdigest()[:20]
        public = {k: row.get(k) for k in SOURCE_FIELDS.split(",") if k not in {"rss_url", "original_url"}}
        public.update({"rss_url": safe_url(row.get("rss_url"), subscription_entry=True),
                       "original_url": safe_url(row.get("original_url"), subscription_entry=True),
                       "aihot_source_id": source_id, "canonical_source_id": None if reason else canonical_id,
                       "excluded_reason": reason, "dedup_reason": "identical feed URL including query" if existing and not reason else None,
                       "bridge_enabled": row.get("status") == "已接入" and not reason,
                       "credentials_redacted": any(credentialed(row.get(k)) or private_subscription_path(row.get(k))
                                                   for k in ("rss_url", "original_url"))})
        mapping.append(public)
        if reason or existing:
            continue
        tags = list(dict.fromkeys(v for v in [row.get("primary_board") or row.get("board"), row.get("source_channel_type"), "V2只读桥"] if v))
        entry = {"id": source_id, "name": row["name"], "kind": "external", "config": {},
                 "tier": "T1" if owner else "T2", "first_party": bool(owner), "owner_entity_id": owner,
                 "signal_group_id": signal_group, "participation_mode": "editorial", "interval_minutes": 60,
                 "tags": tags, "site_fulltext": False, "syndicate_fulltext": False, "enabled": row.get("status") == "已接入"}
        sources.append(entry)
        if feed:
            canonical[feed] = entry
    upstream_aliases = []
    for s in upstream:
        feed = normalized_feed(s.get("config", {}).get("feedUrl"))
        existing = canonical.get(feed) if feed else None
        if existing:
            upstream_aliases.append({"source_id": s["id"], "canonical_source_id": existing["id"], "reason": "identical upstream/V2 feed URL including query"})
            # Published upstream official classification is stronger than V2 P0,
            # which is a routing priority rather than source authority.
            for key in ("tier", "first_party", "owner_entity_id"):
                if s.get(key) is not None:
                    existing[key] = s[key]
            if not existing["enabled"]:
                # A V2 candidate with no connected collector must not disable an
                # upstream working RSS route. Keep the V2 ID, choose native RSS.
                existing["kind"] = "rss"
                existing["config"] = {**s.get("config", {}), "_aihot": {"initialBackfillLimit": 2}}
                existing["enabled"] = True
            continue
        entry = {**s, "enabled": True}
        entry["config"] = {**s.get("config", {}), "_aihot": {"initialBackfillLimit": 2}}
        publisher = mapped_host(s.get("config", {}).get("feedUrl"), PUBLISHER_GROUPS)
        entry["signal_group_id"] = f"publisher:{publisher}" if publisher else "feed:" + hashlib.sha256(feed.encode()).hexdigest()[:20]
        sources.append(entry)
    summary = {"v2_sources": len(rows), "feedback_loops_excluded": sum(bool(r["excluded_reason"]) for r in mapping),
               "v2_duplicate_aliases": sum(bool(r["dedup_reason"]) for r in mapping), "upstream_sources": len(upstream),
               "upstream_duplicate_aliases": len(upstream_aliases), "upstream_native_rss": sum(s["kind"] == "rss" for s in sources),
               "canonical_sources": len(sources), "enabled_sources": sum(s["enabled"] for s in sources),
               "upstream_aliases": upstream_aliases}
    return sources, sorted(mapping, key=lambda r: r["id"]), summary


def json_value(value, fallback):
    try:
        return json.loads(value) if value else fallback
    except (ValueError, TypeError):
        return fallback


def text(value) -> str:
    return value if isinstance(value, str) else ""


class SourceTextParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.ignored = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.ignored += 1
        if tag in {"p", "div", "li", "br", "h1", "h2", "h3", "tr"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"} and self.ignored:
            self.ignored -= 1
        if tag in {"p", "div", "li", "h1", "h2", "h3", "tr"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.ignored:
            self.parts.append(data)


def source_text(value: str) -> str:
    # Some feed adapters retain XML CDATA around their HTML payload. HTMLParser
    # treats the entire declaration as non-text unless the envelope is removed.
    value = re.sub(r"<!\[CDATA\[([\s\S]*?)\]\]>", lambda m: m.group(1), value)
    if not re.search(r"</?(?:p|div|ul|ol|li|span|h[1-6]|table|tr|strong|em|a|br)\b", value, re.I):
        return value.strip()
    parser = SourceTextParser()
    parser.feed(value)
    return html.unescape("".join(parser.parts)).strip()


def raw_material(row: dict, evidence: list[dict], mapping: dict) -> dict:
    original_raw = text(row.get("raw_content")).strip()
    body = source_text(original_raw)
    excerpt = source_text(text(row.get("summary")))
    origin = "original_raw_unverified" if body else "missing"
    if body and re.sub(r"\s+", "", body) == re.sub(r"\s+", "", excerpt):
        origin = "source_excerpt_only"
    metadata = json_value(row.get("paper_metadata_json"), {})
    abstract = text(metadata.get("abstract")) if isinstance(metadata, dict) else ""
    if body and abstract and re.sub(r"\s+", "", body) == re.sub(r"\s+", "", abstract):
        origin = "paper_abstract_only"
    return {"v2Id": row["id"], "v2ArticleId": row.get("article_id"), "v2SourceId": row.get("source_id"),
            "sourceId": mapping["canonical_source_id"], "sourceAlias": mapping["aihot_source_id"],
            "title": text(row.get("title")), "url": text(row.get("url")), "language": row.get("language"),
            "publishedAt": row.get("publish_time"), "discoveredAt": row.get("crawled_at") or row.get("created_at"),
            "updatedAt": row.get("updated_at") or row.get("created_at"), "excerpt": excerpt or None,
            "bodyText": body if body and origin != "source_excerpt_only" else None,
            "bodyStatus": "unconfirmed" if body and origin != "source_excerpt_only" else "pending",
            "bodyEvidence": {"origin": origin, "fulltextVerified": False, "publicFulltextAllowed": False},
            "sourceEvidence": evidence,
            "v2Metadata": {"board": row.get("board"), "tags": json_value(row.get("tags_json"), []),
                           "canonicalPaperId": row.get("canonical_paper_id"), "parentDigestUrl": safe_url(row.get("parent_digest_url")),
                           "modelTitle": row.get("model_title"), "modelSummary": row.get("model_summary"),
                           "score": row.get("content_value_score"), "admissionLevel": row.get("admission_level"),
                           "originalRawContent": original_raw or None,
                           "analysisOrigin": "V2 prior analysis; metadata only, not CoreScope editorial output"}}


def fingerprint(item: dict) -> str:
    # Exclude V2 score/writing updates: they are metadata, not a new raw-content
    # revision and must not continually re-enqueue paid analysis.
    raw = {k: item[k] for k in ("sourceId", "title", "url", "language", "publishedAt", "discoveredAt", "excerpt", "bodyText", "bodyEvidence", "sourceEvidence")}
    return hashlib.sha256(json.dumps(raw, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def ensure_output(db: pathlib.Path, path: pathlib.Path) -> None:
    target = path.resolve()
    production = db.parent.parent
    if target == db or target == production or production in target.parents:
        raise ValueError("Output must stay outside the V2 production directory")


def write_json(path: pathlib.Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def export(args) -> dict:
    db = args.db.resolve(strict=True)
    for target in (args.out, args.source_pack, args.source_map):
        if target:
            ensure_output(db, target)
    self_hosts = {"127.0.0.1:8775", "localhost:8775", "127.0.0.1:3080", "localhost:3080"}
    self_hosts.update(url_parts(u).netloc.lower() for u in args.self_url)
    state = json.loads(args.state.read_text(encoding="utf-8")) if args.state and args.state.exists() else {}
    cursor = state.get("cursor")
    seen = state.get("seen", {})
    known_ids = {str(i) for i in state.get("knownIds", [])} | set(seen)
    since = args.since or state.get("initialSince") or (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=3 if args.bootstrap else 0)).isoformat()
    upstream = json.loads((ROOT / "docs/corescope-upstream-sources.json").read_text(encoding="utf-8"))["sources"]
    with contextlib.closing(sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=10)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")
        rows = [dict(r) for r in conn.execute(f"SELECT {SOURCE_FIELDS} FROM sources")]
        sources, mapping, summary = source_pack(rows, upstream, self_hosts)
        source_by_business = {r["source_id"]: r for r in mapping}
        latest = dict(conn.execute("SELECT MAX(crawled_at) crawled_at, MAX(updated_at) updated_at FROM articles").fetchone())
        upper_row = conn.execute("SELECT COALESCE(updated_at,created_at) updated_at,id FROM articles ORDER BY COALESCE(updated_at,created_at) DESC,id DESC LIMIT 1").fetchone()
        items = []
        scanned = 0
        after = cursor
        has_more = False
        article_ids = {int(v) for v in args.article_ids.split(",") if v} if args.article_ids else set()
        if not args.sources_only:
            # Re-read a bounded overlap and skip raw fingerprints acknowledged by
            # the importer. Rewinding without a ledger would starve newer rows.
            scan_position = cursor.get("scanAfter") if cursor else None
            start = scan_position["updatedAt"] if scan_position else cursor["updatedAt"] if cursor else since
            start_id = scan_position["id"] if scan_position else -1
            if cursor and not scan_position:
                start = (dt.datetime.fromisoformat(start.replace("Z", "+00:00")) - dt.timedelta(minutes=args.overlap_minutes)).isoformat()
            id_clause = f" AND a.id IN ({','.join('?' for _ in article_ids)})" if article_ids else ""
            records = conn.execute("""
                SELECT a.* FROM articles a
                WHERE (COALESCE(a.updated_at,a.created_at) > ?
                   OR (COALESCE(a.updated_at,a.created_at) = ? AND a.id > ?))
            """ + id_clause + """
                ORDER BY COALESCE(a.updated_at,a.created_at), a.id LIMIT ?
            """, (start, start, start_id, *sorted(article_ids), args.scan_limit + 1))
            scanned_position = None
            for record in records:
                row = dict(record)
                scanned += 1
                if scanned > args.scan_limit:
                    has_more = True
                    break
                position = {"updatedAt": row.get("updated_at") or row["created_at"], "id": row["id"]}
                scanned_position = position
                if not after or (position["updatedAt"], position["id"]) > (after["updatedAt"], after["id"]):
                    after = {**(after or {}), **position}
                live_floor = cursor.get("liveFloor") if cursor else None
                if live_floor:
                    if (position["updatedAt"], position["id"]) <= (live_floor["updatedAt"], live_floor["id"]):
                        continue
                    # Updating a historical V2 score is not new intake. Only new
                    # discoveries and revisions of already imported material are
                    # allowed past the live-start watermark.
                    if str(row["id"]) not in known_ids and text(row.get("crawled_at")) < live_floor["updatedAt"]:
                        continue
                source = source_by_business.get(row.get("source_id"))
                if not source or not source["canonical_source_id"] or not source["bridge_enabled"]:
                    continue
                if article_ids and row["id"] not in article_ids:
                    continue
                if row.get("gate_decision") == "crawl_error" or not text(row.get("title")).strip():
                    continue
                if not text(row.get("url")).startswith(("http://", "https://")) or credentialed(row.get("url")) or loop(row, self_hosts):
                    continue
                if not cursor and not article_ids and text(row.get("crawled_at")) < since:
                    continue
                evidence = []
                for e in conn.execute("SELECT * FROM article_source_evidence WHERE article_id=? ORDER BY id", (row["id"],)):
                    data = dict(e)
                    data["evidence_url"] = safe_url(data.get("evidence_url"))
                    data["parent_digest_url"] = safe_url(data.get("parent_digest_url"))
                    # No arbitrary provider payload or authentication headers.
                    data.pop("evidence_payload_json", None)
                    evidence.append(data)
                item = raw_material(row, evidence, source)
                item["fingerprint"] = fingerprint(item)
                if seen.get(str(row["id"])) == item["fingerprint"]:
                    continue
                items.append(item)
                if len(items) >= args.limit:
                    has_more = True
                    break
            if after:
                after = {**after, "scanAfter": scanned_position if has_more else None}
            if args.bootstrap and upper_row:
                # Bootstrap is an explicitly bounded historical sample, not the
                # start of a silent paid replay of every remaining historical row.
                floor = {"updatedAt": upper_row["updated_at"], "id": upper_row["id"]}
                after = {**floor, "scanAfter": None, "liveFloor": floor}
                has_more = False
            elif not cursor and upper_row:
                # Ordinary first start begins at the current source watermark.
                # --since still allows explicitly requested bounded history.
                floor = {"updatedAt": since, "id": -1}
                after = {**(after or {"updatedAt": upper_row["updated_at"], "id": upper_row["id"]}), "liveFloor": floor}
        conn.rollback()
    if args.source_pack:
        write_json(args.source_pack, {"$comment": "CoreScope fusion: identical feed aliases are in docs/corescope-v2-sources.json; external feeds arrive through the read-only V2 bridge.", "sources": sources})
    if args.source_map:
        write_json(args.source_map, {"schemaVersion": 1, "sources": mapping, "summary": summary})
    batch = {"schemaVersion": 1, "client": "corescope-v2", "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
             "initialSince": since, "cursorBefore": cursor, "cursorAfter": after, "hasMore": has_more,
             "sourceRead": "SQLite mode=ro, PRAGMA query_only=ON, bounded read transaction", "dataLatest": latest,
             "scanned": scanned, "sourceSummary": summary, "sources": sources, "items": items}
    if args.out:
        write_json(args.out, batch)
    return {"items": len(items), "scanned": scanned, "hasMore": has_more, "dataLatest": latest, **{k: v for k, v in summary.items() if k != "upstream_aliases"}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path)
    parser.add_argument("--source-pack", type=pathlib.Path)
    parser.add_argument("--source-map", type=pathlib.Path)
    parser.add_argument("--state", type=pathlib.Path)
    parser.add_argument("--sources-only", action="store_true")
    parser.add_argument("--bootstrap", action="store_true", help="Bounded history sample; afterward resume at the snapshot upper watermark")
    parser.add_argument("--since")
    parser.add_argument("--article-ids", default="")
    parser.add_argument("--limit", type=int, default=6)
    parser.add_argument("--scan-limit", type=int, default=5000)
    parser.add_argument("--overlap-minutes", type=int, default=15)
    parser.add_argument("--self-url", action="append", default=[])
    args = parser.parse_args()
    if not 1 <= args.limit <= 60 or not 1 <= args.scan_limit <= 20000:
        parser.error("limit must be 1..60 and scan-limit 1..20000")
    print(json.dumps(export(args), ensure_ascii=False))


if __name__ == "__main__":
    main()
