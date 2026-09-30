import base64
import json
import os
import stat
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import app


class FakeDav:
    """最小可用的 WebDAV 服务：PROPFIND / MKCOL / PUT + Basic 认证。"""

    def __init__(self, username="reader", password="secret"):
        self.files: dict[str, bytes] = {}
        self.folders: set[str] = {"/dav/"}
        self.auth = "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()
        self.fail_put = False
        dav = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _reply(self, code):
                self.send_response(code)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def _authorized(self):
                if self.headers.get("Authorization") != dav.auth:
                    self._reply(401)
                    return False
                return True

            def do_GET(self):
                if not self._authorized():
                    return
                body = dav.files.get(self.path)
                if body is None:
                    self._reply(404)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Last-Modified", "Tue, 29 Sep 2026 00:00:00 GMT")
                self.end_headers()
                self.wfile.write(body)

            def do_PROPFIND(self):
                if self._authorized():
                    self._reply(207 if self.path in dav.folders else 404)

            def do_MKCOL(self):
                if not self._authorized():
                    return
                if self.path in dav.folders:
                    self._reply(405)
                    return
                parent = self.path.rstrip("/").rsplit("/", 1)[0] + "/"
                if parent not in dav.folders:
                    self._reply(409)
                    return
                dav.folders.add(self.path)
                self._reply(201)

            def do_PUT(self):
                if not self._authorized():
                    return
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                parent = self.path.rsplit("/", 1)[0] + "/"
                if dav.fail_put:
                    self._reply(507)
                elif parent not in dav.folders:
                    self._reply(409)
                else:
                    dav.files[self.path] = body
                    self._reply(201)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/dav/"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class WebDavTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        root = Path(self.folder.name)
        self.patches = [
            patch.object(app, "DATA_FILE", root / "state.json"),
            patch.object(app, "BACKUP_FILE", root / "state.backup.json"),
            patch.object(app, "WEBDAV_FILE", root / "webdav.json"),
        ]
        for item in self.patches:
            item.start()
        self.dav = FakeDav()

    def tearDown(self):
        self.dav.close()
        for item in self.patches:
            item.stop()
        self.folder.cleanup()

    def config(self, **overrides):
        payload = {"enabled": True, "url": self.dav.url, "username": "reader", "password": "secret", "folder": "PaperLine"}
        payload.update(overrides)
        return app.clean_webdav(payload, app.default_webdav())

    def test_settings_validation_and_password_reuse(self):
        with self.assertRaisesRegex(ValueError, "https:// 或 http://"):
            app.clean_webdav({"url": "ftp://example.com/"}, app.default_webdav())
        with self.assertRaisesRegex(ValueError, "不要写进地址"):
            app.clean_webdav({"url": "https://u:p@example.com/dav/"}, app.default_webdav())
        with self.assertRaisesRegex(ValueError, "文件夹名称无效"):
            app.clean_webdav({"url": "https://example.com/", "folder": "a/../b"}, app.default_webdav())
        saved = self.config()
        self.assertTrue(saved["url"].endswith("/"))
        same = app.clean_webdav({"url": self.dav.url, "username": "reader", "password": "", "enabled": True}, saved)
        self.assertEqual(same["password"], "secret")
        moved = app.clean_webdav({"url": "https://elsewhere.example/dav/", "username": "reader", "password": ""}, saved)
        self.assertEqual(moved["password"], "")
        self.assertEqual(app.clean_webdav({"url": ""}, saved), app.default_webdav())

    def test_credentials_stay_private_on_disk_and_in_responses(self):
        app.save_webdav(self.config())
        mode = stat.S_IMODE(os.stat(app.WEBDAV_FILE).st_mode)
        self.assertEqual(mode, 0o600)
        public = app.public_webdav()
        self.assertNotIn("password", public)
        self.assertTrue(public["hasPassword"])
        self.assertTrue(public["insecure"])
        app.save_state(app.default_state())
        self.assertNotIn("secret", app.DATA_FILE.read_text(encoding="utf-8"))

    def test_check_and_upload_create_folders_and_a_daily_copy(self):
        config = self.config(folder="Notes/PaperLine")
        app.webdav_check(config)
        self.assertIn("/dav/Notes/PaperLine/", self.dav.folders)
        body = b'{"version": 1}\n'
        from datetime import datetime
        app.webdav_upload(config, body, datetime(2026, 9, 30, 10, 0))
        self.assertEqual(self.dav.files["/dav/Notes/PaperLine/state.json"], body)
        self.assertEqual(self.dav.files["/dav/Notes/PaperLine/history/state-2026-09-30.json"], body)

    def test_wrong_password_and_unreachable_server_explain_themselves(self):
        with self.assertRaisesRegex(ConnectionError, "拒绝了访问"):
            app.webdav_check(self.config(password="wrong"))
        with self.assertRaisesRegex(ConnectionError, "连不上"):
            app.webdav_check(self.config(url="http://127.0.0.1:9/dav/"))

    def test_changes_upload_after_the_interval_and_failures_retry(self):
        app.save_webdav(self.config())
        state = app.default_state()
        app.apply_action(state, "line.create", {"title": "云端阅读线"})
        app.save_state(state)
        sync = app.WebDavSync(interval=0.05)
        sync.start()
        try:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and not sync.status()["lastSuccessAt"]:
                time.sleep(0.02)
            uploaded = json.loads(self.dav.files["/dav/PaperLine/state.json"])
            self.assertEqual(uploaded["lines"][0]["title"], "云端阅读线")

            self.dav.fail_put = True
            with self.assertRaisesRegex(ConnectionError, "空间不足"):
                sync.sync_now()
            status = sync.status()
            self.assertIn("空间不足", status["lastError"])
            self.assertTrue(status["pending"])
            self.assertGreater(sync.retry_at, time.monotonic())

            self.dav.fail_put = False
            sync.sync_now()
            self.assertEqual(sync.status()["lastError"], "")
            self.assertFalse(sync.status()["pending"])
        finally:
            sync.stop(flush=False)

    def test_disabled_sync_ignores_changes(self):
        app.save_webdav(self.config(enabled=False))
        sync = app.WebDavSync(interval=0.01)
        sync.mark_dirty()
        self.assertFalse(sync.status()["pending"])


    def test_further_changes_do_not_postpone_the_next_upload(self):
        self.assertEqual(app.WEBDAV_INTERVAL_SECONDS, 300)
        app.save_webdav(self.config())
        sync = app.WebDavSync()
        sync.mark_dirty()
        first = sync.dirty_at
        time.sleep(0.02)
        sync.mark_dirty()
        self.assertEqual(sync.dirty_at, first)
        self.assertGreater(sync.status()["nextUploadIn"], 290)

    def put_cloud(self, data):
        self.dav.folders.update({"/dav/PaperLine/", "/dav/PaperLine/history/"})
        self.dav.files["/dav/PaperLine/state.json"] = json.dumps(data, ensure_ascii=False).encode("utf-8")

    def saved_state(self, title, saved_at):
        state = app.default_state()
        app.apply_action(state, "line.create", {"title": title})
        state["savedAt"] = saved_at
        return state

    def test_compare_reports_which_side_is_newer(self):
        app.save_webdav(self.config())
        app.save_state(self.saved_state("本机", "2026-09-30T02:00:00.000+00:00"), stamp=False)
        self.assertEqual(app.compare_with_cloud()["cloud"], None)
        self.assertEqual(app.compare_with_cloud()["newer"], "local")
        self.put_cloud(self.saved_state("云端", "2026-09-30T03:00:00.000+00:00"))
        info = app.compare_with_cloud()
        self.assertEqual(info["newer"], "cloud")
        self.assertEqual(info["cloud"]["counts"]["lines"], 1)
        self.put_cloud(self.saved_state("云端", "2026-09-30T01:00:00.000+00:00"))
        self.assertEqual(app.compare_with_cloud()["newer"], "local")
        same = app.load_state()
        same["savedAt"] = "2026-09-29T00:00:00.000+00:00"
        same["settings"] = {**same["settings"], "language": "en"}
        self.put_cloud(same)
        self.assertEqual(app.compare_with_cloud()["newer"], "same")

    def test_old_uploads_without_a_stamp_fall_back_to_last_modified(self):
        app.save_webdav(self.config())
        app.save_state(self.saved_state("本机", "2026-09-30T02:00:00.000+00:00"), stamp=False)
        cloud = self.saved_state("旧云端", "")
        del cloud["savedAt"]
        self.put_cloud(cloud)
        info = app.compare_with_cloud()
        self.assertTrue(info["cloud"]["savedAt"].startswith("2026-09-29T00:00:00"))
        self.assertEqual(info["newer"], "local")

    def test_restore_from_cloud_keeps_a_local_copy_and_matches_times(self):
        app.save_webdav(self.config())
        local = self.saved_state("本机", "2026-09-30T02:00:00.000+00:00")
        local["settings"]["language"] = "en"
        app.save_state(local, stamp=False)
        cloud = self.saved_state("云端", "2026-09-30T03:00:00.000+00:00")
        self.put_cloud(cloud)
        with self.assertRaisesRegex(ValueError, "刚刚有更新"):
            app.restore_from_cloud("2026-09-30T00:00:00.000+00:00")
        result = app.restore_from_cloud("2026-09-30T03:00:00.000+00:00")
        restored = app.load_state()
        self.assertEqual([line["title"] for line in restored["lines"]], ["云端"])
        self.assertEqual(restored["savedAt"], "2026-09-30T03:00:00.000+00:00")
        self.assertEqual(restored["settings"]["language"], "en")
        self.assertTrue(result["kept"].startswith("state.before-cloud-restore-"))
        kept = json.loads((app.DATA_FILE.parent / result["kept"]).read_text(encoding="utf-8"))
        self.assertEqual(kept["lines"][0]["title"], "本机")
        self.assertEqual(app.compare_with_cloud()["newer"], "same")

        self.dav.files["/dav/PaperLine/state.json"] = b"not json"
        with self.assertRaisesRegex(ValueError, "不是有效的"):
            app.restore_from_cloud("")
        del self.dav.files["/dav/PaperLine/state.json"]
        with self.assertRaisesRegex(ValueError, "还没有"):
            app.restore_from_cloud("")

    def test_upload_pauses_when_the_cloud_is_newer_until_forced(self):
        app.save_webdav(self.config())
        app.save_state(self.saved_state("本机", "2026-09-30T02:00:00.000+00:00"), stamp=False)
        cloud = self.saved_state("另一台电脑", "2026-09-30T03:00:00.000+00:00")
        self.put_cloud(cloud)
        sync = app.WebDavSync(interval=0.01)
        with self.assertRaises(app.SyncConflict):
            sync.sync_now()
        status = sync.status()
        self.assertTrue(status["conflict"])
        self.assertIsNone(status["nextUploadIn"])
        self.assertEqual(json.loads(self.dav.files["/dav/PaperLine/state.json"])["lines"][0]["title"], "另一台电脑")

        sync.sync_now(force=True)
        self.assertFalse(sync.status()["conflict"])
        self.assertEqual(json.loads(self.dav.files["/dav/PaperLine/state.json"])["lines"][0]["title"], "本机")
        overwritten = [name for name in self.dav.files if "/history/state-overwritten-" in name]
        self.assertEqual(len(overwritten), 1)
        self.assertEqual(json.loads(self.dav.files[overwritten[0]])["lines"][0]["title"], "另一台电脑")

    def test_every_save_records_when_it_happened(self):
        state = app.default_state()
        app.save_state(state)
        first = app.load_state()["savedAt"]
        time.sleep(0.005)
        app.save_state(app.load_state())
        self.assertGreater(app.parse_stamp(app.load_state()["savedAt"]), app.parse_stamp(first))

if __name__ == "__main__":
    unittest.main()
