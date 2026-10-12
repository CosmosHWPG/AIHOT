"""Local fixture checks for source dedupe, cursor recovery and read-only export."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts/corescope-v2-export.py"
SPEC = importlib.util.spec_from_file_location("v2_export", SCRIPT)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class BridgeExportTests(unittest.TestCase):
    @staticmethod
    def supplement(*sources):
        return {"schemaVersion": 1, "sources": list(sources), "verifications": {
            s["id"]: {"status": "verified", "scope": "fixture"} for s in sources}}

    def test_supplements_survive_refresh_and_dedupe_effective_profiles(self):
        row = {"id": 45, "name": "Existing publisher", "status": "已接入", "rss_url": "https://example.org/old"}
        profile = {"policy": "native", "adapter": {"kind": "rss", "config": {"feedUrl": "https://example.org/feed"}},
                   "verification": {"status": "verified"}}
        duplicate = {"id": "corescope-existing-alias", "name": "Community", "kind": "rss",
                     "config": {"feedUrl": "https://example.org/feed/"}, "enabled": True}
        distinct = {**duplicate, "id": "corescope-other-channel", "config": {"feedUrl": "https://example.org/feed?topic=core"}}
        manifests = [self.supplement(duplicate, distinct)]
        args = ([row], [], set(), self.manifest({"v2-source-45": profile}), None, manifests)
        first = MOD.source_pack(*args)
        second = MOD.source_pack(*args)
        self.assertEqual(first, second)
        self.assertEqual([s["id"] for s in first[0]], ["v2-source-45", "corescope-other-channel"])
        self.assertEqual(first[2]["supplemental_aliases"][0]["canonical_source_id"], "v2-source-45")
        self.assertEqual(first[2]["supplemental_added"], 1)
        self.assertFalse(first[1][0]["bridge_enabled"])

    def test_supplement_x_exact_handle_reuses_paused_v2_id_without_reactivation(self):
        row = {"id": 193, "name": "Paused X", "status": "已接入", "original_url": "https://x.com/Zai_org"}
        x = {"id": "corescope-x-zai-org", "name": "Zai X", "kind": "x_search",
             "config": {"query": "from:zai_ORG -filter:replies", "provider": "xquik"}, "enabled": True}
        pack, _, stats = MOD.source_pack([row], [], set(), self.manifest(frozen=["v2-source-193"]), None, [self.supplement(x)])
        self.assertEqual(len(pack), 1)
        self.assertFalse(pack[0]["enabled"])
        self.assertEqual(stats["supplemental_aliases"][0]["canonical_source_id"], "v2-source-193")

    def test_supplement_mp_identity_requires_biz_and_preserves_distinct_channels(self):
        sources = [{"id": "corescope-mp-a", "name": "A", "kind": "mp_account", "config": {"biz": "MzkyNTYxNzg5Mg==", "articleUrl": "https://mp.weixin.qq.com/s?__biz=MzkyNTYxNzg5Mg==&mid=1"}, "enabled": True},
                   {"id": "corescope-mp-alias", "name": "Different name", "kind": "mp_account", "config": {"biz": "MzkyNTYxNzg5Mg==", "articleUrl": "https://mp.weixin.qq.com/s?__biz=MzkyNTYxNzg5Mg==&mid=2"}, "enabled": True},
                   {"id": "corescope-mp-b", "name": "A", "kind": "mp_account", "config": {"biz": "Mzg3MTk3NzYzNw=="}, "enabled": True}]
        pack, _, stats = MOD.source_pack([], [], set(), None, None, [self.supplement(*sources)])
        self.assertEqual([s["id"] for s in pack], ["corescope-mp-a", "corescope-mp-b"])
        self.assertEqual(len(stats["supplemental_aliases"]), 1)

    def test_supplements_reject_unreviewed_routes_feedback_and_private_config(self):
        s = {"id": "corescope-source", "kind": "rss", "config": {"feedUrl": "https://example.org/feed"}, "enabled": True}
        bad = self.supplement(s)
        bad["verifications"] = {}
        with self.assertRaisesRegex(ValueError, "verification"):
            MOD.source_pack([], [], set(), None, None, [bad])
        for url in ["https://aihot.news/feed", "https://localhost:8780/feed", "https://example.org/feed?api_key=fixture"]:
            s["config"]["feedUrl"] = url
            with self.assertRaises(ValueError):
                MOD.source_pack([], [], {"localhost:8780"}, None, None, [self.supplement(s)])

    def test_verified_cache_public_biz_reuses_old_source_without_merging_names(self):
        biz = "MzkyNTYxNzg5Mg=="
        row = {"id": 7000, "name": "Existing cache account", "status": "已接入"}
        profile = {"policy": "native", "adapter": {"kind": "mp_account", "config": {"transport": "wx_cache", "account": "Public name"}},
                   "verification": {"status": "verified", "samples": [{"url": "http://mp.weixin.qq.com/s?__biz=" + biz + "&mid=1"}]}}
        candidate = {"id": "corescope-mp-cache-alias", "name": "Different label", "kind": "mp_account",
                     "config": {"articleUrl": "https://mp.weixin.qq.com/s?__biz=" + biz + "&mid=2", "biz": biz}, "enabled": True}
        pack, _, stats = MOD.source_pack([row], [], set(), self.manifest({"v2-source-7000": profile}), None, [self.supplement(candidate)])
        self.assertEqual([s["id"] for s in pack], ["v2-source-7000"])
        self.assertEqual(stats["supplemental_aliases"][0]["canonical_source_id"], "v2-source-7000")

    def test_mp_conflicting_biz_and_nested_feedback_are_rejected_before_dedup(self):
        mp = {"id": "corescope-mp-conflict", "kind": "mp_account", "config": {"biz": "Mzg3MTk3NzYzNw==",
              "articleUrl": "https://mp.weixin.qq.com/s?__biz=MzkyNTYxNzg5Mg==&mid=1"}, "enabled": True}
        with self.assertRaisesRegex(ValueError, "disagree"):
            MOD.source_pack([], [], set(), None, None, [self.supplement(mp)])
        nested = {"id": "corescope-json-loop", "kind": "json_list", "config": {
            "url": "https://example.org/api", "bodyJson": {"url": "https://aihot.news/all"}}, "enabled": True}
        with self.assertRaisesRegex(ValueError, "feedback loop"):
            MOD.source_pack([], [], set(), None, None, [self.supplement(nested)])

    @staticmethod
    def manifest(profiles=None, frozen=None):
        return {"schemaVersion": 1, "preserveDisabledSourceIds": frozen or [], "profiles": profiles or {}}

    def test_governance_candidates_remain_bridge_eligible_without_claiming_native_health(self):
        allowed = ["已接入", "已确认", "候选", "未确认", "待验证"]
        blocked = ["暂停", "需删除", "去激活", "非文章页", "未知状态", ""]
        rows = [{"id": i, "name": f"Source {i}", "status": status} for i, status in enumerate(allowed + blocked, 1)]
        pack, mapping, stats = MOD.source_pack(rows, [], set())
        by_id = {s["id"]: s for s in pack}
        for row in mapping:
            should_enable = row["status"] in allowed
            source = by_id[row["canonical_source_id"]]
            self.assertEqual(source["enabled"], should_enable)
            self.assertEqual(row["bridge_enabled"], should_enable)
            self.assertEqual(row["collection_route"], "bridge" if should_enable else "blocked")
            self.assertEqual((source["kind"], source["config"]), ("external", {}))
        self.assertEqual(stats["enabled_bridge_sources"], len(allowed))
        self.assertEqual(stats["enabled_native_sources"], 0)

    def test_preserved_pause_cannot_be_reactivated_by_status_or_upstream_alias(self):
        rows = [{"id": 10, "name": "Previously paused", "status": "已接入", "rss_url": "https://example.org/feed"},
                {"id": 11, "name": "Paused upstream", "status": "暂停", "rss_url": "https://example.net/feed"}]
        upstream = [{"id": f"rss-{i}", "name": "Upstream", "kind": "rss", "config": {"feedUrl": row["rss_url"]}}
                    for i, row in enumerate(rows)]
        pack, mapping, _ = MOD.source_pack(rows, upstream, set(), self.manifest(frozen=["v2-source-10"]))
        self.assertTrue(all(not s["enabled"] for s in pack))
        self.assertTrue(all(not r["bridge_enabled"] for r in mapping))

    def test_native_profile_owns_every_alias_and_labels_do_not_change_canonical_identity(self):
        rows = [{"id": 20, "name": "Stable primary", "status": "候选", "rss_url": "https://example.org/feed"},
                {"id": 30, "name": "Newly connected alias", "status": "已接入", "rss_url": "https://example.org/feed"}]
        previous = [{"aihot_source_id": "v2-source-20", "canonical_source_id": "v2-source-20"},
                    {"aihot_source_id": "v2-source-30", "canonical_source_id": "v2-source-20"}]
        profile = {"policy": "native", "adapter": {"kind": "rss", "config": {"feedUrl": "https://example.org/feed"}},
                   "verification": {"status": "verified"}}
        pack, mapping, stats = MOD.source_pack(rows, [], set(), self.manifest({"v2-source-20": profile}), previous)
        self.assertEqual([s["id"] for s in pack], ["v2-source-20"])
        self.assertEqual(pack[0]["kind"], "rss")
        self.assertNotIn("V2只读桥", pack[0]["tags"])
        self.assertEqual(pack[0]["config"]["_aihot"]["initialBackfillLimit"], 2)
        self.assertTrue(all(r["canonical_source_id"] == "v2-source-20" and not r["bridge_enabled"] for r in mapping))
        self.assertTrue(all(r["collection_route"] == "native" for r in mapping))
        self.assertEqual(stats["enabled_native_sources"], 1)
        self.assertEqual(stats["enabled_bridge_sources"], 0)

    def test_bridge_publisher_guard_checks_normalized_host_and_path_boundaries(self):
        prefixes = ["https://qwen.ai/blog/"]
        rows = [{"id": 183, "name": "Qwen", "status": "已接入"}]
        manifest = self.manifest({"v2-source-183": {"policy": "bridge", "bridgeIntakeUrlPrefixes": prefixes}})
        pack, mapping, _ = MOD.source_pack(rows, [], set(), manifest)
        self.assertEqual(mapping[0]["bridge_intake_url_prefixes"], prefixes)
        self.assertIn("V2只读桥", pack[0]["tags"])
        for url in ["https://qwen.ai/blog/release", "http://QWEN.AI:80/blog/release", "https://qwen.ai/blog/./release", "https://qwen.ai/blog/release?lang=en"]:
            self.assertTrue(MOD.bridge_intake_allowed(url, prefixes), url)
        for url in ["https://qwen.ai.evil.example/blog/release", "https://other-publisher.example/blog/release",
                    "https://qwen.ai/blogger/release", "https://qwen.ai/blog/%2e%2e/other",
                    "https://qwen.ai/blog/release?api_key=fixture", "https://user:fixture@qwen.ai/blog/release",
                    "https://qwen.ai:8443/blog/release"]:
            self.assertFalse(MOD.bridge_intake_allowed(url, prefixes), url)

    def test_explicit_empty_bridge_publisher_guard_denies_all_and_invalid_prefixes_are_rejected(self):
        url = "https://mp.sohu.com/a/fixture"
        self.assertFalse(MOD.bridge_intake_allowed(url, []))
        self.assertTrue(MOD.bridge_intake_allowed(url, None))
        row = {"id": 3335, "name": "Reviewed wrong feed", "status": "已接入"}
        for invalid in ["not-an-array", [""], ["ftp://example.org/news"], ["https://user:fixture@example.org/news"],
                        ["https://example.org/news?api_key=fixture"], ["https://example.org/news?lang=en"], ["https://example.org/news#part"]]:
            manifest = self.manifest({"v2-source-3335": {"policy": "bridge", "bridgeIntakeUrlPrefixes": invalid}})
            with self.assertRaises(ValueError):
                MOD.source_pack([row], [], set(), manifest)

    def test_non_article_sources_require_verified_isolated_dedicated_profiles(self):
        row = {"id": 27, "name": "Package catalog", "status": "非文章页"}
        pack, mapping, _ = MOD.source_pack([row], [], set())
        self.assertEqual((pack[0]["enabled"], pack[0]["participation_mode"], mapping[0]["bridge_enabled"]),
                         (False, "isolated", False))
        bridge = self.manifest({"v2-source-27": {"policy": "bridge", "nonArticle": True, "participationMode": "isolated"}})
        self.assertFalse(MOD.source_pack([row], [], set(), bridge)[0][0]["enabled"])
        profile = {"policy": "native", "nonArticle": True, "participationMode": "isolated",
                   "adapter": {"kind": "json_list", "config": {"url": "https://example.org/packages.json", "itemsPath": "items"}},
                   "verification": {"status": "verified"}}
        pack, mapping, _ = MOD.source_pack([row], [], set(), self.manifest({"v2-source-27": profile}))
        self.assertEqual((pack[0]["enabled"], pack[0]["participation_mode"], mapping[0]["bridge_enabled"]),
                         (True, "isolated", False))
        profile["participationMode"] = "editorial"
        with self.assertRaisesRegex(ValueError, "isolated dedicated"):
            MOD.source_pack([row], [], set(), self.manifest({"v2-source-27": profile}))

    def test_profile_policies_and_native_verification_are_explicit_and_private_endpoints_are_rejected(self):
        row = {"id": 1, "name": "Candidate", "status": "候选"}
        with self.assertRaisesRegex(ValueError, "policy"):
            MOD.source_pack([row], [], set(), self.manifest({"v2-source-1": {"policy": "unknown"}}))
        profile = {"policy": "native", "adapter": {"kind": "rss", "config": {"feedUrl": "https://example.org/feed"}},
                   "verification": {"status": "candidate"}}
        with self.assertRaisesRegex(ValueError, "verified"):
            MOD.source_pack([row], [], set(), self.manifest({"v2-source-1": profile}))
        profile["verification"]["status"] = "verified"
        for url in ["https://user:password@example.org/feed", "https://example.org/feed?token=fixture",
                    "https://rss.app/feeds/fictional-subscription-id.xml"]:
            profile["adapter"]["config"]["feedUrl"] = url
            with self.assertRaisesRegex(ValueError, "private endpoint"):
                MOD.source_pack([row], [], set(), self.manifest({"v2-source-1": profile}))

    def test_dedupe_requires_full_feed_identity_and_preserves_v2_aliases(self):
        sources = [
            {"id": 1, "source_id": "SRC-A", "name": "One", "status": "已接入", "rss_url": "https://example.org/feed?topic=ai"},
            {"id": 2, "source_id": "SRC-B", "name": "Two", "status": "已接入", "rss_url": "https://example.org/feed?topic=ai"},
            {"id": 3, "source_id": "SRC-C", "name": "Telecom", "status": "已接入", "rss_url": "https://example.org/feed?topic=telecom"},
            {"id": 9617, "source_id": "SRC-LOOP", "name": "AIHot loop", "status": "已接入", "rss_url": "https://example.org/loop"},
        ]
        pack, mapping, stats = MOD.source_pack(sources, [], set())
        self.assertEqual(len(pack), 2)
        self.assertEqual(mapping[1]["canonical_source_id"], "v2-source-1")
        self.assertEqual(mapping[2]["canonical_source_id"], "v2-source-3")
        self.assertIsNone(mapping[3]["canonical_source_id"])
        self.assertEqual(stats["feedback_loops_excluded"], 1)

    def test_candidate_alias_keeps_upstream_native_collection_available(self):
        sources = [{"id": 10, "source_id": "SRC-10", "name": "Candidate", "status": "候选", "rss_url": "https://example.org/feed"}]
        upstream = [{"id": "rss-demo", "name": "Official", "kind": "rss", "config": {"feedUrl": "https://example.org/feed"}, "tier": "T1", "first_party": True}]
        pack, mapping, _ = MOD.source_pack(sources, upstream, set())
        self.assertEqual(pack[0]["id"], "v2-source-10")
        self.assertEqual(pack[0]["kind"], "rss")
        self.assertTrue(pack[0]["enabled"])
        self.assertFalse(mapping[0]["bridge_enabled"])

    def test_public_sidecar_redacts_subscription_paths_without_changing_source_identity(self):
        sources = [
            {"id": 10, "name": "Hosted A", "status": "已接入", "rss_url": "https://rss.app/feeds/fictional-token-aaa.xml"},
            {"id": 11, "name": "Hosted B", "status": "已接入", "rss_url": "https://rss.app/feeds/fictional-token-bbb.xml"},
        ]
        pack, mapping, stats = MOD.source_pack(sources, [], set())
        self.assertEqual([s["id"] for s in pack], ["v2-source-10", "v2-source-11"])
        self.assertEqual(stats["v2_duplicate_aliases"], 0)
        self.assertNotEqual(pack[0]["signal_group_id"], pack[1]["signal_group_id"])
        self.assertTrue(all(s["kind"] == "external" and s["config"] == {} for s in pack))
        self.assertTrue(all(s["bridge_enabled"] and s["credentials_redacted"] for s in mapping))
        self.assertTrue(all(s["rss_url"] == "https://rss.app/feeds/[REDACTED].xml" for s in mapping))
        self.assertEqual(MOD.safe_url("https://kill-the-newsletter.com/feeds/fictional-token-ccc.xml", subscription_entry=True),
                         "https://kill-the-newsletter.com/feeds/[REDACTED].xml")

    def test_subscription_path_redaction_preserves_public_routes(self):
        public = "https://example.org/feeds/a-public-technical-news-feed.xml?topic=ai"
        docs = "https://rss.app/docs/a-public-documentation-route"
        article = "https://rss.app/feeds/fictional-token-article.xml"
        self.assertEqual(MOD.safe_url(public, subscription_entry=True), public)
        self.assertEqual(MOD.safe_url(docs, subscription_entry=True), docs)
        self.assertEqual(MOD.safe_url(article), article)
        self.assertFalse(MOD.private_subscription_path(public))
        self.assertFalse(MOD.private_subscription_path(docs))

    def test_known_opaque_subscription_routes_are_redacted_without_collapsing_identity(self):
        first = "a" * 32
        second = "b" * 32
        cases = [
            (f"https://api.xgo.ing/rss/user/{first}", "https://api.xgo.ing/rss/user/[REDACTED]"),
            (f"https://api.xgo.ing/rss/users/{second}.xml", "https://api.xgo.ing/rss/users/[REDACTED].xml"),
            (f"https://wechat2rss.xlab.app/feed/{first}.xml", "https://wechat2rss.xlab.app/feed/[REDACTED].xml"),
            (f"https://wechat2rss.bestblogs.dev/feed/{second}.xml", "https://wechat2rss.bestblogs.dev/feed/[REDACTED].xml"),
            ("https://rss.jintiankansha.me/rss/fixture-opaque-subscription-handle-123456.xml", "https://rss.jintiankansha.me/rss/[REDACTED].xml"),
            ("https://www.google.com.tw/alerts/feeds/11111111111111111111/22222222222222222222", "https://www.google.com.tw/alerts/feeds/[REDACTED]/[REDACTED]"),
        ]
        for raw, redacted in cases:
            self.assertTrue(MOD.private_subscription_path(raw))
            self.assertEqual(MOD.safe_url(raw, subscription_entry=True), redacted)
            self.assertEqual(MOD.normalized_feed(raw), raw)
        rows = [{"id": i, "name": f"Hosted {i}", "status": "候选", "rss_url": url}
                for i, url in enumerate([f"https://api.xgo.ing/rss/user/{first}", f"https://api.xgo.ing/rss/user/{second}"], 1)]
        pack, mapping, stats = MOD.source_pack(rows, [], set())
        self.assertEqual(stats["v2_duplicate_aliases"], 0)
        self.assertEqual(len(pack), 2)
        self.assertNotEqual(pack[0]["signal_group_id"], pack[1]["signal_group_id"])
        self.assertTrue(all(r["credentials_redacted"] for r in mapping))
        self.assertNotIn(first, json.dumps(mapping))
        self.assertNotIn(second, json.dumps(mapping))

    def test_subscription_redaction_does_not_hide_public_feed_slugs_or_other_hosts(self):
        public = [
            "https://example.org/feed/a-public-technical-news-feed.xml",
            "https://example.org/rss/user/" + "a" * 32,
            "https://plink.anyfeeder.com/weixin/AI_era",
            "https://api.xgo.ing/rss/user/a-public-feed-slug",
            "https://wechat2rss.xlab.app/feed/a-public-documentation-slug.xml",
            "https://rss.jintiankansha.me/docs/a-public-documentation-route",
            "https://www.google.com.tw/blog/feeds/posts/default",
        ]
        for url in public:
            self.assertFalse(MOD.private_subscription_path(url))
            self.assertEqual(MOD.safe_url(url, subscription_entry=True), url)

    def test_body_length_never_claims_fulltext_and_model_summary_is_metadata_only(self):
        row = {"id": 1, "title": "Original", "summary": "Source abstract", "raw_content": "Source abstract", "model_summary": "AI result"}
        item = MOD.raw_material(row, [], {"canonical_source_id": "v2-source-1", "aihot_source_id": "v2-source-1"})
        self.assertIsNone(item["bodyText"])
        self.assertEqual(item["bodyStatus"], "pending")
        self.assertEqual(item["v2Metadata"]["originalRawContent"], "Source abstract")
        self.assertFalse(item["bodyEvidence"]["fulltextVerified"])
        self.assertEqual(item["bodyEvidence"]["origin"], "source_excerpt_only")
        before = MOD.fingerprint(item)
        item["v2Metadata"]["modelSummary"] = "Different model result"
        self.assertEqual(before, MOD.fingerprint(item))

    def test_rss_html_wrapping_an_excerpt_does_not_bypass_detail_extraction(self):
        row = {"id": 1, "title": "Original", "summary": "Networks & agents need inventory.",
               "raw_content": "<ul><li>Networks &amp; agents need inventory.</li></ul>"}
        item = MOD.raw_material(row, [], {"canonical_source_id": "v2-source-1", "aihot_source_id": "v2-source-1"})
        self.assertEqual(item["bodyStatus"], "pending")
        self.assertIsNone(item["bodyText"])
        self.assertEqual(item["bodyEvidence"]["origin"], "source_excerpt_only")

    def test_xml_cdata_html_preserves_original_report_text(self):
        row = {"id": 1, "title": "Original", "summary": "", "raw_content": "<![CDATA[<p>Original report.</p><p>Detailed evidence.</p>]]>"}
        item = MOD.raw_material(row, [], {"canonical_source_id": "v2-source-1", "aihot_source_id": "v2-source-1"})
        self.assertEqual(item["bodyStatus"], "unconfirmed")
        self.assertIn("Original report.", item["bodyText"])
        self.assertIn("Detailed evidence.", item["bodyText"])
        self.assertEqual(item["v2Metadata"]["originalRawContent"], row["raw_content"])

    def test_readonly_ledger_overlap_does_not_starve_new_rows_at_equal_timestamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            db = root / "v2" / "data" / "fixture.sqlite3"
            db.parent.mkdir(parents=True)
            conn = sqlite3.connect(db)
            cols = ",".join(f"{name} TEXT" for name in MOD.SOURCE_FIELDS.split(",") if name != "id")
            conn.execute(f"CREATE TABLE sources (id INTEGER PRIMARY KEY,{cols})")
            conn.execute("INSERT INTO sources (id,source_id,name,status) VALUES (1,'SRC-A','Fixture','候选')")
            conn.execute("CREATE TABLE articles (id INTEGER PRIMARY KEY,article_id TEXT,source_id TEXT,title TEXT,url TEXT,publish_time TEXT,crawled_at TEXT,created_at TEXT,updated_at TEXT,raw_content TEXT,summary TEXT)")
            conn.execute("CREATE TABLE article_source_evidence (id INTEGER,article_id INTEGER)")
            stamp = "2026-10-01T10:00:00+00:00"
            for i in range(1, 8):
                conn.execute("INSERT INTO articles VALUES (?,?,?,?,?,?,?,?,?,?,?)", (i, f"A-{i}", "SRC-A", f"Raw {i}", f"https://example.org/{i}", stamp, stamp, stamp, stamp, f"Raw body {i}", "Excerpt"))
            conn.commit()
            conn.close()
            original = hashlib.sha256(db.read_bytes()).hexdigest()
            state_file = root / "state.json"
            out = root / "out.json"
            args = argparse.Namespace(db=db, out=out, source_pack=None, source_map=None, self_url=[], state=state_file,
                                      since="2026-10-01T00:00:00+00:00", sources_only=False, bootstrap=False, article_ids="", overlap_minutes=15, scan_limit=3, limit=2)
            seen = {}
            ids = []
            for _ in range(8):
                MOD.export(args)
                batch = json.loads(out.read_text(encoding="utf-8"))
                ids.extend(i["v2Id"] for i in batch["items"])
                seen.update({str(i["v2Id"]): i["fingerprint"] for i in batch["items"]})
                MOD.write_json(state_file, {"cursor": batch["cursorAfter"], "seen": seen})
            self.assertEqual(sorted(ids), list(range(1, 8)))
            self.assertEqual(len(ids), len(set(ids)))
            self.assertEqual(hashlib.sha256(db.read_bytes()).hexdigest(), original)


if __name__ == "__main__":
    unittest.main()
