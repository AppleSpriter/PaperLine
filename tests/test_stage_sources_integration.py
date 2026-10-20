import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class StageSourceIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.state = app.default_state()
        self.line_id = app.apply_action(self.state, "line.create", {"title": "Synthetic family", "kind": "model_family"})["lineId"]
        self.stage_id = app.apply_action(self.state, "stage.create", {"title": "New release", "lineId": self.line_id})["stageId"]

    def source(self, kind, title, url="", summary=""):
        result = app.apply_action(self.state, "stage.add_source", {
            "stageId": self.stage_id, "lineId": self.line_id,
            "sourceType": kind, "title": title, "url": url, "summary": summary,
        })
        return app.find(self.state, "papers", result["paperId"])

    def test_source_fields_and_method_memberships_survive_backup_and_zotero_sync(self):
        web = self.source("webpage", "Synthetic release notes", "https://example.invalid/release", "Official announcement")
        model = self.source("model", "Synthetic Model Preview", summary="Model without a paper or URL yet")
        app.apply_action(self.state, "paper.annotate_method", {
            "paperId": web["id"], "stageId": self.stage_id, "title": "Synthetic cache method", "relation": "proposes",
            "note": "Explicit announcement evidence", "sourceUrl": web["url"],
        })
        before = copy.deepcopy(self.state)
        self.assertEqual(app.validate_backup(json.loads(json.dumps(before))), before)
        with patch.object(app, "webdav_exchange", return_value=(200, json.dumps(before).encode(), {"ETag": '"synthetic"'})):
            self.assertEqual(app.cloud_snapshot({"folder": "synthetic"})["data"], before)
        snapshot = {"papers": [{"zoteroKey": "SYNTH001", "title": "A Zotero paper", "authors": "", "year": "2026", "doi": ""}],
                    "citations": [], "recommendations": [], "stats": {"papers": 1}}
        app.merge_zotero_snapshot(self.state, snapshot)
        for source in (web, model):
            self.assertEqual(app.find(self.state, "papers", source["id"]), source)
        self.assertEqual(self.state["edges"], before["edges"])
        self.assertEqual(self.state["ideas"], before["ideas"])
        self.assertEqual(app.validate_backup(self.state), self.state)

    def test_reference_recommendations_exclude_web_and_model_sources_even_with_paper_identifiers(self):
        paper_id = app.apply_action(self.state, "paper.create", {"title": "Actual paper"})["paperId"]
        web = self.source("webpage", "Actual paper", "https://arxiv.org/abs/2401.00001")
        model = self.source("model", "Model card", "https://example.invalid/model")
        self.state["citations"] = [{"id": "synthetic-citation", "fromId": paper_id, "toId": web["id"], "evidence": "Not a paper citation"}]
        before = copy.deepcopy(self.state)
        with patch.object(app, "reference_recommendations", wraps=app.reference_recommendations) as rebuild:
            app.rebuild_recommendations(self.state)
        papers, citations = rebuild.call_args.args
        self.assertEqual([paper["id"] for paper in papers], [paper_id])
        self.assertEqual(citations, [])
        self.assertNotIn(model["id"], {paper["id"] for paper in papers})
        self.assertEqual(self.state, before)

    def test_export_preserves_type_link_description_methods_and_stable_owned_filename(self):
        web = self.source("webpage", "Release announcement", "https://example.invalid/release", "A new model and a new technique")
        model = self.source("model", "Model Preview", summary="No paper published yet")
        result = app.apply_action(self.state, "paper.annotate_method", {
            "paperId": web["id"], "stageId": self.stage_id, "title": "Shared technique", "relation": "proposes",
            "note": "Announcement evidence", "sourceUrl": web["url"],
        })
        stage = app.find(self.state, "stages", self.stage_id)
        for language, labels in (("zh", ("资料类型：网页", "阶段资料", "网页", "模型", "相关资料")),
                                 ("en", ("Material type：Web page", "Stage materials", "Web page", "Model", "Related materials"))):
            self.state["settings"]["language"] = language
            note = app.render_note(self.state, "paper", web)
            self.assertIn(labels[0], note)
            self.assertIn(web["url"], note)
            self.assertIn(web["summary"], note)
            self.assertIn("Shared technique", note)
            stage_note = app.render_note(self.state, "stage", stage)
            self.assertIn(labels[1], stage_note)
            self.assertIn(labels[2] + " · [[", stage_note)
            self.assertIn(labels[3] + " · [[", stage_note)
            self.assertIn(labels[4], app.render_note(self.state, "idea", app.find(self.state, "ideas", result["ideaId"])))
            self.assertIn(model["summary"], app.render_note(self.state, "paper", model))
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            (vault / ".obsidian").mkdir()
            self.state["settings"]["vaultPath"] = directory
            app.export_obsidian(self.state)
            path = vault / "PaperLine" / "论文" / app.note_name(web)
            path.write_text(path.read_text() + "My handwritten source note\n")
            filename = web["fileName"]
            app.apply_action(self.state, "source.update", {"id": web["id"], "title": "Updated announcement", "url": web["url"], "summary": "Updated description"})
            app.export_obsidian(self.state)
            self.assertEqual(app.find(self.state, "papers", web["id"])["fileName"], filename)
            self.assertIn("Updated description", path.read_text())
            self.assertTrue(path.read_text().endswith("My handwritten source note\n"))
            self.assertNotIn("PAPERLINE:", path.read_text())

    def test_removing_one_stage_preserves_shared_source_and_its_method(self):
        web = self.source("webpage", "Shared announcement", "https://example.invalid/shared")
        other = app.apply_action(self.state, "stage.create", {"title": "Later release", "lineId": self.line_id})["stageId"]
        app.apply_action(self.state, "paper.add_to_stage", {"paperId": web["id"], "stageId": other})
        method = app.apply_action(self.state, "paper.annotate_method", {
            "paperId": web["id"], "stageId": other, "title": "Shared method", "relation": "improves",
        })
        app.apply_action(self.state, "stage.remove_paper", {"paperId": web["id"], "stageId": self.stage_id})
        self.assertEqual(app.find(self.state, "papers", web["id"]), web)
        remaining = [edge for edge in self.state["edges"] if edge.get("toType") == "stage" and edge["fromId"] == web["id"]]
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["toId"], other)
        self.assertEqual(remaining[0]["contributionRefs"], [method["edgeId"]])
        self.assertEqual(app.validate_backup(self.state), self.state)
