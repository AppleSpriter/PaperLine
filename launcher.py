#!/usr/bin/env python3
"""Open PaperLine from a macOS launcher without starting duplicate servers."""

from __future__ import annotations

import argparse
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
APP = ROOT / "app.py"
DEFAULT_PORT = 8765
LOG_LIMIT = 512 * 1024


def url(port: int) -> str:
    return f"http://127.0.0.1:{port}/"


def is_paperline_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(url(port), timeout=0.5) as response:
            return response.status == 200 and "<title>读线 · PaperLine</title>".encode("utf-8") in response.read(2048)
    except (OSError, urllib.error.URLError):
        return False


def port_in_use(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def files(port: int) -> tuple[Path, Path]:
    return DATA_DIR / f"launcher-{port}.pid", DATA_DIR / f"launcher-{port}.log"


def rotate_log(log_file: Path) -> None:
    """日志超过上限就保留一份旧档，避免无限增长。"""
    try:
        if log_file.exists() and log_file.stat().st_size > LOG_LIMIT:
            log_file.replace(log_file.with_name(log_file.name + ".1"))
    except OSError:
        pass


def open_page(port: int, no_browser: bool) -> None:
    if not no_browser:
        webbrowser.open(url(port), new=2)


def report_error(message: str, no_browser: bool) -> int:
    print(message, file=sys.stderr)
    if sys.platform == "darwin" and not no_browser:
        script = 'on run argv\n display alert "PaperLine 无法启动" message (item 1 of argv)\nend run'
        subprocess.run(["osascript", "-e", script, "--", message], check=False)
    return 1


def start_background(port: int, no_browser: bool) -> int:
    if is_paperline_running(port):
        open_page(port, no_browser)
        print(f"PaperLine 已在运行：{url(port)}")
        return 0
    if port_in_use(port):
        return report_error(f"端口 {port} 已被其他程序占用，PaperLine 无法启动。", no_browser)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    pid_file, log_file = files(port)
    rotate_log(log_file)
    with log_file.open("a", encoding="utf-8") as log:
        log.write(f"\n--- 启动 PaperLine：{time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
        log.flush()
        process = subprocess.Popen(
            [sys.executable, str(APP), "--no-browser", "--port", str(port)],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    pid_file.write_text(str(process.pid), encoding="utf-8")

    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if is_paperline_running(port):
            open_page(port, no_browser)
            print(f"PaperLine 已启动：{url(port)}")
            return 0
        if process.poll() is not None:
            break
        time.sleep(0.1)
    pid_file.unlink(missing_ok=True)
    return report_error(f"PaperLine 启动失败，请查看日志：{log_file}", no_browser)


def start_foreground(port: int, no_browser: bool) -> int:
    if is_paperline_running(port):
        open_page(port, no_browser)
        print(f"PaperLine 已在运行：{url(port)}")
        return 0
    if port_in_use(port):
        return report_error(f"端口 {port} 已被其他程序占用，PaperLine 无法启动。", no_browser)
    argv = [sys.executable, str(APP), "--port", str(port)]
    if no_browser:
        argv.append("--no-browser")
    os.execv(sys.executable, argv)
    return 1


def stop_background(port: int) -> int:
    pid_file, _ = files(port)
    if not pid_file.exists():
        print("未找到由启动器开启的 PaperLine 服务。")
        return 0
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
    except ValueError:
        print("启动记录无效；未结束任何进程。", file=sys.stderr)
        return 1
    if not is_paperline_running(port):
        pid_file.unlink(missing_ok=True)
        print("PaperLine 已停止。")
        return 0
    result = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, check=False)
    if result.returncode or str(APP) not in result.stdout or f"--port {port}" not in result.stdout:
        print("启动记录与运行中的进程不匹配；未结束任何进程。", file=sys.stderr)
        return 1
    os.kill(pid, signal.SIGTERM)
    for _ in range(30):
        if not is_paperline_running(port):
            pid_file.unlink(missing_ok=True)
            print("PaperLine 已停止。")
            return 0
        time.sleep(0.1)
    print("已请求停止 PaperLine，但服务仍在响应。", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="启动或停止 PaperLine")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--foreground", action="store_true")
    parser.add_argument("--stop", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口需在 1 到 65535 之间。")
    if args.stop:
        return stop_background(args.port)
    if args.foreground:
        return start_foreground(args.port, args.no_browser)
    return start_background(args.port, args.no_browser)


if __name__ == "__main__":
    raise SystemExit(main())
