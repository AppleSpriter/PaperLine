import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class ModelFamilyIdeaCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.state = app.default_state()
        self.family = app.apply_action(self.state, "line.create", {"title": "Synthetic model evolution", "kind": "model_family"})["lineId"]
        self.stage = app.apply_action(self.state, "stage.create", {
            "title": "Existing release", "lineId": self.family, "date": "2026-10-17", "summary": "User-edited stage notes",
        })["stageId"]
        source = app.apply_action(self.state, "stage.add_source", {
            "stageId": self.stage, "lineId": self.family, "sourceType": "model", "title": "User-edited model", "summary": "Keep this description",
        })["paperId"]
        app.apply_action(self.state, "paper.annotate_method", {
            "paperId": source, "stageId": self.stage, "title": "Existing method", "relation": "proposes", "note": "Keep this evidence",
        })
        self.other = app.apply_action(self.state, "line.create", {"title": "Another user line"})["lineId"]
        self.existing_idea = app.apply_action(self.state, "idea.create", {
            "title": "User's existing concept", "entityType": "concept", "lineId": self.other, "summary": "Keep my understanding",
            "mechanism": "Keep my mechanism", "thoughts": "Keep my thoughts",
        })["ideaId"]

    def assert_existing_content_preserved(self, before):
        for key in ("stages", "papers", "edges", "sessions", "settings", "citations", "recommendations"):
            self.assertEqual(self.state[key], before[key], key)
        self.assertEqual(len(self.state["lines"]), len(before["lines"]))
        self.assertEqual(app.find(self.state, "lines", self.other), app.find(before, "lines", self.other))
        old_family = app.find(before, "lines", self.family)
        current_family = app.find(self.state, "lines", self.family)
        for key, value in old_family.items():
            if key not in {"ideaIds", "activeIdeaId", "updatedAt"}:
                self.assertEqual(current_family[key], value, key)
        for old in before["ideas"]:
            self.assertEqual(app.find(self.state, "ideas", old["id"]), old)
        self.assertEqual(app.validate_backup(self.state), self.state)

    def test_create_and_reuse_in_model_family_do_not_change_existing_stage_facts_or_card_content(self):
        before = copy.deepcopy(self.state)
        created = app.apply_action(self.state, "idea.create", {
            "title": "New line-level thought", "entityType": "question", "lineId": self.family, "summary": "Not a stage contribution",
        })["ideaId"]
        self.assert_existing_content_preserved(before)
        self.assertIn(created, app.find(self.state, "lines", self.family)["ideaIds"])
        before = copy.deepcopy(self.state)
        app.apply_action(self.state, "idea.reuse", {"id": self.existing_idea, "lineId": self.family})
        app.apply_action(self.state, "idea.reuse", {"id": self.existing_idea, "lineId": self.family})
        self.assert_existing_content_preserved(before)
        self.assertEqual(app.find(self.state, "lines", self.family)["ideaIds"], [created, self.existing_idea])

    def test_reading_current_schema_file_is_byte_preserving_and_line_cards_export_without_stage_inference(self):
        app.apply_action(self.state, "line.attach", {"lineId": self.family, "ideaId": self.existing_idea})
        original = json.dumps(self.state, ensure_ascii=False, indent=3).encode("utf-8")
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            primary = folder / "state-v2.json"
            primary.write_bytes(original)
            with patch.multiple(app, DATA_FILE=primary, BACKUP_FILE=folder / "state-v2.backup.json", LEGACY_DATA_FILE=folder / "state.json", _RECOMMENDATION_CACHE=None):
                loaded = app.load_state()
                self.assertEqual(loaded, self.state)
                self.assertEqual(primary.read_bytes(), original)
                self.assertFalse((folder / "state-v2.backup.json").exists())
            family_note = app.render_note(loaded, "line", app.find(loaded, "lines", self.family))
            self.assertIn("User's existing concept", family_note)
            stage_note = app.render_note(loaded, "stage", app.find(loaded, "stages", self.stage))
            self.assertNotIn("User's existing concept", stage_note)
