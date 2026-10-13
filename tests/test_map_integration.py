import copy
import json
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

import app


def snapshot():
    return {
        "papers": [
            {"zoteroKey": key, "title": title, "authors": "An Author", "year": "2026", "doi": "",
             "referenceAnalysis": {"status": "complete", "message": "已解析参考文献。"}}
            for key, title in (("AAAAAAAA", "Paper A"), ("BBBBBBBB", "Paper B"))
        ],
        "citations": [{"fromKey": "BBBBBBBB", "toKey": "AAAAAAAA", "method": "title", "evidence": "Paper B."}],
        "stats": {"papers": 2, "complete": 2},
    }


class LibraryMergeTests(unittest.TestCase):
    def test_resync_preserves_marks_ids_notes_and_direction_without_duplicates(self):
        state = app.default_state()
        app.merge_zotero_snapshot(state, snapshot())
        a, b = state["papers"]
        app.apply_action(state, "paper.mark", {"id": b["id"], "readStatus": "read"})
        b["localNote"] = "My note"
        filename = b["fileName"]
        updated = snapshot()
        updated["papers"][1]["title"] = "Paper B revised"
        result = app.merge_zotero_snapshot(state, updated)
        self.assertEqual(len(state["papers"]), 2)
        self.assertEqual(result["stats"]["added"], 0)
        self.assertEqual(b["readStatus"], "read")
        self.assertEqual(b["localNote"], "My note")
        self.assertEqual(b["fileName"], filename)
        self.assertEqual(b["title"], "Paper B revised")
        self.assertEqual([(e["fromId"], e["toId"]) for e in state["citations"]], [(b["id"], a["id"])])
        self.assertEqual(app.validate_backup(state), state)

    def test_removed_zotero_item_keeps_local_mark_but_has_no_stale_edges(self):
        state = app.default_state()
        app.merge_zotero_snapshot(state, snapshot())
        b = state["papers"][1]
        app.apply_action(state, "paper.mark", {"id": b["id"], "readStatus": "read"})
        reduced = snapshot()
        reduced["papers"].pop()
        reduced["citations"] = []
        app.merge_zotero_snapshot(state, reduced)
        self.assertTrue(b["zoteroMissing"])
        self.assertEqual(b["readStatus"], "read")
        self.assertEqual(state["citations"], [])
        app.merge_zotero_snapshot(state, snapshot())
        self.assertFalse(b["zoteroMissing"])
        self.assertEqual(b["readStatus"], "read")

    def test_delete_paper_cleans_citations_and_invalid_marks_rejected(self):
        state = app.default_state()
        app.merge_zotero_snapshot(state, snapshot())
        paper_id = state["papers"][0]["id"]
        for mark in ("learning", "", None):
            with self.assertRaises(ValueError):
                app.apply_action(state, "paper.mark", {"id": paper_id, "readStatus": mark})
        app.apply_action(state, "paper.delete", {"id": paper_id})
        self.assertEqual(state["citations"], [])

    def test_legacy_and_new_backup_validation(self):
        old = app.default_state()
        del old["citations"]
        del old["zoteroSync"]
        del old["recommendations"]
        self.assertEqual(app.validate_backup(old), old)
        state = app.default_state()
        app.merge_zotero_snapshot(state, snapshot())
        for citations in (None, [{}], [{"id": "c", "fromId": "ghost", "toId": state["papers"][0]["id"]}]):
            with self.assertRaises(ValueError):
                app.validate_backup({**state, "citations": citations})
        for mark in ("invalid", [], {}, None):
            with self.subTest(mark=mark), self.assertRaises(ValueError):
                app.validate_backup({**state, "papers": [{**state["papers"][0], "readStatus": mark}, state["papers"][1]]})
        for sync in (None, [], {"stats": []}, {"syncedAt": {}}):
            with self.subTest(sync=sync), self.assertRaises(ValueError):
                app.validate_backup({**state, "zoteroSync": sync})
        for name in ("evidence", "method", "attachmentKey"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                app.validate_backup({**state, "citations": [{**state["citations"][0], name: []}]})

    def test_recommendations_map_distinct_current_citers_and_survive_restore(self):
        state = app.default_state()
        data = snapshot()
        data["recommendations"] = [{"id": "rec_test", "title": "Shared reference", "doi": "10.1234/test",
             "arxivId": "", "url": "", "referenceText": "Shared reference", "verification": "identifier",
             "citingKeys": ["AAAAAAAA", "BBBBBBBB", "AAAAAAAA", "GHOSTKEY"], "citationCount": 99,
             "matchedKey": "AAAAAAAA", "evidence": [{"citingKey": "BBBBBBBB", "attachmentKey": "PDFKEYBB", "text": "reference"}]}]
        data["papers"][0].update(institution="Research Lab", extra="Research Lab",
                                     authors="One, Two, Three, Four", authorNames=["One", "Two", "Three", "Four"], authorCount=4)
        app.merge_zotero_snapshot(state, data)
        rec = state["recommendations"][0]
        self.assertEqual(rec["citationCount"], 2)
        self.assertEqual(rec["citingIds"], [paper["id"] for paper in state["papers"]])
        self.assertEqual(rec["matchedPaperId"], state["papers"][0]["id"])
        self.assertEqual(rec["evidence"][0]["citingId"], state["papers"][1]["id"])
        self.assertEqual(state["papers"][0]["institution"], "Research Lab")
        self.assertEqual(state["papers"][0]["authorCount"], 4)
        self.assertEqual(app.validate_backup(state), state)
        for bad in (None, [{}], [{**rec, "citingIds": ["missing"]}], [{**rec, "verification": []}],
                    [{**rec, "matchedPaperId": []}], [{**rec, "citationCount": True}],
                    [{**rec, "evidence": [{"citingId": "missing", "text": "reference"}]}]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                app.validate_backup({**state, "recommendations": bad})
        app.apply_action(state, "paper.delete", {"id": state["papers"][1]["id"]})
        self.assertEqual(state["recommendations"], [])

    def test_recommendation_rank_and_removed_library_citers(self):
        state = app.default_state()
        data = snapshot()
        data["papers"].append({**data["papers"][0], "zoteroKey": "CCCCCCCC", "title": "Paper C"})
        data["recommendations"] = [
            {"id": "rec_two", "title": "Two", "verification": "title", "citingKeys": ["AAAAAAAA", "BBBBBBBB"]},
            {"id": "rec_three", "title": "Three", "verification": "raw", "citingKeys": ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC"]},
        ]
        app.merge_zotero_snapshot(state, data)
        self.assertEqual([item["citationCount"] for item in state["recommendations"]], [3, 2])
        data["papers"] = data["papers"][:1]
        app.merge_zotero_snapshot(state, data)
        self.assertEqual(state["recommendations"], [])

    def test_add_paper_to_line_is_explicit_and_idempotent(self):
        state = app.default_state()
        app.merge_zotero_snapshot(state, snapshot())
        paper = state["papers"][0]
        line_id = app.apply_action(state, "line.create", {"title": "Reading"})["lineId"]
        unrelated_id = app.apply_action(state, "idea.create", {"title": "Unrelated", "lineId": line_id})["ideaId"]
        with self.assertRaises(ValueError):
            app.apply_action(state, "paper.add_to_line", {"id": paper["id"], "lineId": line_id, "ideaId": unrelated_id})
        result = app.apply_action(state, "paper.add_to_line", {"id": paper["id"], "lineId": line_id})
        self.assertEqual(state["ideas"][-1]["title"], paper["title"])
        self.assertEqual(result["paperId"], paper["id"])
        again = app.apply_action(state, "paper.add_to_line", {"id": paper["id"], "lineId": line_id})
        self.assertEqual(result, again)
        self.assertEqual(len(state["ideas"]), 2)
        self.assertEqual(len(state["edges"]), 1)
        self.assertEqual(state["lines"][0]["ideaIds"].count(result["ideaId"]), 1)
        other_line = app.apply_action(state, "line.create", {"title": "Other"})["lineId"]
        app.apply_action(state, "paper.add_to_line", {"id": paper["id"], "lineId": other_line, "ideaId": result["ideaId"]})
        self.assertEqual(state["lines"][1]["ideaIds"], [result["ideaId"]])
        with self.assertRaises(ValueError):
            app.apply_action(state, "paper.add_to_line", {"id": paper["id"], "lineId": "deleted-line"})
        self.assertEqual(app.validate_backup(state), state)

    def test_zotero_search_and_import_keep_complete_author_names_and_extra(self):
        creators = [{"name": f"Author {index}"} for index in range(12)]
        with patch.object(app, "zotero_get", return_value=[{"key": "AAAAAAAA", "data":
                               {"title": "Paper", "extra": "My institution", "creators": creators}}]):
            result = app.zotero_search("")[0]
        self.assertEqual(result["authorCount"], 12)
        self.assertIn("Author 11", result["authors"])
        state = app.default_state()
        app.apply_action(state, "paper.create", result)
        self.assertEqual(state["papers"][0]["extra"], "My institution")
        self.assertEqual(state["papers"][0]["authorNames"], result["authorNames"])

    def test_cached_flags_do_not_count_as_changed_metadata(self):
        state = app.default_state()
        initial = snapshot()
        initial["papers"][0]["referenceAnalysis"]["attachments"] = [{"key": "PDFKEYAA", "cached": False, "version": 2}]
        app.merge_zotero_snapshot(state, initial)
        cached = copy.deepcopy(initial)
        cached["papers"][0]["referenceAnalysis"]["attachments"][0]["cached"] = True
        result = app.merge_zotero_snapshot(state, cached)
        self.assertEqual(result["stats"]["updated"], 0)
        self.assertFalse(initial["papers"][0]["referenceAnalysis"]["attachments"][0]["cached"])



class LibraryWorkerTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        root = Path(self.folder.name)
        for name, value in (("DATA_FILE", root / "state.json"), ("BACKUP_FILE", root / "backup.json")):
            context = patch.object(app, name, value)
            context.start()
            self.addCleanup(context.stop)
        app.save_state(app.default_state())

    def test_legacy_paper_load_defaults_to_unread(self):
        state = app.default_state()
        app.apply_action(state, "paper.create", {"title": "Legacy paper"})
        del state["papers"][0]["readStatus"]
        del state["citations"]
        del state["zoteroSync"]
        del state["recommendations"]
        app.save_state(state)
        loaded = app.load_state()
        self.assertEqual(loaded["papers"][0]["readStatus"], "unread")
        self.assertEqual(loaded["citations"], [])
        self.assertEqual(loaded["recommendations"], [])
        self.assertEqual(loaded["zoteroSync"], {})

    def legacy_recommendation_state(self):
        state = app.default_state()
        state.pop("recommendationsVersion")
        state["papers"] = [
            {"id": "p_" + key, "zoteroKey": key, "title": "Paper " + key,
             "readStatus": "read", "localNote": "Keep my note", "doi": "",
             "referenceAnalysis": {"attachments": [
                 {"key": "PDF" + key, "referenceText":
                  "[1] A. Author. Shared external research. 2024. doi:10.1234/shared."}]}}
            for key in ("AAAAAAAA", "BBBBBBBB", "CCCCCCCC")
        ]
        state["papers"][0]["doi"] = "10.1234/library"
        state["citations"] = [
            {"id": "c_" + key, "fromId": "p_AAAAAAAA", "toId": "p_" + key,
             "method": "title", "evidence": "Paper A", "attachmentKey": "PDF" + key}
            for key in ("BBBBBBBB", "CCCCCCCC", "BBBBBBBB")
        ]
        state["zoteroSync"] = {"syncedAt": "2026-10-12", "stats": {"papers": 3}}
        return state

    def test_legacy_empty_recommendations_rebuild_offline_without_writing_on_reads(self):
        legacy = self.legacy_recommendation_state()
        app.save_state(legacy)
        original = app.DATA_FILE.read_bytes()
        backup = app.BACKUP_FILE.read_bytes()
        with patch.object(app, "zotero_get", side_effect=AssertionError("No network")), \
                patch.object(app, "rebuild_recommendations", wraps=app.rebuild_recommendations) as rebuild:
            loaded = app.load_state()
            first = copy.deepcopy(loaded)
            loaded["recommendations"][0]["title"] = "Do not leak this edit"
            again = app.load_state()
        self.assertEqual(rebuild.call_count, 1)
        self.assertEqual(again, first)
        self.assertEqual(app.DATA_FILE.read_bytes(), original)
        self.assertEqual(app.BACKUP_FILE.read_bytes(), backup)
        self.assertEqual(again["savedAt"], legacy["savedAt"])
        recs = {item["id"]: item for item in again["recommendations"]}
        self.assertEqual(recs["doi:10.1234/library"]["citationCount"], 2)
        self.assertEqual(recs["doi:10.1234/shared"]["citationCount"], 3)
        self.assertEqual(again["papers"], legacy["papers"])
        self.assertEqual(app.validate_backup(again), again)
        self.assertEqual(again["zoteroSync"]["stats"]["recommendations"], 2)
        app.save_state(again)
        self.assertEqual(json.loads(app.DATA_FILE.read_text())["recommendationsVersion"], app.RECOMMENDATIONS_VERSION)

    def test_legacy_restore_rebuilds_and_current_empty_snapshot_is_final(self):
        legacy = self.legacy_recommendation_state()
        app.restore_state(legacy)
        self.assertEqual(len(app.load_state()["recommendations"]), 2)
        current = app.default_state()
        app.merge_zotero_snapshot(current, snapshot())
        app.save_state(current)
        with patch.object(app, "rebuild_recommendations", side_effect=AssertionError("Already current")):
            self.assertEqual(app.load_state()["recommendations"], [])
        self.assertEqual(current["zoteroSync"]["stats"]["recommendations"], 0)

    def test_legacy_upgrade_uses_arxiv_url_and_ignores_removed_citers(self):
        legacy = self.legacy_recommendation_state()
        legacy["papers"][0].update(doi="", url="https://arxiv.org/abs/2305.12345v2")
        recs = {item["id"]: item for item in app.rebuild_recommendations(legacy)}
        self.assertEqual(recs["arxiv:2305.12345"]["matchedPaperId"], "p_AAAAAAAA")
        legacy["papers"][2]["zoteroMissing"] = True
        recs = app.rebuild_recommendations(legacy)
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["id"], "doi:10.1234/shared")
        self.assertEqual(recs[0]["citationCount"], 2)

    def test_legacy_optional_reference_metadata_can_be_null_or_absent(self):
        state = app.default_state()
        state.pop("recommendationsVersion")
        state["papers"] = [{"id": "p_null", "referenceAnalysis": None},
                           {"id": "p_missing"},
                           {"id": "p_bad", "referenceAnalysis": {"attachments": [None, {}]}}]
        self.assertEqual(app.validate_backup(state), state)
        app.ensure_recommendations(state)
        self.assertEqual(state["recommendations"], [])
        self.assertIsNone(state["papers"][0]["referenceAnalysis"])

    def test_invalid_recommendation_version_rejected(self):
        for version in (True, "1", -1, None):
            with self.subTest(version=version), self.assertRaises(ValueError):
                app.validate_backup({**app.default_state(), "recommendationsVersion": version})

    def test_async_api_stays_responsive_and_reports_completed_snapshot(self):
        entered, release = threading.Event(), threading.Event()
        job = app.ZoteroLibrarySync()

        def collect(*args):
            entered.set()
            release.wait(3)
            return snapshot()

        server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        worker = None
        with patch.object(app, "ZOTERO_SYNC", job), patch.object(app, "collect_snapshot", side_effect=collect), patch.object(app.SYNC, "mark_dirty"):
            try:
                request = urllib.request.Request(base + "/api/zotero/sync", data=b"{}",
                                                 headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(request, timeout=2) as response:
                    self.assertEqual(response.status, 202)
                    self.assertEqual(json.load(response)["status"], "running")
                self.assertTrue(entered.wait(2))
                with urllib.request.urlopen(base + "/api/zotero/sync", timeout=2) as response:
                    self.assertEqual(json.load(response)["status"], "running")
                with urllib.request.urlopen(base + "/api/state", timeout=2) as response:
                    self.assertEqual(json.load(response)["papers"], [])
                worker = next(t for t in threading.enumerate() if t.name == "zotero-library-sync")
                release.set()
                worker.join(3)
                self.assertFalse(worker.is_alive())
                with urllib.request.urlopen(base + "/api/zotero/sync", timeout=2) as response:
                    status = json.load(response)
                    self.assertEqual(status["status"], "complete")
                    self.assertEqual(status["result"]["stats"]["added"], 2)
                self.assertEqual(len(app.load_state()["citations"]), 1)
            finally:
                release.set()
                if worker:
                    worker.join(3)
                server.shutdown()
                server.server_close()
                thread.join(2)

    def test_failed_scan_does_not_advance_saved_state(self):
        before = app.DATA_FILE.read_bytes()
        job = app.ZoteroLibrarySync()
        with patch.object(app, "collect_snapshot", side_effect=ConnectionError("Zotero unavailable")):
            job.run()
        self.assertEqual(job.public()["status"], "error")
        self.assertEqual(app.DATA_FILE.read_bytes(), before)

    def test_merge_reloads_latest_local_marks_after_slow_scan(self):
        state = app.load_state()
        app.merge_zotero_snapshot(state, snapshot())
        app.save_state(state)
        paper_id = state["papers"][0]["id"]

        def collect(getter, previous, progress):
            latest = app.load_state()
            app.apply_action(latest, "paper.mark", {"id": paper_id, "readStatus": "read"})
            app.apply_action(latest, "paper.create", {"title": "Locally added while syncing"})
            app.save_state(latest)
            progress({"phase": "references", "current": 2, "total": 2})
            return snapshot()

        job = app.ZoteroLibrarySync()
        with patch.object(app, "collect_snapshot", side_effect=collect), patch.object(app.SYNC, "mark_dirty"):
            job.run()
        latest = app.load_state()
        self.assertEqual(latest["papers"][0]["readStatus"], "read")
        self.assertEqual(len(latest["papers"]), 3)
        self.assertEqual(job.public()["status"], "complete")
        self.assertEqual(job.public()["processed"], 2)

    def test_concurrent_sync_requests_share_a_job(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()

        def collect(*args):
            entered.set()
            release.wait(3)
            return snapshot()

        job = app.ZoteroLibrarySync()
        original = job.run

        def run():
            try:
                original()
            finally:
                finished.set()

        with patch.object(app, "collect_snapshot", side_effect=collect) as collector, patch.object(app.SYNC, "mark_dirty"), patch.object(job, "run", side_effect=run):
            try:
                self.assertEqual(job.start()["status"], "running")
                self.assertTrue(entered.wait(2))
                self.assertEqual(job.start()["status"], "running")
                self.assertEqual(collector.call_count, 1)
            finally:
                release.set()
                self.assertTrue(finished.wait(3))
        self.assertEqual(job.public()["status"], "complete")


if __name__ == "__main__":
    unittest.main()
