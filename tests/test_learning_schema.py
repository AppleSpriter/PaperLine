import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import app
import learning


class LearningDomainTests(unittest.TestCase):
    def setUp(self):
        self.state = app.default_state()
        self.paper = self.action("paper.create", title="DeepSeek research")["paperId"]

    def action(self, action, **payload):
        return app.apply_action(self.state, action, payload)

    def test_stage_accepts_multiple_papers_without_ideas_and_shares_across_lines(self):
        first = self.action("paper.add_to_stage", paperId=self.paper, lineTitle="DeepSeek", stageTitle="R1", summary="Stage summary")
        second_paper = self.action("paper.create", title="R1 analysis")["paperId"]
        again = self.action("paper.add_to_stage", paperId=second_paper, lineTitle="DeepSeek", stageTitle="Ｒ１")
        self.assertEqual(first["stageId"], again["stageId"])
        self.assertEqual(first["lineId"], again["lineId"])
        self.assertEqual(self.state["ideas"], [])
        self.assertEqual(len(self.state["stages"]), 1)
        other = self.action("line.create", title="Comparison", kind="model_family")["lineId"]
        self.action("line.attach_stage", lineId=other, stageId=first["stageId"])
        self.action("line.detach_stage", lineId=first["lineId"], stageId=first["stageId"])
        self.assertEqual(app.find(self.state, "lines", other)["stageIds"], [first["stageId"]])
        self.assertEqual(self.state["stages"][0]["summary"], "Stage summary")
        self.assertEqual(len(self.state["edges"]), 2)
        app.validate_backup(self.state)

    def test_stages_cannot_be_silently_hidden_in_a_legacy_research_line(self):
        line = self.action("line.create", title="Legacy line")["lineId"]
        stage = self.action("stage.create", title="R1")["stageId"]
        before = copy.deepcopy(self.state)
        for action, payload in (
            ("paper.add_to_stage", dict(paperId=self.paper, lineTitle="Legacy line", stageId=stage)),
            ("paper.add_to_stage", dict(paperId=self.paper, lineId=line, stageId=stage)),
            ("line.attach_stage", dict(lineId=line, stageId=stage)),
        ):
            with self.assertRaises(ValueError):
                self.action(action, **payload)
            self.assertEqual(self.state, before)

    def test_reorder_is_local_and_does_not_invent_inheritance_or_citations(self):
        first = self.action("paper.add_to_stage", paperId=self.paper, lineTitle="Family", stageTitle="Math")
        second = self.action("stage.create", title="V3", lineId=first["lineId"])
        edges = copy.deepcopy(self.state["edges"])
        self.action("line.move_stage", lineId=first["lineId"], stageId=second["stageId"], offset=-1)
        self.assertEqual(self.state["lines"][0]["stageIds"], [second["stageId"], first["stageId"]])
        self.assertEqual(self.state["edges"], edges)
        self.assertEqual(self.state["citations"], [])

    def test_method_reuse_and_relation_edit_preserve_identity_and_evidence(self):
        first = self.action("paper.annotate_method", paperId=self.paper, title="GRPO", relation="uses", note="Evidence", sourceUrl="https://example.org/passage")
        again = self.action("paper.annotate_method", paperId=self.paper, title="ＧＲＰＯ", relation="improves")
        self.assertEqual(first, again)
        edge = app.find(self.state, "edges", first["edgeId"])
        self.assertEqual((edge["relation"], edge["note"], edge["sourceUrl"]), ("improves", "Evidence", "https://example.org/passage"))
        self.action("idea.update", id=first["ideaId"], title="Group relative policy optimization")
        self.assertEqual(self.state["ideas"][0]["entityType"], "method")
        self.assertEqual(self.state["papers"][0]["readStatus"], "unread")
        self.assertEqual(len(self.state["ideas"]), 1)

    def test_ambiguous_names_and_legacy_relations_require_explicit_ids(self):
        first = self.action("paper.annotate_method", paperId=self.paper, title="GRPO", relation="uses")
        self.action("edge.create", fromType="paper", fromId=self.paper, toId=first["ideaId"], relation="questions", note="Legacy critique")
        before = copy.deepcopy(self.state)
        with self.assertRaisesRegex(ValueError, "多条旧关系"):
            self.action("paper.annotate_method", paperId=self.paper, ideaId=first["ideaId"], relation="proposes")
        self.assertEqual(before, self.state)
        self.action("paper.annotate_method", paperId=self.paper, ideaId=first["ideaId"], edgeId=first["edgeId"], relation="proposes")
        self.assertEqual(len(self.state["edges"]), 2)
        self.assertTrue(any(edge["relation"] == "questions" and edge["note"] == "Legacy critique" for edge in self.state["edges"]))
        self.action("idea.create", title="GRPO")
        with self.assertRaisesRegex(ValueError, "多个同名"):
            self.action("paper.annotate_method", paperId=self.paper, title="GRPO", relation="uses")

    def test_stage_method_annotation_reuses_global_identity_and_preserves_selected_contributions(self):
        previous = self.action("paper.annotate_method", paperId=self.paper, title="MLA", relation="uses")
        stage = self.action("paper.add_to_stage", paperId=self.paper, stageTitle="R1", contributionRefs=[previous["edgeId"]])
        method = self.action("idea.create", title="Group relative policy optimization", entityType="method",
                             aliases="GRPO")
        first = self.action("paper.annotate_method", paperId=self.paper, stageId=stage["stageId"], title="ＧＲＰＯ",
                            relation="uses", note="Evidence", sourceUrl="https://example.org/passage")
        again = self.action("paper.annotate_method", paperId=self.paper, stageId=stage["stageId"],
                            ideaId=method["ideaId"], relation="improves")
        self.assertEqual(first, again)
        self.assertEqual(first["ideaId"], method["ideaId"])
        self.assertEqual(first["membershipEdgeId"], stage["edgeId"])
        self.assertEqual(first["stageId"], stage["stageId"])
        membership = app.find(self.state, "edges", stage["edgeId"])
        self.assertEqual(membership["contributionRefs"], [previous["edgeId"], first["edgeId"]])
        edge = app.find(self.state, "edges", first["edgeId"])
        self.assertEqual((edge["relation"], edge["note"], edge["sourceUrl"]),
                         ("improves", "Evidence", "https://example.org/passage"))
        self.assertEqual(len(self.state["ideas"]), 2)
        app.validate_backup(self.state)

    def test_add_stage_contribution_preserves_current_relationship_and_is_idempotent(self):
        previous = self.action("paper.annotate_method", paperId=self.paper, title="MLA", relation="uses")
        method = self.action("paper.annotate_method", paperId=self.paper, title="CED", relation="proposes",
                             note="Original evidence", sourceUrl="https://example.org/ced")
        stage = self.action("paper.add_to_stage", paperId=self.paper, stageTitle="V4.1",
                            contributionRefs=[previous["edgeId"]])
        other_stage = self.action("paper.add_to_stage", paperId=self.paper, stageTitle="Other")
        # A stale client saw 'proposes'; an independent edit has since changed the relationship.
        self.action("edge.update", id=method["edgeId"], relation="uses")
        before = copy.deepcopy(self.state)
        request = {"stageId": stage["stageId"], "edgeId": method["edgeId"]}
        result = self.action("stage.add_contribution", **request)
        expected = copy.deepcopy(before)
        app.find(expected, "edges", stage["edgeId"])["contributionRefs"].append(method["edgeId"])
        self.assertEqual(self.state, expected)
        self.assertEqual(result, {**method, "stageId": stage["stageId"], "membershipEdgeId": stage["edgeId"]})
        self.assertEqual(app.find(self.state, "edges", method["edgeId"])["relation"], "uses")
        self.assertEqual(app.find(self.state, "edges", other_stage["edgeId"])["contributionRefs"], [])
        self.assertEqual(self.action("stage.add_contribution", **request), result)
        self.assertEqual(self.state, expected)
        app.validate_backup(self.state)

    def test_add_stage_contribution_rejects_invalid_context_without_changes(self):
        method = self.action("paper.annotate_method", paperId=self.paper, title="CED", relation="proposes")
        stage = self.action("stage.create", title="V4.1")["stageId"]
        before = copy.deepcopy(self.state)
        with self.assertRaisesRegex(ValueError, "先将这篇论文"):
            self.action("stage.add_contribution", stageId=stage, edgeId=method["edgeId"])
        self.assertEqual(self.state, before)
        membership = self.action("paper.add_to_stage", paperId=self.paper, stageId=stage)
        legacy = self.action("edge.create", fromType="paper", fromId=self.paper, toId=method["ideaId"], relation="questions")
        concept = self.action("idea.create", title="Concept", entityType="concept")
        concept_edge = self.action("edge.create", fromType="paper", fromId=self.paper, toId=concept["ideaId"], relation="uses")
        before = copy.deepcopy(self.state)
        for payload in (
            dict(stageId="missing", edgeId=method["edgeId"]),
            dict(stageId=stage, edgeId="missing"),
            dict(stageId=stage, edgeId=membership["edgeId"]),
            dict(stageId=stage, edgeId=legacy["edgeId"]),
            dict(stageId=stage, edgeId=concept_edge["edgeId"]),
            dict(stageId=stage, edgeId=method["edgeId"], relation="proposes"),
        ):
            with self.assertRaises(ValueError):
                self.action("stage.add_contribution", **payload)
            self.assertEqual(self.state, before)

    def test_stage_method_annotation_requires_existing_paper_membership_before_any_change(self):
        method = self.action("paper.annotate_method", paperId=self.paper, title="GRPO", relation="uses", note="Original")
        stage = self.action("stage.create", title="R1")["stageId"]
        other = self.action("paper.create", title="Other paper")["paperId"]
        self.action("paper.add_to_stage", paperId=other, stageId=stage)
        before = copy.deepcopy(self.state)
        for stage_id in (stage, "missing"):
            for payload in (
                dict(title="New method", relation="proposes"),
                dict(ideaId=method["ideaId"], relation="improves", note="Changed"),
            ):
                with self.assertRaises(ValueError):
                    self.action("paper.annotate_method", paperId=self.paper, stageId=stage_id, **payload)
                self.assertEqual(self.state, before)

    def test_stage_method_annotation_keeps_legacy_relation_choice_and_failure_atomic(self):
        method = self.action("paper.annotate_method", paperId=self.paper, title="GRPO", relation="uses", note="Usage evidence")
        critique = self.action("edge.create", fromType="paper", fromId=self.paper, toId=method["ideaId"],
                               relation="questions", note="Legacy critique")
        stage = self.action("paper.add_to_stage", paperId=self.paper, stageTitle="R1", contributionRefs=[critique["edgeId"]])
        before = copy.deepcopy(self.state)
        with self.assertRaisesRegex(ValueError, "多条旧关系"):
            self.action("paper.annotate_method", paperId=self.paper, stageId=stage["stageId"],
                        ideaId=method["ideaId"], relation="proposes")
        self.assertEqual(self.state, before)
        with self.assertRaises(ValueError):
            self.action("paper.annotate_method", paperId=self.paper, stageId=stage["stageId"],
                        title="New method", relation="proposes", sourceUrl="javascript:bad")
        self.assertEqual(self.state, before)
        result = self.action("paper.annotate_method", paperId=self.paper, stageId=stage["stageId"],
                             ideaId=method["ideaId"], edgeId=method["edgeId"], relation="proposes")
        self.assertEqual(result["edgeId"], method["edgeId"])
        self.assertEqual(app.find(self.state, "edges", stage["edgeId"])["contributionRefs"],
                         [critique["edgeId"], method["edgeId"]])
        self.assertEqual(app.find(self.state, "edges", critique["edgeId"])["note"], "Legacy critique")
        self.assertEqual(app.find(self.state, "edges", method["edgeId"])["note"], "Usage evidence")

    def test_stage_contribution_rename_and_unselect_preserve_global_method_and_relation(self):
        stage = self.action("paper.add_to_stage", paperId=self.paper, stageTitle="R1")
        method = self.action("paper.annotate_method", paperId=self.paper, stageId=stage["stageId"],
                             title="GRPO", relation="uses")
        self.action("idea.update", id=method["ideaId"], title="Renamed GRPO", summary="Updated method")
        self.action("edge.update", id=method["membershipEdgeId"], contributionRefs=[])
        self.assertEqual(app.find(self.state, "ideas", method["ideaId"])["title"], "Renamed GRPO")
        self.assertEqual(app.find(self.state, "edges", method["edgeId"])["toId"], method["ideaId"])
        self.assertEqual(app.find(self.state, "edges", stage["edgeId"])["contributionRefs"], [])
        self.action("paper.annotate_method", paperId=self.paper, stageId=stage["stageId"],
                    ideaId=method["ideaId"], relation="uses")
        self.action("idea.delete", id=method["ideaId"])
        self.assertEqual(app.find(self.state, "edges", stage["edgeId"])["contributionRefs"], [])
        app.validate_backup(self.state)

    def test_global_annotation_does_not_select_contributions_for_existing_memberships(self):
        stage = self.action("paper.add_to_stage", paperId=self.paper, stageTitle="R1")
        method = self.action("paper.annotate_method", paperId=self.paper, title="GRPO", relation="uses")
        self.assertEqual(set(method), {"paperId", "ideaId", "edgeId"})
        self.assertEqual(app.find(self.state, "edges", stage["edgeId"])["contributionRefs"], [])
        self.assertNotIn("已标注的论文贡献", app.render_note(self.state, "stage", self.state["stages"][0]))

    def test_composite_failure_publishes_no_partial_methods_lines_or_stages(self):
        before = copy.deepcopy(self.state)
        for action, payload in (
            ("paper.annotate_method", dict(paperId=self.paper, title="GRPO", relation="uses", sourceUrl="javascript:bad")),
            ("paper.add_to_stage", dict(paperId=self.paper, lineTitle="New family", stageTitle="R1", date="2026-99-99")),
        ):
            with self.assertRaises(ValueError):
                self.action(action, **payload)
            self.assertEqual(before, self.state)

    def test_contribution_refs_same_paper_only_cleanup_and_no_endpoint_retarget(self):
        method = self.action("paper.annotate_method", paperId=self.paper, title="GRPO", relation="uses")
        stage = self.action("paper.add_to_stage", paperId=self.paper, stageTitle="R1", contributionRefs=[method["edgeId"]])
        other = self.action("paper.create", title="Other paper")["paperId"]
        before = copy.deepcopy(self.state)
        with self.assertRaises(ValueError):
            self.action("paper.add_to_stage", paperId=other, stageId=stage["stageId"], contributionRefs=[method["edgeId"]])
        self.assertEqual(before, self.state)
        with self.assertRaises(ValueError):
            self.action("edge.update", id=method["edgeId"], toId="different")
        self.action("edge.delete", id=method["edgeId"])
        self.assertEqual(app.find(self.state, "edges", stage["edgeId"])["contributionRefs"], [])
        self.assertEqual(len(self.state["stages"]), 1)

    def test_global_sessions_preserve_deleted_targets_without_changing_paper_status(self):
        method = self.action("paper.annotate_method", paperId=self.paper, title="GRPO", relation="uses")
        self.action("session.create", targetType="paper", targetId=self.paper, note="Paper reading", durationSeconds=60)
        self.assertEqual(self.state["ideas"][0]["status"], "inbox")
        self.assertEqual(self.state["papers"][0]["readStatus"], "unread")
        self.action("session.create", targetType="idea", targetId=method["ideaId"], note="Method reading")
        self.action("idea.delete", id=method["ideaId"])
        self.action("paper.delete", id=self.paper)
        self.assertEqual(len(self.state["sessions"]), 2)
        self.assertTrue(all(record["targetSnapshot"]["deleted"] for record in self.state["sessions"]))
        app.validate_backup(self.state)

    def test_schema_validation_rejects_dangling_stage_or_contribution_refs(self):
        stage = self.action("paper.add_to_stage", paperId=self.paper, lineTitle="Family", stageTitle="R1")
        for mutate in (
            lambda state: state["lines"][0]["stageIds"].append("missing"),
            lambda state: state["edges"][0].update(contributionRefs=["missing"]),
            lambda state: state["stages"].append(copy.deepcopy(state["stages"][0])),
        ):
            bad = copy.deepcopy(self.state)
            mutate(bad)
            with self.assertRaises(ValueError):
                app.validate_backup(bad)

    def test_stage_export_has_bidirectional_links_and_keeps_manual_notes_on_rename(self):
        method = self.action("paper.annotate_method", paperId=self.paper, title="GRPO", relation="uses")
        stage = self.action("paper.add_to_stage", paperId=self.paper, lineTitle="DeepSeek", stageTitle="R1", contributionRefs=[method["edgeId"]])
        with tempfile.TemporaryDirectory() as folder:
            vault = Path(folder)
            (vault / ".obsidian").mkdir()
            self.state["settings"]["vaultPath"] = str(vault)
            app.export_obsidian(self.state)
            item = app.find(self.state, "stages", stage["stageId"])
            path = vault / "PaperLine" / "模型阶段" / item["fileName"]
            self.assertIn("仅导航", path.read_text(encoding="utf-8"))
            self.assertIn("DeepSeek", path.read_text(encoding="utf-8"))
            paper_path = vault / "PaperLine" / "论文" / self.state["papers"][0]["fileName"]
            self.assertIn(item["fileName"][:-3], paper_path.read_text(encoding="utf-8"))
            path.write_text(path.read_text(encoding="utf-8") + "\nHandwritten stage note\n", encoding="utf-8")
            self.action("stage.update", id=item["id"], title="DeepSeek R1")
            app.export_obsidian(self.state)
            self.assertTrue(path.exists())
            self.assertIn("Handwritten stage note", path.read_text(encoding="utf-8"))
            self.assertIn("# DeepSeek R1", path.read_text(encoding="utf-8"))


