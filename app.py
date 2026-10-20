#!/usr/bin/env python3
"""PaperLine: a small local reading-line app for Zotero and Obsidian."""

from __future__ import annotations

import argparse
import base64
import copy
import email.utils
import json
import os
import re
import secrets
import shutil
import signal
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PureWindowsPath
from typing import Any

import learning

from paper_map import ARXIV, RECOMMENDATIONS_VERSION, collect_snapshot, doi_key, reference_recommendations


ROOT = Path(__file__).resolve().parent
LEGACY_DATA_FILE = ROOT / "data" / "state.json"
DATA_FILE = ROOT / "data" / "state-v2.json"
BACKUP_FILE = ROOT / "data" / "state-v2.backup.json"
# WebDAV 账号单独存放：不进 state.json、不进备份下载、不返回给浏览器。
WEBDAV_FILE = ROOT / "data" / "webdav.json"
WEBDAV_INTERVAL_SECONDS = 300  # 有改动时每 5 分钟最多上传一次
WEBDAV_TIMEOUT = 15
STATIC = {
    "/": (ROOT / "static" / "index.html", "text/html; charset=utf-8"),
    "/i18n.js": (ROOT / "static" / "i18n.js", "text/javascript; charset=utf-8"),
    "/app.js": (ROOT / "static" / "app.js", "text/javascript; charset=utf-8"),
    "/desktop.js": (ROOT / "static" / "desktop.js", "text/javascript; charset=utf-8"),
    "/style.css": (ROOT / "static" / "style.css", "text/css; charset=utf-8"),
}
LOCK = threading.RLock()
_RECOMMENDATION_CACHE: tuple[Any, list[dict[str, Any]]] | None = None
ZOTERO_BASE = "http://127.0.0.1:23119/api/users/0"
IDEA_KINDS = {"concept", "innovation", "question"}
IDEA_STATUSES = {"inbox", "learning", "understood"}
PAPER_RELATIONS = {"proposes", "uses", "improves", "questions"}
IDEA_RELATIONS = {"extends", "depends", "compares", "improves"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def stamp_now() -> str:
    # 毫秒精度：用来比较本机和云端哪份数据更新。
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def fresh_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


def default_state() -> dict[str, Any]:
    return {
        "version": 2,
        "stages": [],
        "settings": {"vaultPath": "", "reminderTime": "", "language": "zh"},
        "lines": [],
        "ideas": [],
        "papers": [],
        "citations": [],
        "recommendations": [],
        "recommendationsVersion": RECOMMENDATIONS_VERSION,
        "zoteroSync": {},
        "edges": [],
        "sessions": [],
    }


class StateCorruptionError(ValueError):
    """The current v2 file cannot be decoded or fails its known schema."""


def load_state() -> dict[str, Any]:
    source = DATA_FILE
    migrating = False
    if not source.exists():
        # Keep tests/custom data directories isolated from the default live legacy file.
        legacy_file = LEGACY_DATA_FILE if LEGACY_DATA_FILE.parent == DATA_FILE.parent else DATA_FILE.parent / "state.json"
        if legacy_file != DATA_FILE and legacy_file.exists():
            source, migrating = legacy_file, True
        else:
            return default_state()
    try:
        with source.open("r", encoding="utf-8") as handle:
            raw = json.load(handle)
            stat = os.fstat(handle.fileno())
            cache_key = (str(source), stat.st_ino, stat.st_mtime_ns, stat.st_size)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        error_type = ValueError if migrating else StateCorruptionError
        raise error_type(f"数据文件已损坏，未修改任何内容；上一份备份：{BACKUP_FILE}") from error
    if (not isinstance(raw, dict) or type(raw.get("version")) is not int
            or raw.get("version") != (1 if migrating else 2)):
        raise ValueError("数据版本不受支持，未修改任何内容。")
    try:
        state = validate_backup(raw)
    except ValueError as error:
        if migrating:
            raise
        raise StateCorruptionError(f"数据文件内容已损坏，未修改任何内容；上一份备份：{BACKUP_FILE}") from error
    state.setdefault("citations", [])
    state.setdefault("recommendations", [])
    state.setdefault("zoteroSync", {})
    for paper in state["papers"]:
        paper.setdefault("readStatus", "unread")
    ensure_recommendations(state, cache_key)
    if migrating:
        # Preserve the source content timestamp, never make a migrated copy appear newer.
        if not state.get("savedAt"):
            state["savedAt"] = datetime.fromtimestamp(source.stat().st_mtime, timezone.utc).isoformat(timespec="milliseconds")
        state["_migration"] = {"fromVersion": 1, "pendingCloudConfirmation": True}
        save_state(state, stamp=False)
    return state


RESTORE_COLLECTIONS = ("lines", "ideas", "papers", "edges", "sessions", "stages")


def validate_backup(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] not in (1, 2):
        raise ValueError("这不是可以恢复的 PaperLine 备份文件。")
    data = learning.upgrade_v1(data) if data["version"] == 1 else copy.deepcopy(data)
    for key in RESTORE_COLLECTIONS:
        items = data.get(key)
        if not isinstance(items, list) or not all(isinstance(item, dict) and isinstance(item.get("id"), str) for item in items):
            raise ValueError("备份文件内容不完整，无法恢复。")
    if not isinstance(data.get("settings"), dict):
        raise ValueError("备份文件内容不完整，无法恢复。")
    ideas = {item["id"] for item in data["ideas"]}
    papers = {item["id"] for item in data["papers"]}
    stages = {item["id"] for item in data["stages"]}
    for line in data["lines"]:
        if (not isinstance(line.get("ideaIds"), list)
                or not all(isinstance(item, str) for item in line["ideaIds"])
                or not set(line["ideaIds"]) <= ideas):
            raise ValueError("备份文件里的阅读线引用了不存在的思想卡。")
    for edge in data["edges"]:
        source = papers if edge.get("fromType") == "paper" else ideas
        target_type = edge.get("toType", "idea")
        targets = stages if target_type == "stage" else ideas
        relations = {"documents"} if target_type == "stage" else PAPER_RELATIONS if edge.get("fromType") == "paper" else IDEA_RELATIONS
        if (not isinstance(edge.get("fromType"), str) or not isinstance(target_type, str)
                or not isinstance(edge.get("relation"), str)
                or edge.get("fromType") not in {"paper", "idea"} or target_type not in {"stage", "idea"}
                or edge.get("relation") not in relations
                or not isinstance(edge.get("fromId"), str) or not isinstance(edge.get("toId"), str)
                or edge["fromId"] not in source or edge["toId"] not in targets):
            raise ValueError("备份文件里有关系指向不存在的内容。")
    citations = data.get("citations", [])
    if not isinstance(citations, list) or any(
        not isinstance(edge, dict) or not isinstance(edge.get("id"), str)
        or not isinstance(edge.get("fromId"), str) or not isinstance(edge.get("toId"), str)
        or edge["fromId"] not in papers or edge["toId"] not in papers
        or edge["fromId"] == edge["toId"]
        or any(not isinstance(edge.get(name, ""), str) for name in ("evidence", "method", "attachmentKey"))
        for edge in citations
    ):
        raise ValueError("备份文件里的论文引用关系无效。")
    if "recommendationsVersion" in data and (type(data["recommendationsVersion"]) is not int
                                              or data["recommendationsVersion"] < 0):
        raise ValueError("备份文件里的推荐论文版本无效。")
    recommendations = data.get("recommendations", [])
    if not isinstance(recommendations, list):
        raise ValueError("备份文件里的推荐论文无效。")
    for item in recommendations:
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str)
                or any(not isinstance(item.get(name, ""), str) for name in ("title", "doi", "arxivId", "url", "referenceText"))
                or not isinstance(item.get("verification"), str)
                or item["verification"] not in {"library", "identifier", "identifier_only", "title", "raw"}
                or not isinstance(item.get("citingIds"), list)
                or not all(isinstance(value, str) and value in papers for value in item["citingIds"])
                or len(set(item["citingIds"])) != len(item["citingIds"])
                or type(item.get("citationCount")) is not int
                or item["citationCount"] != len(item["citingIds"])
                or (item.get("matchedPaperId") is not None and
                    (not isinstance(item["matchedPaperId"], str) or item["matchedPaperId"] not in papers))
                or not isinstance(item.get("evidence"), list)):
            raise ValueError("备份文件里的推荐论文无效。")
        for evidence in item["evidence"]:
            if (not isinstance(evidence, dict) or evidence.get("citingId") not in item["citingIds"]
                    or any(not isinstance(evidence.get(name, ""), str) for name in ("attachmentKey", "text"))):
                raise ValueError("备份文件里的推荐论文证据无效。")
    if any(paper.get("readStatus", "unread") not in ("read", "unread") for paper in data["papers"]):
        raise ValueError("备份文件里的论文阅读状态无效。")
    sync = data.get("zoteroSync", {})
    if (not isinstance(sync, dict)
            or ("syncedAt" in sync and not isinstance(sync["syncedAt"], str))
            or ("stats" in sync and not isinstance(sync["stats"], dict))):
        raise ValueError("备份文件里的 Zotero 同步信息无效。")
    learning.validate(data)
    return data


