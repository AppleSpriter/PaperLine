#!/usr/bin/env python3
"""Exercise an installed sidecar's v1 migration and data retention using fixtures only."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def exchange(command: list[str], directory: Path, method: str, path: str, body=None):
    requests = [
        {"id": 1, "method": method, "path": path, "body": body or {}},
        {"id": 2, "method": "POST", "path": "/api/desktop/shutdown", "body": {}},
    ]
    result = subprocess.run(
        [*command, "--data-dir", str(directory)],
        input="".join(json.dumps(item, ensure_ascii=False) + "\n" for item in requests),
        text=True, encoding="utf-8", capture_output=True, timeout=45,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    assert result.returncode == 0, f"Installed sidecar failed ({result.returncode})"
    replies = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(replies) == 3 and replies[0] == {"ready": True, "protocol": 1}, replies
    assert replies[1]["id"] == 1 and replies[1]["status"] == 200, replies[1]
    assert replies[2] == {"id": 2, "status": 200, "data": {"ok": True}}, replies[2]
    return replies[1]["data"]


def hashes(directory: Path) -> dict[str, str]:
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(directory.iterdir()) if path.is_file()}


def seed_legacy(directory: Path) -> None:
    if not directory.is_dir() or any(directory.iterdir()):
        raise ValueError("Migration fixture must be an existing empty directory")
    sys.path.insert(0, str(ROOT))
    import app
    legacy = app.default_state()
    line = app.apply_action(legacy, "line.create", {"title": "旧阅读线 Synthetic"})["lineId"]
    idea = app.apply_action(legacy, "idea.create", {"title": "旧手写方法", "lineId": line,
        "thoughts": "手写思考 must survive"})["ideaId"]
    app.apply_action(legacy, "session.create", {"lineId": line, "ideaId": idea, "note": "旧阅读记录"})
    paper = app.apply_action(legacy, "paper.create", {"title": "Synthetic paper 中文"})["paperId"]
    legacy["version"] = 1
    legacy.pop("stages")
    for item in legacy["lines"]:
        for key in ("kind", "stageIds", "activeStageId"):
            item.pop(key)
    for item in legacy["ideas"]:
        item.pop("entityType")
    for record in legacy["sessions"]:
        for key in ("targetType", "targetId", "targetSnapshot"):
            record.pop(key)
    original = json.dumps(legacy, ensure_ascii=False).encode("utf-8")
    (directory / "state.json").write_bytes(original)


def seed(command: list[str], directory: Path, manifest: Path) -> None:
    if not (directory / "state.json").exists():
        seed_legacy(directory)
    original = (directory / "state.json").read_bytes()
    legacy = json.loads(original)
    assert legacy["version"] == 1 and legacy["ideas"][0]["thoughts"] == "手写思考 must survive"
    paper = legacy["papers"][0]["id"]
    migrated = exchange(command, directory, "GET", "/api/state")
    assert migrated["version"] == 2 and migrated["stages"] == []
    assert migrated["ideas"][0]["thoughts"] == "手写思考 must survive"
    assert migrated["sessions"][0]["note"] == "旧阅读记录"
    assert (directory / "state.json").read_bytes() == original

    def action(name, **payload):
        return exchange(command, directory, "POST", "/api/action", {"action": name, "payload": payload})

    stage = action("paper.add_to_stage", paperId=paper, lineTitle="模型演进 Synthetic",
                   stageTitle="R1 中文", summary="手写阶段贡献", date="2026-10-18")["result"]
    method = action("paper.annotate_method", paperId=paper, stageId=stage["stageId"],
                    title="手工 GRPO", relation="proposes", note="手写方法证据")["result"]
    action("idea.update", id=method["ideaId"], mechanism="手写机制", thoughts="手写想法")
    saved = action("session.create", targetType="stage", targetId=stage["stageId"],
                   lineId=stage["lineId"], note="阶段阅读记录", durationSeconds=123)["state"]
    assert saved["stages"][0]["summary"] == "手写阶段贡献"
    membership = next(item for item in saved["edges"] if item["id"] == stage["edgeId"])
    assert membership["contributionRefs"] == [method["edgeId"]]
    assert (directory / "state.json").read_bytes() == original
    # Disabled credentials must also survive reinstall/uninstall and never enter artifacts.
    exchange(command, directory, "POST", "/api/webdav/config", {
        "url": "https://example.invalid/dav", "username": "fixture", "password": "synthetic-only",
        "folder": "PaperLine", "enabled": False,
    })
    manifest.write_text(json.dumps({"hashes": hashes(directory), "state": saved}, ensure_ascii=False), encoding="utf-8")
    verify(command, directory, manifest)
    print("Installed helper passed read-only legacy migration, manual method/stage, and reading history checks.")


def verify(command: list[str] | None, directory: Path, manifest: Path) -> None:
    expected = json.loads(manifest.read_text(encoding="utf-8"))
    assert hashes(directory) == expected["hashes"], "Installer changed synthetic application data"
    if command is not None:
        state = exchange(command, directory, "GET", "/api/state")
        assert state == expected["state"], "Installed helper changed migrated notes or references"
        assert hashes(directory) == expected["hashes"], "Read-only restart rewrote persisted data"
    print("Synthetic state, legacy, backup, and disabled credentials retained byte-for-byte.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["seed-legacy", "seed", "verify", "files-only"])
    parser.add_argument("--helper", type=Path)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    args = parser.parse_args()
    command = [str(args.helper.resolve())] if args.helper else None
    if args.operation != "files-only" and command is None:
        parser.error("--helper is required")
    if args.operation != "seed-legacy" and args.manifest is None:
        parser.error("--manifest is required")
    if args.operation == "seed-legacy":
        seed_legacy(args.data_dir.resolve())
        old = exchange(command, args.data_dir.resolve(), "GET", "/api/state")
        assert old["version"] == 1 and old["ideas"][0]["thoughts"] == "手写思考 must survive"
        print("Published legacy helper loaded the synthetic v1 reading notes.")
    elif args.operation == "seed":
        seed(command, args.data_dir.resolve(), args.manifest.resolve())
    else:
        verify(command if args.operation == "verify" else None, args.data_dir.resolve(), args.manifest.resolve())


if __name__ == "__main__":
    main()