class SchemaMigrationTests(unittest.TestCase):
    def legacy(self):
        state = app.default_state()
        line = app.apply_action(state, "line.create", {"title": "Legacy research"})["lineId"]
        idea = app.apply_action(state, "idea.create", {"title": "GRPO", "lineId": line})["ideaId"]
        app.apply_action(state, "session.create", {"lineId": line, "ideaId": idea, "note": "Legacy reading"})
        app.apply_action(state, "line.delete", {"id": line})
        state["version"] = 1
        state.pop("stages")
        state["savedAt"] = "2025-01-01T00:00:00+00:00"
        for item in state["ideas"]:
            item.pop("entityType")
        for record in state["sessions"]:
            record.pop("targetType")
            record.pop("targetId")
            record.pop("targetSnapshot")
        return state

    def test_v1_import_preserves_ids_filename_notes_and_dangling_line_history(self):
        old = self.legacy()
        original = copy.deepcopy(old)
        upgraded = app.validate_backup(old)
        self.assertEqual(old, original)
        self.assertEqual(upgraded["version"], 2)
        self.assertEqual(upgraded["ideas"][0]["fileName"], old["ideas"][0]["fileName"])
        self.assertEqual(upgraded["ideas"][0]["entityType"], "unclassified")
        self.assertEqual(upgraded["sessions"][0]["lineId"], old["sessions"][0]["lineId"])
        self.assertEqual(upgraded["sessions"][0]["note"], "Legacy reading")
        self.assertEqual(app.validate_backup(upgraded), upgraded)

    def test_local_migration_is_read_only_for_v1_idempotent_and_preserves_timestamp(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            legacy = root / "state.json"
            legacy.write_text(json.dumps(self.legacy()), encoding="utf-8")
            before = legacy.read_bytes()
            with patch.object(app, "DATA_FILE", root / "state-v2.json"), patch.object(app, "BACKUP_FILE", root / "state-v2.backup.json"):
                result = app.load_state()
                self.assertEqual(result["savedAt"], "2025-01-01T00:00:00+00:00")
                self.assertTrue(result["_migration"]["pendingCloudConfirmation"])
                self.assertEqual(legacy.read_bytes(), before)
                v2 = app.DATA_FILE.read_bytes()
                self.assertEqual(app.load_state(), result)
                self.assertEqual(app.DATA_FILE.read_bytes(), v2)
                legacy.write_text("broken", encoding="utf-8")
                self.assertEqual(app.load_state(), result)

    def test_corrupt_or_future_legacy_never_creates_v2(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.object(app, "DATA_FILE", root / "state-v2.json"), patch.object(app, "BACKUP_FILE", root / "state-v2.backup.json"):
                for content in ("broken", json.dumps({"version": 99}), json.dumps({"version": 1, "ideas": "bad"})):
                    (root / "state.json").write_text(content, encoding="utf-8")
                    with self.assertRaises(ValueError):
                        app.load_state()
                    self.assertFalse(app.DATA_FILE.exists())


if __name__ == "__main__":
    unittest.main()
