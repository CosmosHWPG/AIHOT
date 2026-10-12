"""Read-only V2 source fusion and bounded raw-material export for CoreScope.

No V2 imports, HTTP requests, model calls or writes. Batch progress is committed by
the PostgreSQL importer, never by this exporter. Files containing bodies belong
under .data/, which is excluded from Git.
"""
from __future__ import annotations

import argparse
import base64
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
# Source governance labels are not collector health. V2 still collects eligible
# candidates; do not silently translate "候选" into a disconnected source.
BRIDGE_STATUSES = {"已接入", "已确认", "候选", "未确认", "待验证"}
INACTIVE = {"暂停", "需删除", "去激活"}
PROFILE_POLICIES = {"native", "bridge", "blocked"}
NATIVE_KINDS = {"rss", "web_list", "json_list", "x_search", "mp_account"}
LOOP_IDS = {9285, 9614, 9615, 9616, 9617}
PRIVATE = re.compile(r"token|secret|password|passwd|api[-_]?key|auth|signature|cookie|credential|access[-_]?key", re.I)
SUBSCRIPTION_FEED_HOSTS = {"rss.app", "www.rss.app", "kill-the-newsletter.com", "www.kill-the-newsletter.com"}
WECHAT_SUBSCRIPTION_HOSTS = {"wechat2rss.xlab.app", "wechat2rss.bestblogs.dev"}
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


def subscription_audit_path(value: str | None) -> str | None:
    p = url_parts(value)
    # These hosted feed routes use opaque subscription identifiers. Redact the
    # public audit copy only; the original feed still defines source identity.
    host = (p.hostname or "").lower()
    suffix = ".xml" if p.path.endswith(".xml") else ""
    if host in SUBSCRIPTION_FEED_HOSTS and p.path.startswith("/feeds/") and p.path[len("/feeds/"):]:
        return "/feeds/[REDACTED]" + suffix
    if host == "api.xgo.ing":
        match = re.fullmatch(r"(/rss/users?/)[a-f0-9]{20,}(?:\.xml)?/?", p.path, re.I)
        if match:
            return match[1] + "[REDACTED]" + suffix
    if host in WECHAT_SUBSCRIPTION_HOSTS and re.fullmatch(r"/feed/[a-f0-9]{20,}(?:\.xml)?/?", p.path, re.I):
        return "/feed/[REDACTED]" + suffix
    if host == "rss.jintiankansha.me" and re.fullmatch(r"/rss/[^/]{20,}/?", p.path):
        return "/rss/[REDACTED]" + suffix
    if re.search(r"(^|\.)google\.", host) and re.fullmatch(r"/alerts/feeds/[^/]+/[^/]+/?", p.path):
        return "/alerts/feeds/[REDACTED]/[REDACTED]"
    return None


def private_subscription_path(value: str | None) -> bool:
    return subscription_audit_path(value) is not None


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
    path = (subscription_audit_path(value) if subscription_entry else None) or p.path
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


def source_status_eligible(row: dict) -> bool:
    return str(row.get("status") or "").strip() in BRIDGE_STATUSES


def intake_url_parts(value: str, *, prefix: bool = False) -> tuple[str, int | None, str]:
    p = url_parts(value)
    if p.scheme.lower() not in {"http", "https"} or not p.hostname or credentialed(value):
        raise ValueError("Bridge intake URL must be an uncredentialed HTTP(S) publisher URL")
    if prefix and (p.query or p.fragment):
        raise ValueError("Bridge intake URL prefix must not contain query or fragment")
    if private_subscription_path(value):
        raise ValueError("Bridge intake URL must not contain a private subscription handle")
    try:
        host = urllib.parse.unquote(p.hostname, errors="strict").encode("idna").decode("ascii").lower().rstrip(".")
        port = p.port
        path = p.path or "/"
        for _ in range(3):
            decoded = urllib.parse.unquote(path, errors="strict")
            if decoded == path:
                break
            path = decoded
    except (ValueError, UnicodeError) as error:
        raise ValueError("Invalid bridge intake publisher URL") from error
    if not re.fullmatch(r"[a-z0-9.-]+", host) or re.search(r"[\x00-\x1f\x7f]|%(?:2e|2f|5c)", path, re.I):
        raise ValueError("Invalid bridge intake publisher URL")
    parts: list[str] = []
    for segment in path.replace("\\", "/").split("/"):
        if not segment or segment == ".":
            continue
        if segment == "..":
            if parts:
                parts.pop()
        else:
            parts.append(segment)
    default_port = 80 if p.scheme.lower() == "http" else 443
    return host, None if port in {None, default_port} else port, "/" + "/".join(parts)


