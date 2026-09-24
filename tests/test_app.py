import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

import app


class ReadingGraphTests(unittest.TestCase):
    def setUp(self):
        self.state = app.default_state()

    def make_line_and_idea(self):
        line_id = app.apply_action(self.state, "line.create", {"title": "如何稳定策略更新？"})["lineId"]
        idea_id = app.apply_action(self.state, "idea.create", {
            "title": "GRPO", "kind": "concept", "lineId": line_id,
            "summary": "一个需要继续理解的策略优化思想。",
        })["ideaId"]
        return line_id, idea_id

    def test_many_papers_share_one_idea_and_export_preserves_manual_notes(self):
        line_id, idea_id = self.make_line_and_idea()
        papers = []
        for title in ("论文 A", "论文 B"):
            paper_id = app.apply_action(self.state, "paper.create", {"title": title})["paperId"]
            app.apply_action(self.state, "edge.create", {
                "fromType": "paper", "fromId": paper_id, "toId": idea_id,
                "relation": "uses", "note": f"{title} 在训练中使用这一思想。",
            })
            papers.append(paper_id)

        self.assertEqual(len(self.state["ideas"]), 1)
        self.assertEqual(len(self.state["edges"]), 2)
        self.assertEqual(self.state["lines"][0]["activeIdeaId"], idea_id)

        with tempfile.TemporaryDirectory() as folder:
            vault = Path(folder)
            (vault / ".obsidian").mkdir()
            app.apply_action(self.state, "settings.update", {"vaultPath": str(vault)})
            result = app.export_obsidian(self.state)
            self.assertEqual(result["count"], 4)
            idea_path = vault / "PaperLine" / "思想卡" / app.note_name(self.state["ideas"][0])
            exported = idea_path.read_text(encoding="utf-8")
            self.assertIn("论文 A", exported)
            self.assertIn("论文 B", exported)
            idea_path.write_text(exported + "\n这是我在 Obsidian 手写的补充。\n", encoding="utf-8")

            app.apply_action(self.state, "idea.update", {
                "id": idea_id, "title": "GRPO：策略优化", "kind": "concept",
                "status": "learning", "summary": "更新后的理解。", "mechanism": "",
                "thoughts": "",
            })
            app.export_obsidian(self.state)
            updated = idea_path.read_text(encoding="utf-8")
            self.assertIn("更新后的理解。", updated)
            self.assertIn("这是我在 Obsidian 手写的补充。", updated)
            self.assertEqual(len(list((vault / "PaperLine" / "思想卡").glob("*.md"))), 1)

    def test_duplicate_relation_rejected_and_detach_keeps_idea(self):
        line_id, idea_id = self.make_line_and_idea()
        paper_id = app.apply_action(self.state, "paper.create", {"title": "论文 A"})["paperId"]
        payload = {"fromType": "paper", "fromId": paper_id, "toId": idea_id, "relation": "uses"}
        app.apply_action(self.state, "edge.create", payload)
        with self.assertRaisesRegex(ValueError, "已经存在"):
            app.apply_action(self.state, "edge.create", payload)
        self.assertEqual(len(self.state["edges"]), 1)
        app.apply_action(self.state, "line.detach", {"lineId": line_id, "ideaId": idea_id})
        self.assertEqual(self.state["lines"][0]["ideaIds"], [])
        self.assertEqual(len(self.state["ideas"]), 1)
        self.assertEqual(len(self.state["edges"]), 1)

    def test_unmanaged_existing_note_is_not_overwritten(self):
        self.make_line_and_idea()
        with tempfile.TemporaryDirectory() as folder:
            vault = Path(folder)
            (vault / ".obsidian").mkdir()
            app.apply_action(self.state, "settings.update", {"vaultPath": str(vault)})
            idea_path = vault / "PaperLine" / "思想卡" / app.note_name(self.state["ideas"][0])
            idea_path.parent.mkdir(parents=True)
            idea_path.write_text("我的既有笔记", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "保护手写内容"):
                app.export_obsidian(self.state)
            self.assertEqual(idea_path.read_text(encoding="utf-8"), "我的既有笔记")

    def test_english_settings_and_export_preserve_existing_manual_sections(self):
        self.make_line_and_idea()
        paper_id = app.apply_action(self.state, "paper.create", {"title": "A research paper"})["paperId"]
        paper = app.find(self.state, "papers", paper_id)
        with tempfile.TemporaryDirectory() as folder:
            vault = Path(folder)
            (vault / ".obsidian").mkdir()
            app.apply_action(self.state, "settings.update", {"vaultPath": str(vault), "language": "en"})
            self.assertEqual(self.state["settings"]["language"], "en")
            app.export_obsidian(self.state)
            paper_path = vault / "PaperLine" / "论文" / app.note_name(paper)
            first = paper_path.read_text(encoding="utf-8")
            self.assertIn("## Problem addressed", first)
            self.assertIn("### Relationship to other methods", first)
            self.assertIn("## Related ideas", first)

            app.apply_action(self.state, "settings.update", {"vaultPath": str(vault), "language": "zh"})
            app.export_obsidian(self.state)
            updated = paper_path.read_text(encoding="utf-8")
            self.assertIn("## 相关思想", updated)
            self.assertIn("## Problem addressed", updated)

        with self.assertRaisesRegex(ValueError, "界面语言无效"):
            app.apply_action(self.state, "settings.update", {"language": "fr"})

    def test_zotero_annotation_link_points_back_to_pdf(self):
        def fake_get(path, params=None):
            if path.endswith("/ABCD1234/children"):
                return [{"key": "EFGH5678", "data": {"itemType": "attachment"}}]
            if path.endswith("/EFGH5678/children"):
                return [{"key": "IJKL9012", "data": {
                    "itemType": "annotation", "annotationText": "关键发现",
                    "annotationComment": "需要追问", "annotationPageLabel": "iv",
                    "annotationPosition": '{"pageIndex": 3}',
                }}]
            raise AssertionError(path)

        with patch.object(app, "zotero_get", side_effect=fake_get):
            annotations = app.zotero_annotations("ABCD1234")
        self.assertEqual(len(annotations), 1)
        self.assertEqual(annotations[0]["page"], "iv")
        self.assertEqual(
            annotations[0]["sourceUrl"],
            "zotero://open-pdf/library/items/EFGH5678?page=4&annotation=IJKL9012",
        )


class HttpTests(unittest.TestCase):
    def test_local_api_persists_and_rejects_foreign_origin(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(app, "DATA_FILE", Path(folder) / "state.json"):
            server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            body = json.dumps({"action": "line.create", "payload": {"title": "一个研究问题"}}).encode()
            try:
                request = urllib.request.Request(
                    base + "/api/action", data=body,
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(request) as response:
                    result = json.load(response)
                self.assertEqual(result["state"]["lines"][0]["title"], "一个研究问题")
                self.assertTrue((Path(folder) / "state.json").exists())

                foreign = urllib.request.Request(
                    base + "/api/action", data=body,
                    headers={"Content-Type": "application/json", "Origin": "https://elsewhere.example"}, method="POST",
                )
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(foreign)
                self.assertEqual(error.exception.code, 403)
                error.exception.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
