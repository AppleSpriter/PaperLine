import io
import os
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import app
import desktop_backend

ROOT = Path(__file__).resolve().parents[1]


class DesktopProtocolTests(unittest.TestCase):
    def run_backend(self, directory, requests):
        process = subprocess.run(
            [sys.executable, str(ROOT / "desktop_backend.py"), "--data-dir", str(directory)],
            input="".join(json.dumps(item, ensure_ascii=False) + "\n" if not isinstance(item, str)
                          else item + "\n" for item in requests),
            text=True, encoding="utf-8", capture_output=True, timeout=20,
            env={**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"},
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        return [json.loads(line) for line in process.stdout.splitlines()], process.stderr

    def request(self, request_id, method, path, body=None):
        return {"id": request_id, "method": method, "path": path, "body": body or {}}

    def test_subprocess_action_backup_restore_and_eof(self):
        backup = app.default_state()
        app.apply_action(backup, "line.create", {"title": "Imported reading line"})
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder) / "Application Support" / "论文助手 PaperLine"
            replies, diagnostics = self.run_backend(directory, [
                self.request(1, "GET", "/api/state"),
                self.request(2, "POST", "/api/action", {
                    "action": "line.create", "payload": {"title": "原生中文阅读线"}}),
                self.request(3, "GET", "/api/backup"),
                self.request(4, "POST", "/api/restore", {"backup": backup}),
                self.request(5, "GET", "/api/desktop/info"),
                self.request(6, "GET", "/api/zotero/sync"),
            ])
            self.assertEqual(replies[0], {"ready": True, "protocol": 1})
            self.assertEqual(replies[1]["data"]["lines"], [])
            self.assertEqual(replies[3]["data"]["lines"][0]["title"], "原生中文阅读线")
            self.assertEqual(replies[4]["data"]["state"]["lines"][0]["title"], "Imported reading line")
            self.assertEqual(replies[5]["data"]["dataDir"], str(directory.resolve()))
            self.assertEqual(replies[6]["data"]["status"], "idle")
            self.assertTrue((directory / "state.json").is_file())
            self.assertTrue((directory / "state.backup.json").is_file())
            self.assertTrue(list(directory.glob("state.before-restore-*.json")))
            self.assertEqual(diagnostics, "")

    def test_protocol_errors_do_not_end_session_and_shutdown_stops_reading(self):
        with tempfile.TemporaryDirectory() as folder:
            replies, _ = self.run_backend(folder, [
                "invalid json", [],
                self.request("invalid", "POST", "/api/action", {"action": 42}),
                self.request("missing", "GET", "/api/missing"),
                self.request("exit", "POST", "/api/desktop/shutdown"),
                self.request("after", "GET", "/api/state"),
            ])
            self.assertEqual([item["status"] for item in replies[1:]], [400, 400, 400, 404, 200])
            self.assertEqual(replies[-1]["id"], "exit")

    def test_credentials_are_separate_and_private(self):
        with tempfile.TemporaryDirectory() as folder:
            replies, diagnostics = self.run_backend(folder, [
                self.request(1, "POST", "/api/webdav/config", {
                    "url": "https://example.invalid/dav", "username": "reader",
                    "password": "test-secret", "enabled": False, "folder": "PaperLine"}),
                self.request(2, "GET", "/api/backup"),
            ])
            self.assertEqual(replies[1]["status"], 200)
            self.assertTrue(replies[1]["data"]["hasPassword"])
            self.assertNotIn("test-secret", json.dumps(replies) + diagnostics)
            if os.name != "nt":
                self.assertEqual((Path(folder) / "webdav.json").stat().st_mode & 0o777, 0o600)
            self.assertNotIn("password", replies[2]["data"])

    def test_resource_directory_and_invalid_data_fail_before_ready(self):
        for directory in (ROOT,):
            process = subprocess.run(
                [sys.executable, str(ROOT / "desktop_backend.py"), "--data-dir", str(directory)],
                text=True, capture_output=True, timeout=10,
            )
            self.assertEqual(process.returncode, 1)
            self.assertEqual(process.stdout, "")
        with tempfile.TemporaryDirectory() as folder:
            (Path(folder) / "state.json").write_text("broken", encoding="utf-8")
            process = subprocess.run(
                [sys.executable, str(ROOT / "desktop_backend.py"), "--data-dir", folder],
                text=True, capture_output=True, timeout=10,
            )
            self.assertEqual(process.returncode, 1)
            self.assertEqual(process.stdout, "")
            self.assertEqual((Path(folder) / "state.json").read_text(), "broken")

    def test_shared_routes_and_typed_errors(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            with patch.object(app, "zotero_search", return_value=[{"title": "Result"}]) as search:
                reply, _ = desktop_backend.respond(self.request(1, "GET", "/api/zotero/search?q=hello"), directory)
                self.assertEqual(reply["data"], {"items": [{"title": "Result"}]})
                search.assert_called_once_with("hello")
            for error, expected in ((ValueError("invalid"), 400),
                                    (ConnectionError("offline"), 503),
                                    (app.SyncConflict("conflict"), 409)):
                with patch.object(app, "api_request", side_effect=error):
                    reply, _ = desktop_backend.respond(self.request(2, "GET", "/api/state"), directory)
                    self.assertEqual(reply["status"], expected)

    def test_webdav_save_works_without_posix_fchmod(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(app, "WEBDAV_FILE", Path(folder) / "webdav.json"), patch.object(app.os, "fchmod", None, create=True):
                app.save_webdav({**app.default_webdav(), "password": "fixture-secret"})
                self.assertEqual(app.load_webdav()["password"], "fixture-secret")

    def test_obsidian_export_supports_chinese_paths_and_rejects_windows_invalid_names(self):
        with tempfile.TemporaryDirectory() as folder:
            vault = Path(folder) / "中文 Obsidian 仓库"
            (vault / ".obsidian").mkdir(parents=True)
            state = app.default_state()
            state["settings"]["vaultPath"] = str(vault)
            app.apply_action(state, "line.create", {"title": "CON：论文 / 阅读问题"})
            result = app.export_obsidian(state)
            self.assertEqual(result["count"], 1)
            self.assertTrue((vault / "PaperLine" / "阅读线" / app.note_name(state["lines"][0])).is_file())
            before = {path: path.read_bytes() for path in (vault / "PaperLine").rglob("*") if path.is_file()}
            for name in ("CON.md", "LPT1.md", "bad:name.md", "folder\\file.md", "trailing.md "):
                state["lines"][0]["fileName"] = name
                with self.subTest(name=name), self.assertRaises(ValueError):
                    app.export_obsidian(state)
                self.assertEqual(before, {path: path.read_bytes() for path in (vault / "PaperLine").rglob("*") if path.is_file()})

    def test_lifecycle_starts_and_flushes_sync(self):
        output = io.StringIO()
        with patch.object(app.SYNC, "start") as start, patch.object(app.SYNC, "stop") as stop:
            desktop_backend.serve(Path("/tmp/test"), io.StringIO(""), output)
            start.assert_called_once_with()
            stop.assert_called_once_with()
        self.assertEqual(json.loads(output.getvalue()), {"ready": True, "protocol": 1})


if __name__ == "__main__":
    unittest.main()