def validate_intake_prefixes(value) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(p, str) for p in value):
        raise ValueError("bridgeIntakeUrlPrefixes must be an array of public publisher URL prefixes")
    for prefix in value:
        intake_url_parts(prefix, prefix=True)
    return value


def bridge_intake_allowed(url: str, prefixes: list[str] | None) -> bool:
    if prefixes is None:
        return True
    try:
        host, port, path = intake_url_parts(url)
    except ValueError:
        return False
    for prefix in prefixes:
        allowed_host, allowed_port, allowed_path = intake_url_parts(prefix, prefix=True)
        if host == allowed_host and port == allowed_port and (allowed_path == "/" or path == allowed_path or path.startswith(allowed_path + "/")):
            return True
    return False


def validate_profiles(manifest: dict) -> dict:
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("profiles"), dict):
        raise ValueError("Unsupported CoreScope source profile manifest")
    frozen = manifest.get("preserveDisabledSourceIds", [])
    if not isinstance(frozen, list) or any(not isinstance(v, str) for v in frozen):
        raise ValueError("preserveDisabledSourceIds must contain source IDs")
    for source_id, profile in manifest["profiles"].items():
        if not isinstance(source_id, str) or not isinstance(profile, dict) or profile.get("policy") not in PROFILE_POLICIES:
            raise ValueError("Invalid CoreScope source profile policy")
        if profile["policy"] == "bridge" and "bridgeIntakeUrlPrefixes" in profile:
            validate_intake_prefixes(profile["bridgeIntakeUrlPrefixes"])
        if profile["policy"] != "native":
            continue
        adapter = profile.get("adapter")
        if not isinstance(adapter, dict) or adapter.get("kind") not in NATIVE_KINDS or not isinstance(adapter.get("config"), dict):
            raise ValueError(f"Source profile {source_id} has no supported native adapter")
        verification = profile.get("verification")
        if not isinstance(verification, dict) or verification.get("status") != "verified":
            raise ValueError(f"Source profile {source_id} has no verified native route")
        # Profiles are committed public configuration. Subscription handles and
        # credentials must stay in a private runtime configuration, never here.
        def check_config(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if re.fullmatch(r"authorization|proxy-authorization|cookie|password|passwd|secret|token|api[-_]?key|access[-_]?key", str(key), re.I):
                        raise ValueError(f"Source profile {source_id} contains private request configuration")
                    check_config(child)
            elif isinstance(value, list):
                for child in value:
                    check_config(child)
            elif isinstance(value, str) and url_parts(value).scheme in {"http", "https"}:
                if credentialed(value) or private_subscription_path(value):
                    raise ValueError(f"Source profile {source_id} contains a private endpoint")
        check_config(adapter["config"])
    return manifest


def verified_mp_biz(config: dict) -> str | None:
    article = config.get("articleUrl")
    from_url = None
    if article:
        p = url_parts(article)
        if p.scheme != "https" or p.hostname != "mp.weixin.qq.com" or p.path != "/s":
            raise ValueError("MP source requires an original WeChat long link")
        from_url = dict(urllib.parse.parse_qsl(p.query)).get("__biz")
        if not from_url:
            raise ValueError("MP source article URL has no account biz")
    biz = config.get("biz") or from_url
    if biz:
        try:
            decoded = base64.b64decode(biz, validate=True)
        except (ValueError, TypeError) as error:
            raise ValueError("MP source has invalid biz") from error
        if not re.fullmatch(rb"[0-9]{8,10}", decoded) or base64.b64encode(decoded).decode() != biz:
            raise ValueError("MP source has invalid biz")
        if config.get("biz") and article and biz != from_url:
            raise ValueError("MP source biz and article URL disagree")
    return biz


def collector_identity(source: dict, row: dict | None = None) -> str:
    """An entry is an account or a complete effective collector route, never a name."""
    kind, config = source["kind"], source.get("config", {})
    if kind == "rss":
        # Filters can define separate editorial channels even on the same feed.
        filters = {k: v for k, v in config.items() if k not in {"feedUrl", "_aihot"}}
        return "rss:" + normalized_feed(config.get("feedUrl")) + ":" + json.dumps(filters, sort_keys=True)
    if kind == "x_search":
        match = re.fullmatch(r"from:([A-Za-z0-9_]{1,15})(?:\s+-filter:replies)?", str(config.get("query", "")).strip())
        return "x:" + match[1].lower() if match else ""
    if kind == "external" and row:
        p = url_parts(row.get("original_url"))
        if (p.hostname or "").lower() in {"x.com", "www.x.com", "twitter.com", "www.twitter.com"}:
            handle = p.path.strip("/")
            if re.fullmatch(r"[A-Za-z0-9_]{1,15}", handle):
                return "x:" + handle.lower()
    if kind == "mp_account":
        biz = verified_mp_biz(config)
        if biz:
            return "mp:" + biz
        if config.get("ghid"):
            return "mp-ghid:" + config["ghid"]
        if re.fullmatch(r"gh_[a-z0-9]+", str(config.get("account", "")), re.I):
            return "mp-ghid:" + config["account"].lower()
    if kind in {"web_list", "json_list"}:
        route = {k: v for k, v in config.items() if k != "_aihot"}
        return kind + ":" + json.dumps(route, sort_keys=True, ensure_ascii=False)
    return ""


def merge_supplements(sources: list[dict], source_rows: dict[str, dict], supplements: list[dict], self_hosts: set[str], profiles: dict) -> dict:
    by_id = {s["id"]: s for s in sources}
    identities = {collector_identity(s, source_rows.get(s["id"])): s["id"] for s in sources
                  if collector_identity(s, source_rows.get(s["id"]))}
    # A verified cache profile proves the selected account through its original
    # public article URLs. Display names alone never establish a WeChat alias.
    for s in sources:
        proof = profiles.get(s["id"], {}).get("verification", {})
        if s["kind"] != "mp_account" or s["config"].get("transport") != "wx_cache" or proof.get("status") != "verified":
            continue
        biz_set = set()
        for sample in proof.get("samples", []):
            p = url_parts(sample.get("url"))
            if p.scheme in {"http", "https"} and p.hostname == "mp.weixin.qq.com" and p.path == "/s":
                try:
                    biz = verified_mp_biz({"articleUrl": urllib.parse.urlunsplit(("https", p.netloc, p.path, p.query, ""))})
                    if biz:
                        biz_set.add(biz)
                except ValueError:
                    pass
        if len(biz_set) == 1:
            identities.setdefault("mp:" + next(iter(biz_set)), s["id"])
    aliases, added, pending = [], [], []
    for pack in supplements:
        if pack.get("schemaVersion") != 1 or not isinstance(pack.get("sources"), list):
            raise ValueError("Unsupported supplemental source manifest")
        for source in pack["sources"]:
            source_id = source.get("id")
            if not isinstance(source_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,79}", source_id):
                raise ValueError("Invalid supplemental source ID")
            if source.get("kind") not in NATIVE_KINDS or not isinstance(source.get("config"), dict):
                raise ValueError(f"Supplement {source_id} needs a native route")
            verification = pack.get("verifications", {}).get(source_id)
            if not isinstance(verification, dict) or verification.get("status") != "verified":
                raise ValueError(f"Supplement {source_id} has no reviewed route/identity verification")
            # Verification records state their scope: public collector parsing,
            # or an account identity plus tested adapter contract. Paid runtime
            # acceptance is recorded separately, never inferred here.
            validate_profiles({"schemaVersion": 1, "profiles": {source_id: {
                "policy": "native", "adapter": {"kind": source["kind"], "config": source["config"]},
                "verification": verification}}})
            if source["kind"] == "rss" and not normalized_feed(source["config"].get("feedUrl")):
                raise ValueError(f"Supplement {source_id} has no valid feed identity")
            def public_values(value):
                if isinstance(value, dict):
                    for child in value.values():
                        yield from public_values(child)
                elif isinstance(value, list):
                    for child in value:
                        yield from public_values(child)
                else:
                    yield value
            for value in public_values(source["config"]):
                if isinstance(value, str) and url_parts(value).scheme in {"http", "https"} and loop({"url": value}, self_hosts):
                    raise ValueError(f"Supplement {source_id} would collect an AIHOT/self-site feedback loop")
            if source.get("site_fulltext") or source.get("syndicate_fulltext"):
                raise ValueError(f"Supplement {source_id} requires a separate fulltext license review")
            if source_id in by_id:
                if collector_identity(source) != collector_identity(by_id[source_id], source_rows.get(source_id)):
                    raise ValueError(f"Supplement {source_id} conflicts with an existing route")
                continue
            identity = collector_identity(source)
            existing_id = identities.get(identity) if identity else None
            if existing_id:
                aliases.append({"source_id": source_id, "canonical_source_id": existing_id,
                                "reason": "identical effective collector/account identity"})
                continue
            entry = {**source, "config": {**source["config"]}}
            if entry["kind"] != "mp_account":
                entry["config"]["_aihot"] = {**entry["config"].get("_aihot", {}), "initialBackfillLimit": 2}
            sources.append(entry)
            by_id[source_id] = entry
            if identity:
                identities[identity] = source_id
            added.append(source_id)
        for alias in pack.get("aliases", []):
            target = alias.get("canonicalSourceId") or alias.get("canonical_source_id")
            if target not in by_id:
                raise ValueError("Supplemental alias has no existing canonical source")
            aliases.append(alias)
        pending.extend(pack.get("pending", []))
    return {"supplemental_added": len(added), "supplemental_source_ids": added,
            "supplemental_aliases": aliases, "supplemental_pending": pending}


def source_pack(rows: list[dict], upstream: list[dict], self_hosts: set[str],
                manifest: dict | None = None, previous_mapping: list[dict] | None = None,
                supplements: list[dict] | None = None) -> tuple[list[dict], list[dict], dict]:
    manifest = validate_profiles(manifest) if manifest is not None else {"profiles": {}, "preserveDisabledSourceIds": []}
    profiles = manifest["profiles"]
    frozen = set(manifest.get("preserveDisabledSourceIds", []))
    # Keep already published canonical IDs when labels change. An identical feed
    # still has to be present today; old aliases never merge unrelated new URLs.
    prior_canonical = {r.get("canonical_source_id") for r in previous_mapping or []
                       if r.get("canonical_source_id") == r.get("aihot_source_id")}
    mapping: list[dict] = []
    canonical: dict[str, dict] = {}
    sources: list[dict] = []
    source_rows: dict[str, dict] = {}
    for row in sorted(rows, key=lambda r: (f"v2-source-{r['id']}" not in prior_canonical,
                                          r.get("status") != "已接入", r["id"])):
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
                       "bridge_enabled": False,
                       "credentials_redacted": any(credentialed(row.get(k)) or private_subscription_path(row.get(k))
                                                   for k in ("rss_url", "original_url"))})
        mapping.append(public)
        if reason or existing:
            continue
        tags = list(dict.fromkeys(v for v in [row.get("primary_board") or row.get("board"), row.get("source_channel_type"), "V2只读桥"] if v))
        entry = {"id": source_id, "name": row["name"], "kind": "external", "config": {},
                 "tier": "T1" if owner else "T2", "first_party": bool(owner), "owner_entity_id": owner,
                 "signal_group_id": signal_group, "participation_mode": "editorial", "interval_minutes": 60,
                 "tags": tags, "site_fulltext": False, "syndicate_fulltext": False,
                 "enabled": source_status_eligible(row) and source_id not in frozen}
        sources.append(entry)
        source_rows[source_id] = row
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
            row = source_rows[existing["id"]]
            if source_status_eligible(row) and existing["id"] not in frozen and existing["id"] not in profiles:
                # A known upstream feed is a native route, not a second bridge
                # collector. Preserve its stable V2 ID and never revive a pause.
                existing["kind"] = "rss"
                existing["config"] = {**s.get("config", {}), "_aihot": {"initialBackfillLimit": 2}}
                existing["enabled"] = True
            continue
        entry = {**s, "enabled": True}
        entry["config"] = {**s.get("config", {}), "_aihot": {"initialBackfillLimit": 2}}
        publisher = mapped_host(s.get("config", {}).get("feedUrl"), PUBLISHER_GROUPS)
        entry["signal_group_id"] = f"publisher:{publisher}" if publisher else "feed:" + hashlib.sha256(feed.encode()).hexdigest()[:20]
        sources.append(entry)
    source_by_id = {s["id"]: s for s in sources}
    for s in sources:
        row = source_rows.get(s["id"])
        profile = profiles.get(s["id"])
        status = str(row.get("status") or "").strip() if row else None
        non_article = status == "非文章页" or bool(profile and profile.get("nonArticle"))
        if non_article:
            # Catalog/model/package pages need a deliberate non-editorial
            # adapter. A label or a bridge must never turn them into news.
            s["participation_mode"] = "isolated"
            s["enabled"] = False
        if profile:
            policy = profile["policy"]
            if policy == "blocked":
                s["enabled"] = False
                s["kind"], s["config"] = "external", {}
            elif policy == "bridge":
                s["kind"], s["config"] = "external", {}
                s["enabled"] = bool(row and source_status_eligible(row) and not non_article)
            else:
                s["kind"] = profile["adapter"]["kind"]
                s["config"] = {**profile["adapter"]["config"]}
                if s["kind"] != "mp_account":
                    s["config"]["_aihot"] = {**s["config"].get("_aihot", {}), "initialBackfillLimit": 2}
                mode = profile.get("participationMode", "editorial")
                if mode not in {"editorial", "hot_signal", "isolated"}:
                    raise ValueError(f"Source profile {s['id']} has an invalid participation mode")
                if non_article and (profile.get("nonArticle") is not True or mode != "isolated"):
                    raise ValueError(f"Non-article source {s['id']} needs an isolated dedicated profile")
                s["participation_mode"] = mode
                s["enabled"] = bool(not row or source_status_eligible(row) or status == "非文章页")
                if isinstance(profile.get("intervalMinutes"), int) and 15 <= profile["intervalMinutes"] <= 1440:
                    s["interval_minutes"] = profile["intervalMinutes"]
        if s["id"] in frozen or status in INACTIVE:
            s["enabled"] = False
        if profile and profile.get("signalGroupId") and s["id"] not in frozen:
            group = profile["signalGroupId"]
            if not isinstance(group, str) or len(group) > 120:
                raise ValueError("Invalid reviewed signal group")
            s["signal_group_id"] = group
        s["tags"] = [tag for tag in s.get("tags", []) if tag != "V2只读桥"]
        if s["kind"] == "external" and s["enabled"]:
            s["tags"].append("V2只读桥")
    supplemental_summary = merge_supplements(sources, source_rows, supplements or [], self_hosts, profiles)
    for public in mapping:
        s = source_by_id.get(public["canonical_source_id"])
        profile = profiles.get(public["canonical_source_id"])
        status = str(public.get("status") or "").strip()
        alias_blocked = status in INACTIVE or public["aihot_source_id"] in frozen or bool(public["excluded_reason"])
        public["collection_route"] = ("blocked" if alias_blocked or not s or not s["enabled"]
                                       else "bridge" if s["kind"] == "external" else "native")
        public["bridge_enabled"] = bool(s and s["enabled"] and s["kind"] == "external"
                                        and status in BRIDGE_STATUSES and public["aihot_source_id"] not in frozen)
        public["profile_policy"] = profile.get("policy") if profile else None
        public["bridge_intake_url_prefixes"] = (profile["bridgeIntakeUrlPrefixes"]
                                                if profile and profile["policy"] == "bridge" and "bridgeIntakeUrlPrefixes" in profile
                                                else None)
        public["non_article"] = status == "非文章页" or bool(profile and profile.get("nonArticle"))
        public["admission_reason"] = (public["excluded_reason"]
                                      or ("preserved paused source" if public["aihot_source_id"] in frozen
                                          else "V2 source paused" if status in INACTIVE
                                          else "dedicated non-article profile required" if public["non_article"] and (not s or not s["enabled"])
                                          else "source profile blocked" if profile and profile["policy"] == "blocked"
                                          else "unknown V2 source status" if status not in BRIDGE_STATUSES and status != "非文章页"
                                          else "configured native adapter" if public["collection_route"] == "native"
                                          else "V2 raw-material bridge" if public["bridge_enabled"]
                                          else "source is not admitted to the bridge"))
    summary = {"v2_sources": len(rows), "feedback_loops_excluded": sum(bool(r["excluded_reason"]) for r in mapping),
               "v2_duplicate_aliases": sum(bool(r["dedup_reason"]) for r in mapping), "upstream_sources": len(upstream),
               "upstream_duplicate_aliases": len(upstream_aliases), "upstream_native_rss": sum(s["kind"] == "rss" for s in sources),
               "canonical_sources": len(sources), "enabled_sources": sum(s["enabled"] for s in sources),
               "enabled_native_sources": sum(s["enabled"] and s["kind"] != "external" for s in sources),
               "enabled_bridge_sources": sum(s["enabled"] and s["kind"] == "external" for s in sources),
               "upstream_aliases": upstream_aliases, **supplemental_summary}
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
    profile_path = getattr(args, "source_profiles", None)
    manifest = json.loads(profile_path.read_text(encoding="utf-8")) if profile_path and profile_path.exists() else None
    previous_path = ROOT / "docs/corescope-v2-sources.json"
    previous_mapping = json.loads(previous_path.read_text(encoding="utf-8")).get("sources", []) if previous_path.exists() else []
    supplements = [json.loads(p.read_text(encoding="utf-8")) for p in getattr(args, "supplement", []) if p.exists()]
    with contextlib.closing(sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=10)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")
        rows = [dict(r) for r in conn.execute(f"SELECT {SOURCE_FIELDS} FROM sources")]
        sources, mapping, summary = source_pack(rows, upstream, self_hosts, manifest, previous_mapping, supplements)
        source_by_business = {r["source_id"]: r for r in mapping}
        latest = dict(conn.execute("SELECT MAX(crawled_at) crawled_at, MAX(updated_at) updated_at FROM articles").fetchone())
        upper_row = conn.execute("SELECT COALESCE(updated_at,created_at) updated_at,id FROM articles ORDER BY COALESCE(updated_at,created_at) DESC,id DESC LIMIT 1").fetchone()
        items = []
        intake_filtered: dict[str, int] = {}
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
                if not bridge_intake_allowed(row["url"], source.get("bridge_intake_url_prefixes")):
                    canonical_id = source["canonical_source_id"]
                    intake_filtered[canonical_id] = intake_filtered.get(canonical_id, 0) + 1
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
             "scanned": scanned, "sourceSummary": summary, "sources": sources, "items": items,
             "bridgeIntake": {"filtered": sum(intake_filtered.values()), "bySource": intake_filtered}}
    if args.out:
        write_json(args.out, batch)
    return {"items": len(items), "scanned": scanned, "hasMore": has_more, "dataLatest": latest,
            "bridgeIntake": batch["bridgeIntake"], **{k: v for k, v in summary.items() if k != "upstream_aliases"}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=pathlib.Path, required=True)
    parser.add_argument("--out", type=pathlib.Path)
    parser.add_argument("--source-pack", type=pathlib.Path)
    parser.add_argument("--source-map", type=pathlib.Path)
    parser.add_argument("--source-profiles", type=pathlib.Path, default=ROOT / "industry/corescope-source-profiles.json",
                        help="Reviewed native routes, preserved pauses and dedicated non-article profiles")
    parser.add_argument("--supplement", type=pathlib.Path, action="append", default=[
        ROOT / "industry/corescope-online-supplement.json", ROOT / "industry/corescope-online-x-supplement.json",
        ROOT / "industry/corescope-online-mp-supplement.json"],
                        help="Additive reviewed source packs, retained on every V2 catalogue refresh")
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
