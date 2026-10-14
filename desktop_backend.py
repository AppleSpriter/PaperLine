#!/usr/bin/env python3
"""PaperLine desktop sidecar: private JSON-lines IPC, with no HTTP listener."""

from __future__ import annotations

import argparse
import json
import signal
import sys
import tempfile
from pathlib import Path
from typing import Any, TextIO

import app

PROTOCOL = 1
MAX_REQUEST_BYTES = 20_000_000


def configure_data_dir(directory: str) -> Path:
    data_dir = Path(directory).expanduser().resolve()
    # Installed resources are immutable. Desktop state must survive app upgrades.
    if data_dir == app.ROOT or app.ROOT in data_dir.parents:
        raise ValueError("桌面数据目录必须位于应用资源目录之外。")
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryFile(dir=data_dir):
        pass
    app.DATA_FILE = data_dir / "state.json"
    app.BACKUP_FILE = data_dir / "state.backup.json"
    app.WEBDAV_FILE = data_dir / "webdav.json"
    app._RECOMMENDATION_CACHE = None
    with app.LOCK:
        app.load_state()  # Fail before readiness if existing data cannot be read.
    return data_dir


def respond(request: Any, data_dir: Path) -> tuple[dict[str, Any], bool]:
    request_id = request.get("id") if isinstance(request, dict) else None
    try:
        if not isinstance(request, dict):
            raise ValueError("请求内容无效。")
        if not isinstance(request_id, (str, int)) or isinstance(request_id, bool):
            raise ValueError("请求编号无效。")
        method, path = request.get("method"), request.get("path")
        if method not in ("GET", "POST") or not isinstance(path, str) or not path.startswith("/api/"):
            raise ValueError("请求方法或路径无效。")
        body = request.get("body", {})
        if not isinstance(body, dict):
            raise ValueError("请求内容无效。")
        if method == "GET" and path == "/api/desktop/info":
            status, data = 200, {"dataDir": str(data_dir), "protocol": PROTOCOL}
        elif method == "POST" and path == "/api/desktop/shutdown":
            return {"id": request_id, "status": 200, "data": {"ok": True}}, True
        else:
            status, data = app.api_request(method, path, body)
    except app.SyncConflict as error:
        status, data = 409, {"error": str(error), "conflict": True}
    except ValueError as error:
        status, data = 400, {"error": str(error)}
    except ConnectionError as error:
        status, data = 503, {"error": str(error)}
    except Exception as error:
        # Never put request bodies, credentials, or exception details in diagnostics.
        print(f"PaperLine backend request failed ({type(error).__name__})", file=sys.stderr, flush=True)
        status, data = 500, {"error": "本地操作失败，请重试或检查数据目录。"}
    return {"id": request_id, "status": status, "data": data}, False


def write_response(output: TextIO, value: Any) -> None:
    output.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    output.flush()


def serve(data_dir: Path, source: TextIO, output: TextIO) -> None:
    app.SYNC.start()
    try:
        write_response(output, {"ready": True, "protocol": PROTOCOL})
        while True:
            line = source.readline(MAX_REQUEST_BYTES + 1)
            if not line:
                break
            try:
                if len(line.encode("utf-8")) > MAX_REQUEST_BYTES:
                    if not line.endswith("\n"):
                        while True:
                            remainder = source.readline(MAX_REQUEST_BYTES + 1)
                            if not remainder or remainder.endswith("\n"):
                                break
                    raise ValueError("请求内容过大。")
                request = json.loads(line)
            except ValueError:
                write_response(output, {"id": None, "status": 400, "data": {"error": "请求 JSON 无效或内容过大。"}})
                continue
            response, shutdown = respond(request, data_dir)
            write_response(output, response)
            if shutdown:
                break
    finally:
        app.SYNC.stop()  # Existing bounded final upload; daemon workers cannot outlive process.


def main() -> int:
    # Pipe encoding on Windows otherwise follows the active ANSI code page.
    # Rust sends UTF-8 bytes, so make the protocol independent of locale.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if callable(getattr(stream, "reconfigure", None)):
            stream.reconfigure(encoding="utf-8", errors="strict")
    parser = argparse.ArgumentParser(description="PaperLine desktop backend")
    parser.add_argument("--data-dir", required=True)
    args = parser.parse_args()
    try:
        data_dir = configure_data_dir(args.data_dir)
    except (OSError, ValueError) as error:
        print(f"PaperLine backend startup failed: {error}", file=sys.stderr, flush=True)
        return 1

    def stop_on_term(*_: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_on_term)
    try:
        serve(data_dir, sys.stdin, sys.stdout)
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
