import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class ExportSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name)
        (self.vault / '.obsidian').mkdir()
        self.state = app.default_state()
        self.state['settings']['vaultPath'] = str(self.vault)
        self.line_id = app.apply_action(self.state, 'line.create', {'title': 'Research'})['lineId']
        self.line = self.state['lines'][0]
        self.path = self.vault / 'PaperLine' / '阅读线' / app.note_name(self.line)

    def test_marker_free_updates_preserve_before_after_and_stable_filename(self):
        app.export_obsidian(self.state)
        text = self.path.read_text()
        self.assertNotIn('PAPERLINE:', text)
        self.path.write_text('My preface\n' + text + '\nMy afterword\n')
        app.apply_action(self.state, 'line.update', {'id': self.line_id, 'title': 'Updated'})
        app.export_obsidian(self.state)
        text = self.path.read_text()
        self.assertTrue(text.startswith('My preface\n'))
        self.assertTrue(text.endswith('\nMy afterword\n'))
        self.assertIn('# Updated', text)
        stamp = self.path.stat().st_mtime_ns
        result = app.export_obsidian(self.state)
        self.assertEqual((result['count'], result['skipped']), (0, 1))
        self.assertEqual(stamp, self.path.stat().st_mtime_ns)
        self.assertTrue((self.vault / 'PaperLine' / '.paperline-export.json').is_file())

    def test_legacy_markers_migrate_preserving_manual_additions(self):
        generated = app.render_note(self.state, 'line', self.line)
        self.path.parent.mkdir(parents=True)
        self.path.write_text(f'Preface\n<!-- PAPERLINE:START {self.line_id} -->\n{generated}<!-- PAPERLINE:END {self.line_id} -->\nAfterword\n')
        app.export_obsidian(self.state)
        self.assertEqual(self.path.read_text(), 'Preface\n' + generated + '\nAfterword\n')
        self.assertNotIn('PAPERLINE:', self.path.read_text())

    def test_deleted_owned_notes_moved_recoverably_unrelated_files_untouched(self):
        app.export_obsidian(self.state)
        text = self.path.read_text() + 'My handwritten notes\n'
        self.path.write_text(text)
        unrelated = self.path.parent / 'My personal line.md'
        unrelated.write_text('manual')
        app.apply_action(self.state, 'line.delete', {'id': self.line_id})
        result = app.export_obsidian(self.state)
        self.assertEqual(result['removed'], 1)
        self.assertFalse(self.path.exists())
        trash = self.vault / '.trash' / 'PaperLine' / '阅读线' / self.path.name
        self.assertEqual(trash.read_text(), text)
        self.assertEqual(unrelated.read_text(), 'manual')
        self.assertEqual(app.export_obsidian(self.state)['removed'], 0)

    def test_stale_legacy_line_migrates_to_trash_without_manifest(self):
        self.path.parent.mkdir(parents=True)
        text = f'<!-- PAPERLINE:START {self.line_id} -->\nOld\n<!-- PAPERLINE:END {self.line_id} -->\nmanual'
        self.path.write_text(text)
        self.state['lines'] = []
        self.assertEqual(app.export_obsidian(self.state)['removed'], 1)
        self.assertEqual((self.vault / '.trash' / 'PaperLine' / '阅读线' / self.path.name).read_text(), text)

    def test_edited_generated_text_stops_all_writes_and_deletions(self):
        second_id = app.apply_action(self.state, 'line.create', {'title': 'Second'})['lineId']
        app.export_obsidian(self.state)
        second = self.vault / 'PaperLine' / '阅读线' / app.note_name(self.state['lines'][1])
        self.path.write_text(self.path.read_text().replace('# Research', '# Manually edited'))
        app.apply_action(self.state, 'line.delete', {'id': second_id})
        app.apply_action(self.state, 'paper.create', {'title': 'New paper'})
        manifest = self.vault / 'PaperLine' / '.paperline-export.json'
        before = manifest.read_bytes()
        with self.assertRaisesRegex(ValueError, '保护手写内容'):
            app.export_obsidian(self.state)
        self.assertTrue(second.exists())
        self.assertFalse((self.vault / 'PaperLine' / '论文').exists())
        self.assertEqual(before, manifest.read_bytes())

    def test_ambiguous_generated_text_stops_export(self):
        app.export_obsidian(self.state)
        generated = app.render_note(self.state, 'line', self.line)
        self.path.write_text(self.path.read_text() + generated)
        with self.assertRaises(ValueError):
            app.export_obsidian(self.state)

    def test_path_traversal_and_symlink_rejected_before_write(self):
        self.line['fileName'] = '../../escape.md'
        with self.assertRaises(ValueError):
            app.export_obsidian(self.state)
        self.line.pop('fileName')
        outside = self.vault / 'outside'
        outside.mkdir()
        (self.vault / 'PaperLine').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            app.export_obsidian(self.state)
        self.assertEqual(list(outside.iterdir()), [])

    def test_final_manifest_failure_retries_without_losing_manual_notes(self):
        app.export_obsidian(self.state)
        self.path.write_text('Preface\n' + self.path.read_text() + 'Manual afterword\n')
        app.apply_action(self.state, 'line.update', {'id': self.line_id, 'title': 'Changed'})
        replace = app.os.replace
        manifest_calls = 0

        def fail_final(source, target):
            nonlocal manifest_calls
            if Path(target).name == '.paperline-export.json':
                manifest_calls += 1
                if manifest_calls == 2:
                    raise OSError('simulated final manifest failure')
            return replace(source, target)

        with patch.object(app.os, 'replace', side_effect=fail_final):
            with self.assertRaises(OSError):
                app.export_obsidian(self.state)
        self.assertIn('# Changed', self.path.read_text())
        # A later state change must also recover from the outstanding generation.
        app.apply_action(self.state, 'line.update', {'id': self.line_id, 'title': 'Changed again'})
        app.export_obsidian(self.state)
        self.assertIn('# Changed again', self.path.read_text())
        self.assertTrue(self.path.read_text().startswith('Preface\n'))
        self.assertTrue(self.path.read_text().endswith('Manual afterword\n'))
        manifest = json.loads((self.vault / 'PaperLine' / '.paperline-export.json').read_text())
        self.assertTrue(all('pendingGenerated' not in entry for entry in manifest['notes'].values()))

    def test_mid_note_failure_retries_and_deleted_note_moves_once(self):
        deleted_id = app.apply_action(self.state, 'line.create', {'title': 'Delete later'})['lineId']
        app.export_obsidian(self.state)
        deleted_path = self.vault / 'PaperLine' / '阅读线' / app.note_name(self.state['lines'][1])
        deleted_path.write_text(deleted_path.read_text() + 'Keep deleted manual text\n')
        self.path.write_text(self.path.read_text() + 'Keep live manual text\n')
        app.apply_action(self.state, 'line.update', {'id': self.line_id, 'title': 'Changed'})
        app.apply_action(self.state, 'line.delete', {'id': deleted_id})
        app.apply_action(self.state, 'paper.create', {'title': 'New'})
        replace = app.os.replace
        notes_written = 0

        def fail_second_note(source, target):
            nonlocal notes_written
            if Path(target).suffix == '.md':
                notes_written += 1
                if notes_written == 2:
                    raise OSError('simulated note failure')
            return replace(source, target)

        with patch.object(app.os, 'replace', side_effect=fail_second_note):
            with self.assertRaises(OSError):
                app.export_obsidian(self.state)
        self.assertTrue(deleted_path.exists())
        self.assertIn('# Changed', self.path.read_text())
        result = app.export_obsidian(self.state)
        self.assertEqual(result['removed'], 1)
        self.assertTrue(self.path.read_text().endswith('Keep live manual text\n'))
        trash = self.vault / '.trash' / 'PaperLine' / '阅读线' / deleted_path.name
        self.assertTrue(trash.read_text().endswith('Keep deleted manual text\n'))
        self.assertEqual(app.export_obsidian(self.state)['removed'], 0)

    def test_invalid_manifest_does_not_sweep_manual_note(self):
        app.export_obsidian(self.state)
        manifest = self.vault / 'PaperLine' / '.paperline-export.json'
        manifest.write_text(json.dumps({'version': 1, 'notes': {'../../manual.md': {'id': 'l_a', 'kind': 'line', 'generated': 'text'}}}))
        before = self.path.read_bytes()
        with self.assertRaises(ValueError):
            app.export_obsidian(self.state)
        self.assertEqual(before, self.path.read_bytes())


if __name__ == '__main__':
    unittest.main()
