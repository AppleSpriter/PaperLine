"""Check launcher behavior around existing services and safe shutdown."""

import contextlib
import io
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import launcher


class LauncherTests(unittest.TestCase):
    @contextlib.contextmanager
    def local_page(self, title):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = f"<html><title>{title}</title></html>".encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_port
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_existing_paperline_opens_without_starting_another_process(self):
        with self.local_page("读线 · PaperLine") as port:
            with mock.patch.object(launcher.webbrowser, "open") as open_page, mock.patch.object(launcher.subprocess, "Popen") as spawn:
                self.assertEqual(launcher.start_background(port, no_browser=False), 0)
                open_page.assert_called_once_with(launcher.url(port), new=2)
                spawn.assert_not_called()

    def test_unrelated_service_on_port_is_not_opened_or_replaced(self):
        with self.local_page("Another app") as port:
            with mock.patch.object(launcher.webbrowser, "open") as open_page, mock.patch.object(launcher.subprocess, "Popen") as spawn:
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(launcher.start_background(port, no_browser=True), 1)
                open_page.assert_not_called()
                spawn.assert_not_called()

    def test_stop_refuses_a_pid_that_does_not_belong_to_paperline(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.object(launcher, "DATA_DIR", Path(temp_dir)):
                pid_file, _ = launcher.files(8765)
                pid_file.write_text("12345", encoding="utf-8")
                with mock.patch.object(launcher, "is_paperline_running", return_value=True), \
                     mock.patch.object(launcher.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="python other_app.py")), \
                     mock.patch.object(launcher.os, "kill") as kill:
                    with contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(launcher.stop_background(8765), 1)
                    kill.assert_not_called()
                    self.assertTrue(pid_file.exists())


if __name__ == "__main__":
    unittest.main()