def restore_state(data: Any, keep_stamp: bool = False, label: str = "before-restore") -> dict[str, Any]:
    importing_v1 = isinstance(data, dict) and data.get("version") == 1
    backup = validate_backup(data)
    if importing_v1:
        backup["_migration"] = {"fromVersion": 1, "pendingCloudConfirmation": True}
    damaged = None
    try:
        current = load_state()
    except StateCorruptionError:
        damaged = DATA_FILE.read_bytes()
        current = default_state()
        if BACKUP_FILE.parent == DATA_FILE.parent and BACKUP_FILE.exists():
            try:
                previous = json.loads(BACKUP_FILE.read_text(encoding="utf-8"))
                if isinstance(previous, dict) and type(previous.get("version")) is int and previous["version"] == 2:
                    current = validate_backup(previous)
            except ValueError:
                pass  # Invalid last-good contents cannot supply device settings.
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    # 覆盖前单独留一份恢复前的数据，恢复错了还能退回去。
    keep = DATA_FILE.parent / f"state-v2.{label}-{stamp}-{secrets.token_hex(3)}.json"
    kept_bytes = damaged if damaged is not None else (json.dumps(current, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    with os.fdopen(os.open(keep, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as handle:
        handle.write(kept_bytes)
    # 设备相关的设置沿用本机，不从别的电脑的备份里带过来。
    backup["settings"] = {**default_state()["settings"], **current.get("settings", {})}
    ensure_recommendations(backup)
    save_state(backup, stamp=not keep_stamp, keep_previous=damaged is None)
    return {"kept": keep.name, "counts": {key: len(backup[key]) for key in RESTORE_COLLECTIONS}}


def save_state(state: dict[str, Any], stamp: bool = True, keep_previous: bool = True) -> None:
    if not isinstance(state, dict) or state.get("version") != 2:
        raise ValueError("只允许写入版本 2 数据；旧数据保持只读。")
    if stamp or not state.get("savedAt"):
        state["savedAt"] = stamp_now()
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    if keep_previous and DATA_FILE.exists():
        # 写入前留下上一份可用数据，文件损坏时还能找回来。
        shutil.copy2(DATA_FILE, BACKUP_FILE)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=DATA_FILE.parent, delete=False, prefix=".state-"
    ) as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temp_name = handle.name
    os.replace(temp_name, DATA_FILE)


def field(payload: dict[str, Any], name: str, limit: int = 5000, required: bool = False) -> str:
    value = payload.get(name, "")
    if not isinstance(value, str):
        raise ValueError(f"{name} 必须是文本。")
    value = value.strip()
    if required and not value:
        raise ValueError(f"请填写 {name}。")
    if len(value) > limit:
        raise ValueError(f"{name} 过长。")
    return value


def idea_aliases(payload: dict[str, Any]) -> list[str]:
    text = field(payload, "aliases", 1500)
    result = []
    seen = set()
    for alias in re.split(r"[,，;；\n]+", text):
        alias = alias.strip()
        key = unicodedata.normalize("NFKC", alias).casefold()
        if not alias or key in seen:
            continue
        if len(alias) > 120 or len(result) >= 12:
            raise ValueError("最多填写 12 个别名，每个不超过 120 字。")
        seen.add(key)
        result.append(alias)
    return result


def find(state: dict[str, Any], collection: str, item_id: str) -> dict[str, Any]:
    item = next((item for item in state[collection] if item["id"] == item_id), None)
    if item is None:
        raise ValueError("找不到对应内容，请刷新页面。")
    return item


def safe_url(value: str) -> str:
    if value and urllib.parse.urlparse(value).scheme not in {"https", "http", "zotero"}:
        raise ValueError("来源链接需以 https://、http:// 或 zotero:// 开头。")
    return value


def add_edge(
    state: dict[str, Any], from_type: str, from_id: str, to_id: str,
    relation: str, note: str = "", source_url: str = ""
) -> str:
    to_type = "idea"
    if from_type == "paper":
        find(state, "papers", from_id)
        if relation not in PAPER_RELATIONS:
            raise ValueError("论文关系类型无效。")
    elif from_type == "idea":
        find(state, "ideas", from_id)
        if from_id == to_id:
            raise ValueError("不能把思想卡连接到自己。")
        if relation not in IDEA_RELATIONS:
            raise ValueError("思想关系类型无效。")
    else:
        raise ValueError("连接起点无效。")
    find(state, "ideas", to_id)
    if any(
        edge["fromType"] == from_type and edge["fromId"] == from_id
        and edge["toId"] == to_id and edge["relation"] == relation
        for edge in state["edges"]
    ):
        raise ValueError("这条关系已经存在，可以在右侧编辑说明。")
    edge_id = fresh_id("e")
    state["edges"].append({
        "id": edge_id, "fromType": from_type, "fromId": from_id,
        "toType": to_type, "toId": to_id, "relation": relation,
        "note": note, "sourceUrl": safe_url(source_url), "createdAt": utc_now(),
    })
    return edge_id


def apply_action(state: dict[str, Any], action: str, payload: dict[str, Any]) -> dict[str, str]:
    if action in learning.ACTIONS:
        return learning.apply_action(state, action, payload, sys.modules[__name__])
    result: dict[str, str] = {}
    if action == "line.create":
        line_id = fresh_id("l")
        title = field(payload, "title", 120, True)
        kind = field(payload, "kind", 20) or "research"
        if kind not in {"research", "model_family"}:
            raise ValueError("阅读线类型无效。")
        state["lines"].append({
            "kind": kind, "stageIds": [], "activeStageId": "",
            "id": line_id, "title": title, "fileName": f"{slug(title)}-{line_id}.md",
            "question": field(payload, "question", 800), "ideaIds": [],
            "activeIdeaId": "", "createdAt": utc_now(), "updatedAt": utc_now(),
        })
        result["lineId"] = line_id
    elif action == "line.update":
        line = find(state, "lines", field(payload, "id", 40, True))
        if "title" in payload:
            line["title"] = field(payload, "title", 120, True)
        if "question" in payload:
            line["question"] = field(payload, "question", 800)
        if "kind" in payload:
            kind = field(payload, "kind", 20)
            if kind not in {"research", "model_family"}:
                raise ValueError("阅读线类型无效。")
            if kind == "research" and line["stageIds"]:
                raise ValueError("请先移出阶段，再改为研究线；共享阶段和论文不会删除。")
            line["kind"] = kind
        if "activeStageId" in payload:
            active_stage = field(payload, "activeStageId", 40)
            if active_stage and active_stage not in line["stageIds"]:
                raise ValueError("当前阶段不在这条阅读线中。")
            line["activeStageId"] = active_stage
        active = field(payload, "activeIdeaId", 40) if "activeIdeaId" in payload else line["activeIdeaId"]
        if active and active not in line["ideaIds"]:
            raise ValueError("下一张卡必须属于这条阅读线。")
        line["activeIdeaId"] = active
        line["updatedAt"] = utc_now()
        result["lineId"] = line["id"]
    elif action == "line.reorder":
        target_line = find(state, "lines", field(payload, "lineId", 40, True))
        offset = payload.get("offset")
        if type(offset) is not int or offset not in (-1, 1):
            raise ValueError("移动方向无效。")
        index = state["lines"].index(target_line)
        target = index + offset
        if 0 <= target < len(state["lines"]):
            state["lines"][index], state["lines"][target] = state["lines"][target], state["lines"][index]
        result["movedLineId"] = target_line["id"]
    elif action == "line.move":
        line = find(state, "lines", field(payload, "lineId", 40, True))
        idea_id = field(payload, "ideaId", 40, True)
        if idea_id not in line["ideaIds"]:
            raise ValueError("这张卡不在阅读线中。")
        step = payload.get("offset")
        if step not in (-1, 1):
            raise ValueError("移动方向无效。")
        index = line["ideaIds"].index(idea_id)
        target = index + step
        if 0 <= target < len(line["ideaIds"]):
            line["ideaIds"][index], line["ideaIds"][target] = line["ideaIds"][target], line["ideaIds"][index]
            line["updatedAt"] = utc_now()
        result["lineId"] = line["id"]
    elif action == "line.attach":
        line = find(state, "lines", field(payload, "lineId", 40, True))
        idea = find(state, "ideas", field(payload, "ideaId", 40, True))
        if idea["id"] not in line["ideaIds"]:
            line["ideaIds"].append(idea["id"])
        if not line["activeIdeaId"]:
            line["activeIdeaId"] = idea["id"]
        line["updatedAt"] = utc_now()
        result.update(lineId=line["id"], ideaId=idea["id"])
    elif action == "idea.create":
        kind = field(payload, "kind", 20) or "concept"
        if kind not in IDEA_KINDS:
            raise ValueError("思想卡类型无效。")
        entity_type = field(payload, "entityType", 20) or ("question" if kind == "question" else "unclassified")
        if entity_type not in learning.ENTITY_TYPES:
            raise ValueError("知识实体类型无效。")
        parent_id = field(payload, "fromIdeaId", 40)
        if parent_id:
            find(state, "ideas", parent_id)
        idea_id = fresh_id("i")
        title = field(payload, "title", 120, True)
        idea = {
            "id": idea_id, "title": title, "fileName": f"{slug(title)}-{idea_id}.md",
            "kind": kind, "entityType": entity_type, "summary": field(payload, "summary", 4000),
            "aliases": idea_aliases(payload),
            "mechanism": field(payload, "mechanism", 6000),
            "thoughts": field(payload, "thoughts", 6000), "status": "inbox",
            "createdAt": utc_now(), "updatedAt": utc_now(),
        }
        state["ideas"].append(idea)
        if parent_id:
            add_edge(state, "idea", parent_id, idea_id, "extends")
        line_id = field(payload, "lineId", 40)
        if line_id:
            line = find(state, "lines", line_id)
            line["ideaIds"].append(idea_id)
            if not line["activeIdeaId"]:
                line["activeIdeaId"] = idea_id
            line["updatedAt"] = utc_now()
            result["lineId"] = line_id
        paper_id = field(payload, "paperId", 40)
        if paper_id:
            add_edge(
                state, "paper", paper_id, idea_id,
                field(payload, "relation", 20) or "uses",
                field(payload, "sourceNote", 3000),
                field(payload, "sourceUrl", 1500),
            )
        result["ideaId"] = idea_id
    elif action == "idea.reuse":
        idea_id = field(payload, "id", 40, True)
        find(state, "ideas", idea_id)
        for from_type, key, default_relation in (("paper", "paperId", "uses"), ("idea", "fromIdeaId", "extends")):
            from_id = field(payload, key, 40)
            if not from_id:
                continue
            relation = (field(payload, "relation", 20) or default_relation) if from_type == "paper" else default_relation
            note = field(payload, "sourceNote", 3000) if from_type == "paper" else ""
            source_url = field(payload, "sourceUrl", 1500) if from_type == "paper" else ""
            exists = any(edge["fromType"] == from_type and edge["fromId"] == from_id and edge["toId"] == idea_id and edge["relation"] == relation for edge in state["edges"])
            if not exists or note or source_url:
                add_edge(state, from_type, from_id, idea_id, relation, note, source_url)
        line_id = field(payload, "lineId", 40)
        if line_id:
            apply_action(state, "line.attach", {"lineId": line_id, "ideaId": idea_id})
            result["lineId"] = line_id
        result["ideaId"] = idea_id
    elif action == "idea.update":
        idea = find(state, "ideas", field(payload, "id", 40, True))
        seen = field(payload, "baseUpdatedAt", 40)
        if seen and seen != idea.get("updatedAt", ""):
            raise ValueError("这张卡已在别的页面改过。刷新后再保存，你写的内容会作为草稿保留。")
        status = field(payload, "status", 20) if "status" in payload else idea["status"]
        kind = field(payload, "kind", 20) if "kind" in payload else idea["kind"]
        if "entityType" in payload:
            entity_type = field(payload, "entityType", 20)
            if entity_type not in learning.ENTITY_TYPES:
                raise ValueError("知识实体类型无效。")
            idea["entityType"] = entity_type
        if status not in IDEA_STATUSES or kind not in IDEA_KINDS:
            raise ValueError("卡片类型或状态无效。")
        for name, limit in (("title", 120), ("summary", 4000), ("mechanism", 6000), ("thoughts", 6000)):
            if name in payload:
                idea[name] = field(payload, name, limit, name == "title")
        idea["kind"] = kind
        idea["status"] = status
        if "aliases" in payload:
            idea["aliases"] = idea_aliases(payload)
        idea["updatedAt"] = utc_now()
        result["ideaId"] = idea["id"]
    elif action == "idea.mark":
        idea = find(state, "ideas", field(payload, "id", 40, True))
        kind = field(payload, "kind", 20)
        status = field(payload, "status", 20)
        if not kind and not status:
            raise ValueError("请选择要修改的类型或状态。")
        if kind:
            if kind not in IDEA_KINDS:
                raise ValueError("思想卡类型无效。")
            idea["kind"] = kind
        if status:
            if status not in IDEA_STATUSES:
                raise ValueError("思想卡状态无效。")
            idea["status"] = status
        idea["updatedAt"] = utc_now()
        result["ideaId"] = idea["id"]
    elif action == "idea.delete":
        idea_id = find(state, "ideas", field(payload, "id", 40, True))["id"]
        for line in state["lines"]:
            if idea_id not in line["ideaIds"]:
                continue
            line["ideaIds"] = [item for item in line["ideaIds"] if item != idea_id]
            if line["activeIdeaId"] == idea_id:
                line["activeIdeaId"] = line["ideaIds"][0] if line["ideaIds"] else ""
            line["updatedAt"] = utc_now()
        state["edges"] = [
            edge for edge in state["edges"]
            if edge["toId"] != idea_id and not (edge["fromType"] == "idea" and edge["fromId"] == idea_id)
        ]
        learning.retain_sessions(state, "idea", find(state, "ideas", idea_id))
        learning.clean_refs(state)
        state["ideas"] = [item for item in state["ideas"] if item["id"] != idea_id]
    elif action == "paper.delete":
        paper_id = find(state, "papers", field(payload, "id", 40, True))["id"]
        state["edges"] = [
            edge for edge in state["edges"]
            if not (edge["fromType"] == "paper" and edge["fromId"] == paper_id)
        ]
        learning.retain_sessions(state, "paper", find(state, "papers", paper_id))
        learning.clean_refs(state)
        state["papers"] = [item for item in state["papers"] if item["id"] != paper_id]
        state["citations"] = [
            edge for edge in state.get("citations", [])
            if paper_id not in {edge["fromId"], edge["toId"]}
        ]
        cleaned = []
        for item in state.get("recommendations", []):
            item["citingIds"] = [value for value in item["citingIds"] if value != paper_id]
            item["evidence"] = [value for value in item["evidence"] if value["citingId"] != paper_id]
            if item.get("matchedPaperId") == paper_id:
                item.pop("matchedPaperId", None)
            item["citationCount"] = len(set(item["citingIds"]))
            if item["citationCount"] >= 2:
                cleaned.append(item)
        state["recommendations"] = sorted(cleaned, key=lambda item: -item["citationCount"])
    elif action == "paper.add_to_line":
        paper = find(state, "papers", field(payload, "id", 40, True))
        line = find(state, "lines", field(payload, "lineId", 40, True))
        linked = {edge["toId"] for edge in state["edges"]
                  if edge["fromType"] == "paper" and edge["fromId"] == paper["id"]}
        idea_id = field(payload, "ideaId", 40)
        if idea_id:
            find(state, "ideas", idea_id)
            if idea_id not in linked:
                raise ValueError("请选择已关联这篇论文的思想卡。")
        else:
            idea_id = next((value for value in line["ideaIds"] if value in linked), "")
        if not idea_id:
            created = apply_action(state, "idea.create", {"title": paper["title"][:120],
                                   "paperId": paper["id"], "lineId": line["id"], "relation": "uses"})
            idea_id = created["ideaId"]
        else:
            apply_action(state, "line.attach", {"lineId": line["id"], "ideaId": idea_id})
        result.update(lineId=line["id"], ideaId=idea_id, paperId=paper["id"])
    elif action == "paper.mark":
        paper = find(state, "papers", field(payload, "id", 40, True))
        read_status = field(payload, "readStatus", 10, True)
        if read_status not in {"unread", "read"}:
            raise ValueError("论文阅读状态无效。")
        paper["readStatus"] = read_status
        paper["updatedAt"] = utc_now()
        result["paperId"] = paper["id"]
    elif action == "line.delete":
        line_id = find(state, "lines", field(payload, "id", 40, True))["id"]
        # 思想卡、论文和阅读记录都保留，只移除这条阅读线本身。
        state["lines"] = [item for item in state["lines"] if item["id"] != line_id]
    elif action == "paper.create":
        key = field(payload, "zoteroKey", 40)
        if key and not re.fullmatch(r"[A-Z0-9]{8}", key):
            raise ValueError("Zotero Key 格式无效。")
        existing = next((paper for paper in state["papers"] if key and paper.get("zoteroKey") == key), None)
        if existing:
            result["paperId"] = existing["id"]
        else:
            author_names = payload.get("authorNames", [])
            if (not isinstance(author_names, list) or not all(isinstance(name, str) for name in author_names)
                    or len(author_names) > 10000):
                raise ValueError("作者列表无效。")
            paper_id = fresh_id("p")
            title = field(payload, "title", 300, True)
            state["papers"].append({
                "id": paper_id, "title": title, "fileName": f"{slug(title)}-{paper_id}.md",
                "authors": field(payload, "authors", 20000),
                "authorNames": author_names, "authorCount": len(author_names),
                "institution": field(payload, "institution", 10000),
                "extra": field(payload, "extra", 20000),
                "year": field(payload, "year", 20), "doi": field(payload, "doi", 300),
                "zoteroKey": key,
                "readStatus": "unread",
                "zoteroUrl": f"zotero://select/library/items/{key}" if key else "",
                "createdAt": utc_now(), "updatedAt": utc_now(),
            })
            result["paperId"] = paper_id
    elif action == "edge.create":
        edge_id = add_edge(
            state, field(payload, "fromType", 20, True),
            field(payload, "fromId", 40, True), field(payload, "toId", 40, True),
            field(payload, "relation", 20, True), field(payload, "note", 3000),
            field(payload, "sourceUrl", 1500),
        )
        result["edgeId"] = edge_id
    elif action == "edge.update":
        edge = find(state, "edges", field(payload, "id", 40, True))
        if any(name in payload for name in ("fromId", "fromType", "toId", "toType")):
            raise ValueError("普通编辑不能修改关系端点。")
        if "relation" in payload:
            relation = field(payload, "relation", 20, True)
            valid = {"documents"} if edge.get("toType", "idea") == "stage" else PAPER_RELATIONS if edge["fromType"] == "paper" else IDEA_RELATIONS
            if relation not in valid:
                raise ValueError("关系类型无效。")
            if any(other["id"] != edge["id"] and all(other.get(key, "idea" if key == "toType" else None) ==
                    edge.get(key, "idea" if key == "toType" else None) for key in ("fromType", "fromId", "toType", "toId"))
                    and other["relation"] == relation for other in state["edges"]):
                raise ValueError("修改后将与已有关系重复；旧事实已保留。")
            edge["relation"] = relation
        for name, limit in (("note", 3000), ("sourceUrl", 1500)):
            if name in payload:
                value = field(payload, name, limit)
                edge[name] = safe_url(value) if name == "sourceUrl" else value
        if "contributionRefs" in payload:
            candidate = copy.deepcopy(state)
            find(candidate, "edges", edge["id"])["contributionRefs"] = payload["contributionRefs"]
            learning.validate(candidate)
            edge["contributionRefs"] = copy.deepcopy(payload["contributionRefs"])
        result["edgeId"] = edge["id"]
    elif action == "edge.delete":
        edge = find(state, "edges", field(payload, "id", 40, True))
        state["edges"] = [item for item in state["edges"] if item["id"] != edge["id"]]
        learning.clean_refs(state)
    elif action == "line.detach":
        target_line = find(state, "lines", field(payload, "lineId", 40, True))
        idea_id = field(payload, "ideaId", 40, True)
        if idea_id not in target_line["ideaIds"]:
            raise ValueError("这张卡不在阅读线中。")
        target_line["ideaIds"] = [item for item in target_line["ideaIds"] if item != idea_id]
        if target_line["activeIdeaId"] == idea_id:
            target_line["activeIdeaId"] = target_line["ideaIds"][0] if target_line["ideaIds"] else ""
        target_line["updatedAt"] = utc_now()
        result["lineId"] = target_line["id"]
    elif action == "settings.update":
        path = field(payload, "vaultPath", 1000)
        if path:
            vault = Path(path).expanduser().resolve()
            if not vault.is_dir() or not (vault / ".obsidian").is_dir():
                raise ValueError("请选择包含 .obsidian 文件夹的 Obsidian 库目录。")
            path = str(vault)
        reminder = field(payload, "reminderTime", 5)
        if reminder and not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", reminder):
            raise ValueError("提醒时间格式无效。")
        language = field(payload, "language", 2) or "zh"
        if language not in {"zh", "en"}:
            raise ValueError("界面语言无效。")
        state["settings"]["vaultPath"] = path
        state["settings"]["reminderTime"] = reminder
        state["settings"]["language"] = language
    else:
        raise ValueError("未知操作。")
    return result


def zotero_get(path: str, params: dict[str, str] | None = None) -> Any:
    url = ZOTERO_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Zotero-API-Version": "3"})
    try:
        with urllib.request.urlopen(request, timeout=4) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 403:
            raise ConnectionError("请在 Zotero 设置 → 高级中启用“允许本机其他应用与 Zotero 通信”。") from error
        raise ConnectionError(f"Zotero 返回错误 {error.code}。") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise ConnectionError("无法连接 Zotero。请先打开 Zotero，并启用本地 API。") from error


def zotero_search(query: str) -> list[dict[str, str]]:
    params = {"limit": "40", "sort": "dateModified", "direction": "desc"}
    if query:
        params["q"] = query[:150]
    items = zotero_get("/items/top", params)
    result = []
    for item in items:
        data = item.get("data", {})
        if data.get("itemType") in {"attachment", "note", "annotation"}:
            continue
        creators = data.get("creators", [])
        authors = []
        for creator in creators:
            name = creator.get("name") or " ".join(
                part for part in (creator.get("firstName"), creator.get("lastName")) if part
            )
            if name:
                authors.append(name)
        year_match = re.search(r"\b(?:19|20)\d{2}\b", data.get("date", ""))
        result.append({
            "title": data.get("title") or "未命名论文", "authors": ", ".join(authors),
            "authorNames": authors, "authorCount": len(authors),
            "year": year_match.group(0) if year_match else "",
            "doi": data.get("DOI", ""), "zoteroKey": item.get("key", ""),
            "extra": data.get("extra", ""), "institution": data.get("extra", ""),
        })
    return result


def map_recommendations(items: list[dict[str, Any]], by_key: dict[str, dict[str, Any]],
                        current_keys: set[str]) -> list[dict[str, Any]]:
    recommendations = []
    for item in items:
        citing_ids = list(dict.fromkeys(by_key[key]["id"] for key in item.get("citingKeys", [])
                                       if key in current_keys and key in by_key))
        if len(citing_ids) < 2:
            continue
        recommendation = {name: copy.deepcopy(item.get(name, "")) for name in
                          ("id", "title", "doi", "arxivId", "url", "referenceText", "verification")}
        recommendation.update(citingIds=citing_ids, citationCount=len(citing_ids), evidence=[])
        matched = by_key.get(item.get("matchedKey"))
        if matched and item.get("matchedKey") in current_keys:
            recommendation["matchedPaperId"] = matched["id"]
        for evidence in item.get("evidence", []):
            source = by_key.get(evidence.get("citingKey"))
            if source and source["id"] in citing_ids:
                recommendation["evidence"].append({"citingId": source["id"],
                     "attachmentKey": evidence.get("attachmentKey", ""), "text": evidence.get("text", "")})
        recommendations.append(recommendation)
    return sorted(recommendations, key=lambda item: (-item["citationCount"], item["id"]))


def rebuild_recommendations(state: dict[str, Any]) -> list[dict[str, Any]]:
    """Upgrade saved reference evidence without contacting Zotero or editing notes."""
    papers = []
    by_id = {}
    for saved in state["papers"]:
        if saved.get("zoteroMissing") or saved.get("sourceType", "paper") != "paper":
            continue
        key = saved.get("zoteroKey") or "local:" + saved["id"]
        identifiers = " ".join(str(saved.get(name) or "") for name in ("doi", "url", "extra"))
        analysis = saved.get("referenceAnalysis")
        attachments = analysis.get("attachments") if isinstance(analysis, dict) else None
        attachments = [item for item in attachments if isinstance(item, dict)
                       and isinstance(item.get("key"), str) and isinstance(item.get("referenceText", ""), str)] \
                      if isinstance(attachments, list) else []
        arxiv_ids = saved.get("arxivIds")
        arxiv_ids = [value for value in arxiv_ids if isinstance(value, str)] if isinstance(arxiv_ids, list) else []
        paper = {**saved, "zoteroKey": key, "title": str(saved.get("title") or ""),
                 "doi": doi_key(str(saved.get("doi") or "")) or doi_key(str(saved.get("url") or "")),
                 "arxivIds": sorted(set(arxiv_ids) |
                                    {match.group(1).casefold() for match in ARXIV.finditer(identifiers)}),
                 "referenceAnalysis": {"attachments": attachments}}
        papers.append(paper)
        by_id[saved["id"]] = paper
    citations = []
    for edge in state.get("citations", []):
        source, target = by_id.get(edge["fromId"]), by_id.get(edge["toId"])
        if source and target and source["id"] != target["id"]:
            citations.append({"fromKey": source["zoteroKey"], "toKey": target["zoteroKey"],
                              "attachmentKey": edge.get("attachmentKey", ""), "evidence": edge.get("evidence", "")})
    by_key = {paper["zoteroKey"]: paper for paper in papers}
    return map_recommendations(reference_recommendations(papers, citations), by_key, set(by_key))


def ensure_recommendations(state: dict[str, Any], cache_key: Any = None) -> None:
    """Migrate once in memory; reads never write or change the saved timestamp."""
    global _RECOMMENDATION_CACHE
    if state.get("recommendationsVersion") == RECOMMENDATIONS_VERSION:
        return
    with LOCK:
        if cache_key is not None and _RECOMMENDATION_CACHE and _RECOMMENDATION_CACHE[0] == cache_key:
            state["recommendations"] = copy.deepcopy(_RECOMMENDATION_CACHE[1])
        else:
            state["recommendations"] = rebuild_recommendations(state)
            if cache_key is not None:
                _RECOMMENDATION_CACHE = (cache_key, copy.deepcopy(state["recommendations"]))
    state["recommendationsVersion"] = RECOMMENDATIONS_VERSION
    if state.get("zoteroSync", {}).get("stats") is not None:
        state["zoteroSync"]["stats"]["recommendations"] = len(state["recommendations"])


def merge_zotero_snapshot(state: dict[str, Any], snapshot: dict[str, Any]) -> dict[str, Any]:
    """Merge into the latest state so edits made during PDF analysis survive."""
    by_key = {paper["zoteroKey"]: paper for paper in state["papers"]
              if paper.get("zoteroKey") and paper.get("sourceType", "paper") == "paper"}
    added = updated = 0
    current_keys = {item["zoteroKey"] for item in snapshot["papers"]}
    metadata_fields = ("title", "authors", "year", "doi", "arxivIds", "zoteroVersion", "url", "tags", "referenceAnalysis", "institution", "extra", "authorNames", "authorCount")
    for item in snapshot["papers"]:
        item = copy.deepcopy(item)
        # Cache hits describe this run, not a change to paper metadata.
        for attachment in item.get("referenceAnalysis", {}).get("attachments", []):
            attachment.pop("cached", None)
        key = item["zoteroKey"]
        paper = by_key.get(key)
        if paper is None:
            paper_id = fresh_id("p")
            paper = {
                "id": paper_id, "zoteroKey": key, "readStatus": "unread",
                "fileName": f"{slug(item['title'])}-{paper_id}.md",
                "createdAt": utc_now(),
            }
            state["papers"].append(paper)
            by_key[key] = paper
            added += 1
        elif any(paper.get(name) != item.get(name) for name in metadata_fields):
            updated += 1
        for name in metadata_fields:
            if name in item:
                paper[name] = item[name]
        paper.setdefault("readStatus", "unread")
        paper["zoteroUrl"] = f"zotero://select/library/items/{key}"
        paper["zoteroMissing"] = False
        paper["updatedAt"] = utc_now()
    missing = 0
    for key, paper in by_key.items():
        if key not in current_keys:
            paper["zoteroMissing"] = True
            missing += 1
    citations = []
    seen = set()
    for edge in snapshot["citations"]:
        source, target = by_key.get(edge["fromKey"]), by_key.get(edge["toKey"])
        if not source or not target or source["id"] == target["id"]:
            continue
        pair = (source["id"], target["id"])
        if pair in seen:
            continue
        seen.add(pair)
        citations.append({
            "id": f"cite_{source['id']}_{target['id']}",
            "fromId": source["id"], "toId": target["id"],
            "method": edge.get("method", ""), "evidence": edge.get("evidence", ""),
            "attachmentKey": edge.get("attachmentKey", ""),
        })
    state["citations"] = citations
    state["recommendations"] = map_recommendations(snapshot.get("recommendations", []), by_key, current_keys)
    state["recommendationsVersion"] = RECOMMENDATIONS_VERSION
    stats = {**snapshot["stats"], "added": added, "updated": updated, "missing": missing, "citations": len(citations),
             "recommendations": len(state["recommendations"])}
    state["zoteroSync"] = {"syncedAt": utc_now(), "stats": stats}
    return state["zoteroSync"]


class ZoteroLibrarySync:
    """One background library scan; ordinary reading and marking stay responsive."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.status: dict[str, Any] = {"status": "idle", "processed": 0, "total": 0, "message": ""}

    def public(self) -> dict[str, Any]:
        with self.lock:
            return copy.deepcopy(self.status)

    def start(self) -> dict[str, Any]:
        with self.lock:
            if self.status["status"] == "running":
                return copy.deepcopy(self.status)
            self.status = {"status": "running", "processed": 0, "total": 0, "message": "正在读取 Zotero 论文库…"}
            threading.Thread(target=self.run, daemon=True, name="zotero-library-sync").start()
            return copy.deepcopy(self.status)

    def progress(self, update: dict[str, Any]) -> None:
        with self.lock:
            self.status.update(
                processed=update.get("current", 0), total=update.get("total", 0),
                phase=update.get("phase", ""), title=update.get("title", ""),
                message="正在解析参考文献…" if update.get("phase") == "references" else "正在读取 Zotero 论文库…",
            )

    def run(self) -> None:
        try:
            with LOCK:
                previous = copy.deepcopy(load_state()["papers"])
            snapshot = collect_snapshot(zotero_get, previous, self.progress)
            with LOCK:
                state = load_state()
                result = merge_zotero_snapshot(state, snapshot)
                save_state(state)
            SYNC.mark_dirty()
            with self.lock:
                self.status.update(status="complete", message="Zotero 论文库已同步。", result=result)
        except Exception as error:
            # No partial snapshot is saved. The UI keeps the previous library and can retry.
            with self.lock:
                self.status.update(status="error", message="Zotero 同步失败。", error=str(error))


ZOTERO_SYNC = ZoteroLibrarySync()


def zotero_annotations(paper_key: str) -> list[dict[str, str]]:
    if not re.fullmatch(r"[A-Z0-9]{8}", paper_key):
        raise ValueError("Zotero Key 格式无效。")
    children = zotero_get(f"/items/{paper_key}/children")
    annotations = []
    for child in children:
        data = child.get("data", {})
        if data.get("itemType") != "attachment":
            continue
        attachment_key = child.get("key", "")
        if not re.fullmatch(r"[A-Z0-9]{8}", attachment_key):
            continue
        for item in zotero_get(f"/items/{attachment_key}/children"):
            annotation = item.get("data", {})
            if annotation.get("itemType") != "annotation":
                continue
            text = annotation.get("annotationText", "").strip()
            comment = annotation.get("annotationComment", "").strip()
            if not text and not comment:
                continue
            page = str(annotation.get("annotationPageLabel", "")).strip()
            position = annotation.get("annotationPosition", "")
            try:
                page_index = json.loads(position).get("pageIndex")
            except (ValueError, TypeError, AttributeError):
                page_index = None
            params = {}
            if isinstance(page_index, int) and page_index >= 0:
                params["page"] = str(page_index + 1)
            annotation_key = item.get("key", "")
            if re.fullmatch(r"[A-Z0-9]{8}", annotation_key):
                params["annotation"] = annotation_key
            source_url = f"zotero://open-pdf/library/items/{attachment_key}"
            if params:
                source_url += "?" + urllib.parse.urlencode(params)
            annotations.append({
                "text": text, "comment": comment, "page": page,
                "sourceUrl": source_url, "attachmentKey": attachment_key,
            })
    return annotations


def slug(text: str) -> str:
    value = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", text, flags=re.UNICODE).strip("-_")
    return value[:55] or "untitled"


def note_name(item: dict[str, Any]) -> str:
    return item.get("fileName") or f"{slug(item['title'])}-{item['id']}.md"


def wiki(kind: str, item: dict[str, Any]) -> str:
    folder = {"idea": "思想卡", "paper": "论文", "line": "阅读线", "stage": "模型阶段"}[kind]
    label = item["title"].replace("|", "｜").replace("[", "［").replace("]", "］")
    return f"[[PaperLine/{folder}/{note_name(item)[:-3]}|{label}]]"


def markdown_link(label: str, url: str) -> str:
    clean_label = label.replace("[", "［").replace("]", "］")
    return f"[{clean_label}](<{url}>)"


def render_note(state: dict[str, Any], kind: str, item: dict[str, Any]) -> str:
    english = state.get("settings", {}).get("language") == "en"
    def tr(zh: str, en: str) -> str:
        return en if english else zh

    def source_wiki(source: dict[str, Any]) -> str:
        label = {"webpage": tr("网页", "Web page"), "model": tr("模型", "Model")}.get(source.get("sourceType"))
        return f"{label} · {wiki('paper', source)}" if label else wiki("paper", source)

    lines = [f"# {item['title']}", ""]
    if kind == "idea":
        if item.get("aliases"):
            lines += [f"{tr('别名', 'Aliases')}: {', '.join(item['aliases'])}", ""]
        type_labels = {"concept": tr("基础概念", "Core concept"), "innovation": tr("创新思想", "New idea"), "question": tr("引申问题", "Follow-up question")}
        status_labels = {"inbox": tr("待学", "To learn"), "learning": tr("正在学", "Learning"), "understood": tr("已理解", "Understood")}
        lines += [f"{tr('类型', 'Type')}：{type_labels[item['kind']]} · {tr('状态', 'Status')}：{status_labels[item['status']]}", ""]
        for heading, key in ((tr("一句话", "In one sentence"), "summary"), (tr("核心机制", "Core mechanism"), "mechanism"), (tr("我的思考", "My thoughts"), "thoughts")):
            lines += [f"## {heading}", "", item.get(key, "") or tr("待补充。", "To be added."), ""]
        sources = [edge for edge in state["edges"] if edge["toId"] == item["id"] and edge["fromType"] == "paper"]
        mixed_sources = any(find(state, "papers", edge["fromId"]).get("sourceType", "paper") != "paper" for edge in sources)
        lines += [f"## {tr('相关资料', 'Related materials') if mixed_sources else tr('相关论文', 'Related papers')}", ""]
        rel = {"proposes": tr("提出", "Proposes"), "uses": tr("使用", "Uses"), "improves": tr("改进", "Improves"), "questions": tr("质疑", "Questions")}
        for edge in sources:
            paper = find(state, "papers", edge["fromId"])
            source = f" · {markdown_link(tr('原文位置', 'Source passage'), edge['sourceUrl'])}" if edge["sourceUrl"] else ""
            lines.append(f"- {source_wiki(paper)} · {rel[edge['relation']]}{source}")
            if edge["note"]:
                lines.append(f"  - {edge['note']}")
        if not sources:
            lines.append(tr("待关联。", "No connections yet."))
        source_papers = {edge["fromId"] for edge in sources}
        stage_ids = list(dict.fromkeys(edge["toId"] for edge in state["edges"]
                         if edge.get("toType") == "stage" and edge["fromId"] in source_papers))
        if stage_ids:
            lines += ["", f"## {tr('关联资料涉及的阶段（仅导航）', 'Stages associated with source materials (navigation only)') if mixed_sources else tr('关联论文涉及的阶段（仅导航）', 'Stages associated with source papers (navigation only)')}", ""]
            for stage_id in stage_ids:
                lines.append(f"- {wiki('stage', find(state, 'stages', stage_id))}")
        related = [edge for edge in state["edges"] if edge["fromType"] == "idea" and (edge["fromId"] == item["id"] or edge["toId"] == item["id"])]
        lines += ["", f"## {tr('思想关联', 'Idea connections')}", ""]
        relation_labels = {"extends": tr("引申", "Extends"), "depends": tr("依赖", "Depends on"), "compares": tr("对比", "Compares"), "improves": tr("改进", "Improves")}
        for edge in related:
            other_id = edge["toId"] if edge["fromId"] == item["id"] else edge["fromId"]
            other = find(state, "ideas", other_id)
            direction = "→" if edge["fromId"] == item["id"] else "←"
            lines.append(f"- {direction} {relation_labels[edge['relation']]} {wiki('idea', other)}")
        if not related:
            lines.append(tr("待关联。", "No connections yet."))
        sessions = [session for session in state["sessions"] if session["ideaId"] == item["id"]]
        lines += ["", f"## {tr('阅读记录', 'Reading sessions')}", ""]
        for session in sessions:
            lines.append(f"- {session['createdAt'][:10]} · {session['note']}")
            if session.get("nextQuestion"):
                lines.append(f"  - {tr('下次要弄清', 'Explore next')}: {session['nextQuestion']}")
        if not sessions:
            lines.append(tr("暂无。", "None yet."))
    elif kind == "paper":
        source_type = item.get("sourceType", "paper")
        if source_type != "paper":
            lines += [f"{tr('资料类型', 'Material type')}：{tr('网页', 'Web page') if source_type == 'webpage' else tr('模型', 'Model')}", ""]
            if item.get("url"):
                lines += [markdown_link(tr("打开网页", "Open web page") if source_type == "webpage" else tr("打开模型页面", "Open model page"), item["url"]), ""]
            lines += [f"## {tr('说明', 'Description')}", "", item.get("summary") or tr("待补充。", "To be added."), ""]
        if item.get("authors"):
            lines.append(f"{tr('作者', 'Authors')}：{item['authors']}")
        if item.get("year"):
            lines.append(f"{tr('年份', 'Year')}：{item['year']}")
        if item.get("doi"):
            lines.append(f"DOI：{item['doi']}")
        if item.get("zoteroUrl"):
            lines.append(markdown_link(tr("在 Zotero 打开", "Open in Zotero"), item["zoteroUrl"]))
        lines += ["", f"## {tr('相关思想', 'Related ideas')}", ""]
        related = [edge for edge in state["edges"] if edge["fromType"] == "paper" and edge["fromId"] == item["id"] and edge.get("toType", "idea") == "idea"]
        rel = {"proposes": tr("提出", "Proposes"), "uses": tr("使用", "Uses"), "improves": tr("改进", "Improves"), "questions": tr("质疑", "Questions")}
        for edge in related:
            idea = find(state, "ideas", edge["toId"])
            lines.append(f"- {rel[edge['relation']]} {wiki('idea', idea)}")
        if not related:
            lines.append(tr("待关联。", "No connections yet."))
        memberships = [edge for edge in state["edges"] if edge["fromType"] == "paper" and edge["fromId"] == item["id"] and edge.get("toType") == "stage"]
        lines += ["", f"## {tr('关联模型阶段', 'Associated model stages')}", ""]
        for membership in memberships:
            lines.append(f"- {wiki('stage', find(state, 'stages', membership['toId']))}")
        if not memberships:
            lines.append(tr("待关联。", "No connections yet."))
    elif kind == "stage":
        if item.get("date"):
            lines += [f"{tr('日期', 'Date')}：{item['date']}", ""]
        lines += [f"## {tr('阶段概述', 'Stage overview')}", "", item.get("summary") or tr("待补充。", "To be added."), ""]
        lines += [f"## {tr('所属阅读线', 'Reading lines')}", ""]
        for line in state["lines"]:
            if item["id"] in line.get("stageIds", []):
                lines.append(f"- {wiki('line', line)}")
        members = [edge for edge in state["edges"] if edge.get("toType") == "stage" and edge["toId"] == item["id"]]
        mixed_sources = any(find(state, "papers", member["fromId"]).get("sourceType", "paper") != "paper" for member in members)
        lines += ["", f"## {tr('阶段资料', 'Stage materials') if mixed_sources else tr('关联论文', 'Associated papers')}", ""]
        for membership in members:
            paper = find(state, "papers", membership["fromId"])
            lines.append(f"- {source_wiki(paper)}")
        if not members:
            lines.append(tr("待关联。", "No connections yet."))
        lines += ["", f"## {tr('关联资料的方法（仅导航）', 'Methods in associated materials (navigation only)') if mixed_sources else tr('关联论文的方法（仅导航）', 'Methods in associated papers (navigation only)')}", "",
                  tr("以下关系描述资料的方法标注，不自动表示本阶段采用这些方法。", "These annotations describe the materials; they do not imply adoption by this stage.") if mixed_sources else tr("以下关系描述论文的方法标注，不自动表示本阶段采用这些方法。", "These annotations describe the papers; they do not imply adoption by this stage."), ""]
        for membership in members:
            paper = find(state, "papers", membership["fromId"])
            for edge in state["edges"]:
                if edge["fromType"] == "paper" and edge["fromId"] == paper["id"] and edge.get("toType", "idea") == "idea":
                    lines.append(f"- {source_wiki(paper)} · {edge['relation']} · {wiki('idea', find(state, 'ideas', edge['toId']))}")
        selected = {value for member in members for value in member.get("contributionRefs", [])}
        if selected:
            lines += ["", f"## {tr('已标注的资料贡献', 'Selected material contributions') if mixed_sources else tr('已标注的论文贡献', 'Selected paper contributions')}", ""]
            for edge in state["edges"]:
                if edge["id"] in selected:
                    lines.append(f"- {source_wiki(find(state, 'papers', edge['fromId']))} · {edge['relation']} · {wiki('idea', find(state, 'ideas', edge['toId']))}")
                    if edge.get("note"):
                        lines.append(f"  - {edge['note']}")
                    if edge.get("sourceUrl"):
                        lines.append(f"  - {markdown_link(tr('原文位置', 'Source passage'), edge['sourceUrl'])}")
    elif kind == "line":
        if item.get("stageIds"):
            lines += [f"## {tr('模型阶段（展示顺序）', 'Model stages (display order)')}", ""]
            for index, stage_id in enumerate(item["stageIds"], 1):
                stage = find(state, "stages", stage_id)
                marker = f" ← {tr('当前阶段', 'Current stage')}" if stage_id == item.get("activeStageId") else ""
                lines.append(f"{index}. {wiki('stage', stage)}{marker}")
            lines += ["", tr("排列不自动表示继承关系。", "Ordering does not imply inheritance."), ""]
        lines += [f"## {tr('研究问题', 'Research question')}", "", item.get("question") or tr("待补充。", "To be added."), "", f"## {tr('阅读顺序', 'Reading order')}", ""]
        for index, idea_id in enumerate(item["ideaIds"], 1):
            idea = find(state, "ideas", idea_id)
            marker = f" ← {tr('下一张', 'Up next')}" if idea_id == item["activeIdeaId"] else ""
            lines.append(f"{index}. {wiki('idea', idea)}{marker}")
        if not item["ideaIds"]:
            lines.append(tr("待添加思想卡。", "No idea cards yet."))
    if kind in {"paper", "stage"}:
        records = [session for session in state["sessions"] if session.get("targetType") == kind and session.get("targetId") == item["id"]]
        if records:
            lines += ["", f"## {tr('阅读记录', 'Reading sessions')}", ""]
            for session in records:
                lines.append(f"- {session['createdAt'][:10]} · {session['note']}")
                if session.get("nextQuestion"):
                    lines.append(f"  - {session['nextQuestion']}")
    return "\n".join(lines).rstrip() + "\n"


def managed_document(item_id: str, generated: str, extra: str) -> str:
    return generated + "\n" + extra


def merge_managed(existing: str, item_id: str, generated: str, where: str = "") -> str:
    start = f"<!-- PAPERLINE:START {item_id} -->"
    end = f"<!-- PAPERLINE:END {item_id} -->"
    if existing.count(start) != 1 or existing.count(end) != 1 or existing.index(start) > existing.index(end):
        raise ValueError(f"已存在同名笔记且无法确认生成内容，为保护手写内容已取消本次导出：{where}")
    before, rest = existing.split(start, 1)
    _, after = rest.split(end, 1)
    return before + generated + after


def export_obsidian(state: dict[str, Any]) -> dict[str, Any]:
    vault_path = state["settings"].get("vaultPath", "")
    if not vault_path:
        raise ValueError("请先设置 Obsidian 库路径。")
    vault = Path(vault_path).resolve()
    if not vault.is_dir() or not (vault / ".obsidian").is_dir():
        raise ValueError("Obsidian 库路径已失效，请重新设置。")
    root = vault / "PaperLine"
    manifest_path = root / ".paperline-export.json"
    folders = {"line": "阅读线", "idea": "思想卡", "paper": "论文", "stage": "模型阶段"}

    def checked_path(relative: str) -> Path:
        parts = Path(relative).parts
        if (len(parts) != 2 or parts[0] not in folders.values() or parts[1] in {".", ".."}
                or "/" in parts[1] or "\\" in parts[1] or not parts[1].endswith(".md")):
            raise ValueError("导出笔记路径无效，未修改任何文件。")
        target = root / relative
        check = target
        while check != vault:
            if check.is_symlink():
                raise ValueError(f"导出路径含符号链接，未修改任何文件：{check}")
            check = check.parent
        return target

    if root.is_symlink() or manifest_path.is_symlink():
        raise ValueError("导出路径含符号链接，未修改任何文件。")
    owned = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if not isinstance(manifest, dict) or manifest.get("version") != 1 or not isinstance(manifest.get("notes"), dict):
                raise ValueError()
            owned = manifest["notes"]
            for relative, entry in owned.items():
                checked_path(relative)
                if (not isinstance(entry, dict) or entry.get("kind") not in folders
                        or Path(relative).parts[0] != folders[entry["kind"]]
                        or not isinstance(entry.get("id"), str) or not entry["id"]
                        or not isinstance(entry.get("generated"), str) or not entry["generated"]
                        or ("pendingGenerated" in entry and
                            (not isinstance(entry["pendingGenerated"], str) or not entry["pendingGenerated"]))):
                    raise ValueError()
        except (ValueError, TypeError, OSError) as error:
            raise ValueError("导出记录无效，未修改任何文件。") from error

    # Migrate only unambiguous legacy notes whose filenames and markers identify app ownership.
    for kind, folder in folders.items():
        directory = root / folder
        checked_path(f"{folder}/probe.md")
        if directory.exists():
            for candidate in directory.glob("*.md"):
                relative = str(candidate.relative_to(root))
                checked_path(relative)
                if relative in owned:
                    continue
                text = candidate.read_text(encoding="utf-8")
                match = re.search(r"<!-- PAPERLINE:START ((?:l|i|p|st)_[A-Za-z0-9]+) -->", text)
                if not match or match[1].split("_", 1)[0] != {"line": "l", "idea": "i", "paper": "p", "stage": "st"}[kind]:
                    continue
                item_id = match[1]
                start, end = match[0], f"<!-- PAPERLINE:END {item_id} -->"
                if (not candidate.name.endswith(f"-{item_id}.md") or text.count(start) != 1
                        or text.count(end) != 1 or text.index(start) > text.index(end)):
                    continue
                generated = text.split(start, 1)[1].split(end, 1)[0].removeprefix("\n")
                if generated:
                    owned[relative] = {"kind": kind, "id": item_id, "generated": generated}

    plans = []
    skipped = 0
    next_owned = {}
    interim_owned = copy.deepcopy(owned)
    current_ids = {kind: {item["id"] for item in state[collection]}
                   for kind, collection in (("line", "lines"), ("idea", "ideas"), ("paper", "papers"), ("stage", "stages"))}
    for kind, collection in (("line", "lines"), ("idea", "ideas"), ("paper", "papers"), ("stage", "stages")):
        for item in state[collection]:
            name = note_name(item)
            # Backups move between macOS and Windows. Reject incompatible filenames
            # before writing any export, including Windows device names and ADS paths.
            if (Path(name).name != name or PureWindowsPath(name).name != name
                    or any(char in '<>:"/\\|?*' or ord(char) < 32 for char in name)
                    or name.endswith((".", " "))
                    or name.split(".", 1)[0].rstrip(" ").upper() in
                    {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in "123456789¹²³"),
                     *(f"LPT{i}" for i in "123456789¹²³")}):
                raise ValueError("导出笔记路径无效，未修改任何文件。")
            relative = f"{folders[kind]}/{note_name(item)}"
            if relative in next_owned:
                raise ValueError("多篇笔记使用同一导出路径，未修改任何文件。")
            target = checked_path(relative)
            generated = render_note(state, kind, item)
            entry = owned.get(relative)
            if entry and (entry["id"] != item["id"] or entry["kind"] != kind):
                raise ValueError(f"导出笔记身份冲突，未修改任何文件：PaperLine/{relative}")
            previous_generated = generated
            if target.exists():
                existing = target.read_text(encoding="utf-8")
                if f"<!-- PAPERLINE:START {item['id']} -->" in existing:
                    content = merge_managed(existing, item["id"], generated, f"PaperLine/{relative}")
                    previous_generated = existing.split(f"<!-- PAPERLINE:START {item['id']} -->", 1)[1].split(
                        f"<!-- PAPERLINE:END {item['id']} -->", 1)[0].removeprefix("\n")
                else:
                    candidates = set(filter(None, (entry.get("generated"), entry.get("pendingGenerated")))) if entry else set()
                    matches = [(existing.index(value), value) for value in candidates if existing.count(value) == 1]
                    # A longer pending block can contain its previous shorter version.
                    matches.sort(key=lambda match: -len(match[1]))
                    if (not matches or any(existing.count(value) > 1 for value in candidates)
                            or any(not (matches[0][0] <= offset and offset + len(value) <= matches[0][0] + len(matches[0][1]))
                                   for offset, value in matches[1:])):
                        raise ValueError(f"已存在同名笔记且生成内容已修改或无法确认，为保护手写内容已取消本次导出：PaperLine/{relative}")
                    previous_generated = matches[0][1]
                    content = existing.replace(previous_generated, generated, 1)
                if content == existing:
                    skipped += 1
                else:
                    plans.append((target, content))
            else:
                if kind == "paper":
                    extra = ("## In one sentence\n\n## Problem addressed\n\n## Core mechanism\n\n## My thoughts\n\n## Techniques\n\n### Relationship to other methods\n\n## Limitations\n\n## Paper / report\n"
                             if state.get("settings", {}).get("language") == "en" else
                             "## 一句话\n\n## 解决问题\n\n## 核心机制\n\n## 思考\n\n## 技巧\n\n### 与其他方法的关系\n\n## 局限\n\n## 论文/报告\n")
                else:
                    extra = "## My additions\n\n" if state.get("settings", {}).get("language") == "en" else "## 我的补充\n\n"
                plans.append((target, managed_document(item["id"], generated, extra)))
            next_owned[relative] = {"id": item["id"], "kind": kind, "generated": generated}
            interim_owned[relative] = {"id": item["id"], "kind": kind, "generated": previous_generated,
                                       "pendingGenerated": generated}

    removals = []
    for relative, entry in owned.items():
        if relative in next_owned:
            continue
        if entry["id"] in current_ids[entry["kind"]]:
            # Filename changes are not deletions; retain ownership of the old note.
            next_owned[relative] = entry
            continue
        source = checked_path(relative)
        if source.exists():
            trash = vault / ".trash" / "PaperLine" / relative
            check = trash
            while check != vault:
                if check.is_symlink():
                    raise ValueError("回收站路径含符号链接，未修改任何文件。")
                check = check.parent
            while trash.exists():
                trash = trash.with_name(f"{source.stem}-{secrets.token_hex(4)}.md")
            removals.append((source, trash))

    # Persist both generations before changing notes, so interrupted exports can resume.
    def write_manifest(notes: dict[str, Any]) -> None:
        content = json.dumps({"version": 1, "notes": notes}, ensure_ascii=False, indent=2) + "\n"
        root.mkdir(parents=True, exist_ok=True)
        if manifest_path.exists() and manifest_path.read_text(encoding="utf-8") == content:
            return
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=root,
                                         delete=False, prefix=".paperline-") as handle:
            handle.write(content)
            temp_name = handle.name
        try:
            os.replace(temp_name, manifest_path)
        finally:
            Path(temp_name).unlink(missing_ok=True)

    # Everything is checked before the first write, including stale-note moves.
    if plans or removals:
        write_manifest(interim_owned)
    for target, content in plans:
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=target.parent,
                                         delete=False, prefix=".paperline-") as handle:
            handle.write(content)
            temp_name = handle.name
        try:
            os.replace(temp_name, target)
        finally:
            Path(temp_name).unlink(missing_ok=True)
    for source, trash in removals:
        trash.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, trash)
    write_manifest(next_owned)
    return {"count": len(plans), "skipped": skipped, "removed": len(removals), "folder": str(root)}


# ==================== WebDAV 云端同步 ====================

def default_webdav() -> dict[str, Any]:
    return {"enabled": False, "url": "", "username": "", "password": "", "folder": "PaperLine"}


def load_webdav() -> dict[str, Any]:
    config = default_webdav()
    try:
        data = json.loads(WEBDAV_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return config
    if isinstance(data, dict):
        for key, default in config.items():
            if isinstance(data.get(key), type(default)):
                config[key] = data[key]
    return config


def save_webdav(config: dict[str, Any]) -> None:
    WEBDAV_FILE.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(dir=WEBDAV_FILE.parent, prefix=".webdav-")
    try:
        if callable(getattr(os, "fchmod", None)):
            os.fchmod(handle, 0o600)  # POSIX: current user only. Windows uses app-data ACLs.
        else:
            os.chmod(temp_name, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(config, stream, ensure_ascii=False, indent=2)
        os.replace(temp_name, WEBDAV_FILE)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def webdav_folder(value: str) -> str:
    parts = [part.strip() for part in value.replace("\\", "/").split("/") if part.strip()]
    if not parts:
        return "PaperLine"
    if len(parts) > 5 or any(part in {".", ".."} or len(part) > 80 for part in parts):
        raise ValueError("云端文件夹名称无效。")
    return "/".join(parts)


def clean_webdav(payload: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    url = field(payload, "url", 500)
    if not url:
        return default_webdav()
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"https", "http"} or not parsed.hostname:
        raise ValueError("WebDAV 地址需以 https:// 或 http:// 开头。")
    if parsed.username or parsed.password:
        raise ValueError("请把用户名和密码填在下面的输入框里，不要写进地址。")
    if parsed.query or parsed.fragment:
        raise ValueError("WebDAV 地址不能带 ? 或 # 部分。")
    url = url.rstrip("/") + "/"
    username = field(payload, "username", 200)
    password = payload.get("password", "")
    if not isinstance(password, str) or len(password) > 500:
        raise ValueError("WebDAV 密码无效。")
    if not password and current["url"] == url and current["username"] == username:
        # 留空表示沿用已保存的密码；换了服务器或账号就不沿用，避免把旧密码发给别处。
        password = current["password"]
    enabled = payload.get("enabled", False)
    if not isinstance(enabled, bool):
        raise ValueError("自动同步开关无效。")
    return {
        "enabled": enabled, "url": url, "username": username, "password": password,
        "folder": webdav_folder(field(payload, "folder", 200)),
    }


def webdav_failure(code: int) -> str:
    if code in (401, 403):
        return "WebDAV 拒绝了访问：用户名、密码或写入权限不对。"
    if code in (404, 409):
        return "WebDAV 上找不到这个地址或文件夹。"
    if code == 507:
        return "WebDAV 云端空间不足。"
    return f"WebDAV 返回错误 {code}。"


def webdav_exchange(
    config: dict[str, Any], method: str, path: str = "",
    body: bytes | None = None, headers: dict[str, str] | None = None,
) -> tuple[int, bytes, Any]:
    parts = [urllib.parse.quote(part) for part in path.split("/") if part]
    url = config["url"] + "/".join(parts) + ("/" if path.endswith("/") and parts else "")
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    if config["username"] or config["password"]:
        pair = f"{config['username']}:{config['password']}".encode("utf-8")
        request.add_header("Authorization", "Basic " + base64.b64encode(pair).decode("ascii"))
    try:
        with urllib.request.urlopen(request, timeout=WEBDAV_TIMEOUT) as response:
            return response.status, response.read(), response.headers
    except urllib.error.HTTPError as error:
        reply_headers = error.headers
        error.close()
        return error.code, b"", reply_headers
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ConnectionError("连不上 WebDAV 服务器，请检查地址和网络。") from error


def webdav_request(
    config: dict[str, Any], method: str, path: str = "",
    body: bytes | None = None, headers: dict[str, str] | None = None,
) -> int:
    return webdav_exchange(config, method, path, body, headers)[0]


def webdav_ensure_folders(config: dict[str, Any], folder: str) -> None:
    current = ""
    for part in folder.split("/"):
        current += part + "/"
        code = webdav_request(config, "MKCOL", current)
        if code not in (200, 201, 204, 301, 405):  # 405 表示文件夹已经存在
            raise ConnectionError(webdav_failure(code))


def webdav_check(config: dict[str, Any]) -> None:
    if not config["url"]:
        raise ValueError("请先填写 WebDAV 地址。")
    code = webdav_request(config, "PROPFIND", "", headers={"Depth": "0"})
    if code not in (200, 207):
        raise ConnectionError(webdav_failure(code))
    webdav_ensure_folders(config, config["folder"])


def webdav_upload(config: dict[str, Any], body: bytes, when: datetime, expected: dict[str, Any] | None = None) -> None:
    folder = config["folder"]
    webdav_ensure_folders(config, folder + "/history-v2")
    headers = {"Content-Type": "application/json; charset=utf-8"}
    for name in ("state-v2.json", f"history-v2/state-v2-{when:%Y-%m-%d}.json"):
        request_headers = dict(headers)
        if name == "state-v2.json":
            if expected is None:
                request_headers["If-None-Match"] = "*"
            else:
                etag = expected.get("etag", "")
                if not etag or etag.startswith("W/"):
                    raise SyncConflict("云端未提供强 ETag，无法安全覆盖。请从云端恢复，或选择空的同步位置。")
                request_headers["If-Match"] = etag
        code = webdav_request(config, "PUT", f"{folder}/{name}", body, request_headers)
        if code == 412:
            raise SyncConflict("云端在同步期间有更新，已停止覆盖。请重新比较后再同步。")
        if code not in (200, 201, 204):
            raise ConnectionError(webdav_failure(code))


CONFLICT_MESSAGE = "云端有更新的数据，已暂停自动上传。请在设置里从云端恢复，或用立即同步覆盖云端。"


class SyncConflict(ConnectionError):
    """云端的数据比本机新，不能直接覆盖。"""


def parse_stamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            moment = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def comparable(data: dict[str, Any]) -> dict[str, Any]:
    # 设置属于各自的机器，时间戳本身也不算内容。
    return {key: value for key, value in data.items() if key not in {"savedAt", "settings", "_migration"}}


def local_snapshot() -> dict[str, Any]:
    with LOCK:
        exists = DATA_FILE.exists()
        data = load_state()
        stamp = data.get("savedAt") if isinstance(data.get("savedAt"), str) else ""
        if not stamp and exists:
            stamp = datetime.fromtimestamp(DATA_FILE.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")
    return {"data": data, "savedAt": stamp, "exists": exists}


def cloud_snapshot(config: dict[str, Any], strict: bool = True) -> dict[str, Any] | None:
    code, body, headers = webdav_exchange(config, "GET", f"{config['folder']}/state-v2.json")
    if code == 404:
        return None
    if code != 200:
        raise ConnectionError(webdav_failure(code))
    try:
        raw = json.loads(body)
        if not isinstance(raw, dict) or raw.get("version") != 2:
            raise ValueError("云端数据版本不受支持。")
        data = validate_backup(raw)
    except ValueError as error:
        # Even automatic sync must never treat an invalid/newer schema as an empty cloud.
        raise ValueError("云端的 state-v2.json 不是有效的 PaperLine v2 数据，已停止上传。") from error
    stamp = data.get("savedAt") if isinstance(data.get("savedAt"), str) else ""
    if not stamp:
        # 旧版本上传的文件没有时间戳，退回用服务器记录的修改时间。
        moment = parse_stamp(headers.get("Last-Modified", "") if headers else "")
        stamp = moment.isoformat(timespec="seconds") if moment else ""
    etag = next((value for key, value in (headers or {}).items() if key.lower() == "etag"), "")
    return {"data": data, "savedAt": stamp, "etag": etag}


def newer_side(local: dict[str, Any], cloud: dict[str, Any] | None) -> str:
    if cloud is None:
        return "local"
    if comparable(local["data"]) == comparable(cloud["data"]):
        return "same"
    if not local["exists"]:
        return "cloud"
    mine, theirs = parse_stamp(local["savedAt"]), parse_stamp(cloud["savedAt"])
    if mine is None or theirs is None:
        return "cloud" if mine is None and theirs else "local" if theirs is None and mine else "unknown"
    if mine == theirs:
        return "unknown"
    return "local" if mine > theirs else "cloud"


def snapshot_summary(snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
    if snapshot is None:
        return None
    return {"savedAt": snapshot["savedAt"], "counts": {key: len(snapshot["data"][key]) for key in ("lines", "ideas", "papers", "stages")}}


def webdav_keep_overwritten(config: dict[str, Any], cloud: dict[str, Any]) -> None:
    webdav_ensure_folders(config, config["folder"] + "/history-v2")
    body = (json.dumps(cloud["data"], ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    name = f"history-v2/state-v2-overwritten-{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(3)}.json"
    code = webdav_request(config, "PUT", f"{config['folder']}/{name}", body, {"Content-Type": "application/json; charset=utf-8"})
    if code not in (200, 201, 204):
        raise ConnectionError(webdav_failure(code))


class WebDavSync:
    """从第一次未上传的改动算起，攒满一个间隔再统一上传；失败保留待上传状态并按退避重试。"""

    def __init__(self, interval: float = WEBDAV_INTERVAL_SECONDS) -> None:
        self.interval = interval
        self.condition = threading.Condition()
        self.upload_lock = threading.Lock()
        self.dirty_at: float | None = None
        self.retry_at = 0.0
        self.failures = 0
        self.running = False
        self.stopping = False
        self.last_success = ""
        self.last_error = ""
        self.conflict = False
        self.thread: threading.Thread | None = None

    def status(self) -> dict[str, Any]:
        with self.condition:
            next_in = None
            if self.dirty_at is not None:
                next_in = max(0, int(max(self.dirty_at + self.interval, self.retry_at) - time.monotonic()))
            return {
                "lastSuccessAt": self.last_success, "lastError": self.last_error,
                "pending": self.dirty_at is not None, "running": self.running,
                "nextUploadIn": None if self.conflict else next_in,
                "conflict": self.conflict,
            }

    def mark_dirty(self) -> None:
        if not load_webdav()["enabled"]:
            return
        with self.condition:
            # 只记第一次改动的时间：后续改动并入同一次上传，不会一直往后推。
            if self.dirty_at is None:
                self.dirty_at = time.monotonic()
                self.condition.notify_all()

    def sync_now(self, force: bool = False) -> None:
        config = load_webdav()
        if not config["url"]:
            raise ValueError("请先填写 WebDAV 地址。")
        with self.upload_lock:
            local = local_snapshot()
            upload_data = copy.deepcopy(local["data"])
            upload_data.pop("_migration", None)
            body = (json.dumps(upload_data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            with self.condition:
                self.running = True
                self.dirty_at = None  # 上传期间的新改动会重新标记
            try:
                cloud = cloud_snapshot(config, strict=False)
                same_content = cloud is not None and comparable(local["data"]) == comparable(cloud["data"])
                if cloud is not None and not same_content and (not cloud.get("etag") or cloud["etag"].startswith("W/")):
                    raise SyncConflict("云端未提供强 ETag，无法安全覆盖。请从云端恢复，或选择空的同步位置。")
                needs_confirmation = (local["data"].get("_migration", {}).get("pendingCloudConfirmation") is True
                                      and cloud is not None and comparable(local["data"]) != comparable(cloud["data"]))
                if needs_confirmation or newer_side(local, cloud) in ("cloud", "unknown"):
                    if not force:
                        raise SyncConflict(CONFLICT_MESSAGE)
                    webdav_keep_overwritten(config, cloud)  # 覆盖前把云端那份留进 history
                if not same_content:
                    webdav_upload(config, body, datetime.now(), expected=cloud)
                if "_migration" in local["data"]:
                    with LOCK:
                        latest = load_state()
                        if (latest.get("_migration") == local["data"].get("_migration")
                                and latest.get("savedAt") == local["data"].get("savedAt")
                                and comparable(latest) == comparable(local["data"])):
                            latest.pop("_migration", None)
                            save_state(latest, stamp=False)
            except SyncConflict as error:
                with self.condition:
                    self.running = False
                    self.conflict = True
                    self.last_error = str(error)
                    if self.dirty_at is None:
                        self.dirty_at = time.monotonic()
                raise
            except (ConnectionError, ValueError) as error:
                with self.condition:
                    self.running = False
                    self.last_error = str(error)
                    self.failures += 1
                    if self.dirty_at is None:
                        self.dirty_at = time.monotonic()
                    self.retry_at = time.monotonic() + min(900, 60 * 2 ** (self.failures - 1))
                raise
            with self.condition:
                self.running = False
                self.conflict = False
                self.last_error = ""
                self.failures = 0
                self.retry_at = 0.0
                self.last_success = utc_now()

    def clear_conflict(self) -> None:
        with self.condition:
            if self.conflict:
                self.conflict = False
                self.last_error = ""
            self.condition.notify_all()

    def run(self) -> None:
        while True:
            with self.condition:
                while not self.stopping:
                    if self.dirty_at is None or self.conflict:
                        self.condition.wait()  # 冲突时不再自动上传，等用户处理
                        continue
                    wait = max(self.dirty_at + self.interval, self.retry_at) - time.monotonic()
                    if wait <= 0:
                        break
                    self.condition.wait(wait)
                if self.stopping:
                    return
            if not load_webdav()["enabled"]:
                with self.condition:
                    self.dirty_at = None
                continue
            try:
                self.sync_now()
            except (ConnectionError, ValueError):
                pass  # 错误已记录在状态里，等待退避后重试

    def start(self) -> None:
        if self.thread:
            return
        self.thread = threading.Thread(target=self.run, name="webdav-sync", daemon=True)
        self.thread.start()
        self.mark_dirty()  # 启动时补传一次，覆盖上次没传成功的改动

    def stop(self, flush: bool = True) -> None:
        with self.condition:
            self.stopping = True
            pending = self.dirty_at is not None
            self.condition.notify_all()
        if self.thread:
            self.thread.join(timeout=2)
        if flush and pending and load_webdav()["enabled"]:
            last = threading.Thread(target=self._quiet_sync, daemon=True)
            last.start()
            last.join(timeout=10)

    def _quiet_sync(self) -> None:
        try:
            self.sync_now()
        except (ConnectionError, ValueError):
            pass


SYNC = WebDavSync()


def require_webdav() -> dict[str, Any]:
    config = load_webdav()
    if not config["url"]:
        raise ValueError("请先填写 WebDAV 地址。")
    return config


def compare_with_cloud() -> dict[str, Any]:
    cloud = cloud_snapshot(require_webdav())
    local = local_snapshot()
    return {"local": snapshot_summary(local), "cloud": snapshot_summary(cloud), "newer": newer_side(local, cloud)}


def restore_from_cloud(expect: str) -> dict[str, Any]:
    # An active upload may still replace the cloud with its earlier local snapshot.
    # Read and confirm only after it finishes, using the same lock order as sync.
    with SYNC.upload_lock:
        cloud = cloud_snapshot(require_webdav())
        if cloud is None:
            raise ValueError("云端还没有 PaperLine 备份。")
        if expect and cloud["savedAt"] != expect:
            raise ValueError("云端的数据刚刚有更新，请重新确认后再恢复。")
        if cloud["savedAt"]:
            cloud["data"]["savedAt"] = cloud["savedAt"]  # 恢复后两边时间一致，不会被当成冲突
        with LOCK:
            result = restore_state(cloud["data"], keep_stamp=True, label="before-cloud-restore")
        SYNC.clear_conflict()
    return result


def public_webdav() -> dict[str, Any]:
    config = load_webdav()
    return {
        "enabled": config["enabled"], "url": config["url"], "username": config["username"],
        "folder": config["folder"], "hasPassword": bool(config["password"]),
        "insecure": config["url"].startswith("http://"), "status": SYNC.status(),
    }


def api_request(method: str, path: str, request: dict[str, Any] | None = None) -> tuple[int, Any]:
    """Shared API transport boundary for HTTP and the desktop stdin sidecar."""
    if method == "GET":
        parsed = urllib.parse.urlparse(path)
        query = urllib.parse.parse_qs(parsed.query)
        if parsed.path in {"/api/state", "/api/backup"}:
            with LOCK:
                return 200, load_state()
        if parsed.path == "/api/zotero/search":
            return 200, {"items": zotero_search(query.get("q", [""])[0])}
        if parsed.path == "/api/zotero/annotations":
            return 200, {"annotations": zotero_annotations(query.get("key", [""])[0])}
        if parsed.path == "/api/zotero/sync":
            return 200, ZOTERO_SYNC.public()
        if parsed.path == "/api/webdav":
            return 200, public_webdav()
        if parsed.path == "/api/webdav/cloud":
            return 200, compare_with_cloud()
        return 404, {"error": "页面不存在。"}
    if method != "POST":
        raise ValueError("请求方法无效。")
    if not isinstance(request, dict):
        raise ValueError("请求内容无效。")
    if path == "/api/action":
        action = request.get("action")
        payload = request.get("payload", {})
        if not isinstance(action, str) or not isinstance(payload, dict):
            raise ValueError("操作内容无效。")
        with LOCK:
            state = load_state()
            result = apply_action(state, action, payload)
            save_state(state)
        SYNC.mark_dirty()
        return 200, {"state": state, "result": result}
    elif path == "/api/restore":
        with LOCK:
            result = restore_state(request.get("backup"))
            state = load_state()
        SYNC.mark_dirty()
        return 200, {"state": state, "result": result}
    elif path == "/api/zotero/sync":
        return 202, ZOTERO_SYNC.start()
    elif path == "/api/export":
        with LOCK:
            result = export_obsidian(load_state())
        return 200, result
    elif path == "/api/webdav/config":
        config = clean_webdav(request, load_webdav())
        save_webdav(config)
        SYNC.clear_conflict()  # 可能换了服务器，旧的冲突判断作废
        SYNC.mark_dirty()
        return 200, public_webdav()
    elif path == "/api/webdav/test":
        config = clean_webdav(request, load_webdav())
        webdav_check(config)
        return 200, {"ok": True, "insecure": config["url"].startswith("http://")}
    elif path == "/api/webdav/sync":
        SYNC.sync_now(force=request.get("force") is True)
        return 200, public_webdav()
    elif path == "/api/webdav/restore":
        expect = request.get("expectSavedAt", "")
        if not isinstance(expect, str):
            raise ValueError("恢复请求无效。")
        result = restore_from_cloud(expect)
        with LOCK:
            state = load_state()
        return 200, {"state": state, "result": result}
    else:
        return 404, {"error": "页面不存在。"}


class Handler(BaseHTTPRequestHandler):
    server: ThreadingHTTPServer

    def _allowed(self) -> bool:
        host = self.headers.get("Host", "")
        port = self.server.server_port
        if host not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            self.send_error(403)
            return False
        origin = self.headers.get("Origin", "")
        if origin and origin not in {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}:
            self.send_error(403)
            return False
        return True

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data: Any) -> None:
        self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self) -> None:
        if not self._allowed():
            return
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path in STATIC:
                path, content_type = STATIC[parsed.path]
                self._send(200, path.read_bytes(), content_type)
            else:
                status, data = api_request("GET", self.path)
                if parsed.path == "/api/backup" and status == 200:
                    self._send(status, json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"),
                               "application/json; charset=utf-8")
                else:
                    self._json(status, data)
        except (ValueError, ConnectionError) as error:
            self._json(400 if isinstance(error, ValueError) else 503, {"error": str(error)})

    def do_POST(self) -> None:
        if not self._allowed():
            return
        if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
            self._json(415, {"error": "请求格式无效。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 20_000_000:
                raise ValueError("请求内容过大或为空。")
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ValueError("请求内容无效。")
            status, data = api_request("POST", self.path, request)
            self._json(status, data)
        except (ValueError, json.JSONDecodeError) as error:
            self._json(400, {"error": str(error)})
        except SyncConflict as error:
            self._json(409, {"error": str(error), "conflict": True})
        except ConnectionError as error:
            self._json(503, {"error": str(error)})


def main() -> None:
    parser = argparse.ArgumentParser(description="启动 PaperLine 本地应用")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}"
    print(f"PaperLine 已启动：{url}", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    def stop_on_term(*_: Any) -> None:
        raise KeyboardInterrupt  # 让启动器的 SIGTERM 也走下面的收尾，把最后的改动传上去

    signal.signal(signal.SIGTERM, stop_on_term)
    SYNC.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        SYNC.stop()


if __name__ == "__main__":
    main()
