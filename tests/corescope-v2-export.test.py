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
            conn.execute("INSERT INTO sources (id,source_id,name,status) VALUES (1,'SRC-A','Fixture','已接入')")
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
