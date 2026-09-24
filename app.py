#!/usr/bin/env python3
"""PaperLine: a small local reading-line app for Zotero and Obsidian."""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import tempfile
import threading
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "state.json"
STATIC = {
    "/": (ROOT / "static" / "index.html", "text/html; charset=utf-8"),
    "/i18n.js": (ROOT / "static" / "i18n.js", "text/javascript; charset=utf-8"),
    "/app.js": (ROOT / "static" / "app.js", "text/javascript; charset=utf-8"),
    "/style.css": (ROOT / "static" / "style.css", "text/css; charset=utf-8"),
}
LOCK = threading.RLock()
ZOTERO_BASE = "http://127.0.0.1:23119/api/users/0"
IDEA_KINDS = {"concept", "innovation", "question"}
IDEA_STATUSES = {"inbox", "learning", "understood"}
PAPER_RELATIONS = {"proposes", "uses", "improves", "questions"}
IDEA_RELATIONS = {"extends", "depends", "compares", "improves"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fresh_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(5)}"


def default_state() -> dict[str, Any]:
    return {
        "version": 1,
        "settings": {"vaultPath": "", "reminderTime": "", "language": "zh"},
        "lines": [],
        "ideas": [],
        "papers": [],
        "edges": [],
        "sessions": [],
    }


def load_state() -> dict[str, Any]:
    if not DATA_FILE.exists():
        return default_state()
    with DATA_FILE.open("r", encoding="utf-8") as handle:
        state = json.load(handle)
    if state.get("version") != 1:
        raise ValueError("数据版本不受支持。")
    return state


def save_state(state: dict[str, Any]) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
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
    result: dict[str, str] = {}
    if action == "line.create":
        line_id = fresh_id("l")
        title = field(payload, "title", 120, True)
        state["lines"].append({
            "id": line_id, "title": title, "fileName": f"{slug(title)}-{line_id}.md",
            "question": field(payload, "question", 800), "ideaIds": [],
            "activeIdeaId": "", "createdAt": utc_now(), "updatedAt": utc_now(),
        })
        result["lineId"] = line_id
    elif action == "line.update":
        line = find(state, "lines", field(payload, "id", 40, True))
        line["title"] = field(payload, "title", 120, True)
        line["question"] = field(payload, "question", 800)
        active = field(payload, "activeIdeaId", 40)
        if active and active not in line["ideaIds"]:
            raise ValueError("下一张卡必须属于这条阅读线。")
        line["activeIdeaId"] = active
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
        parent_id = field(payload, "fromIdeaId", 40)
        if parent_id:
            find(state, "ideas", parent_id)
        idea_id = fresh_id("i")
        title = field(payload, "title", 120, True)
        idea = {
            "id": idea_id, "title": title, "fileName": f"{slug(title)}-{idea_id}.md",
            "kind": kind, "summary": field(payload, "summary", 4000),
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
        status = field(payload, "status", 20)
        kind = field(payload, "kind", 20)
        if status not in IDEA_STATUSES or kind not in IDEA_KINDS:
            raise ValueError("卡片类型或状态无效。")
        for name, limit in (("title", 120), ("summary", 4000), ("mechanism", 6000), ("thoughts", 6000)):
            idea[name] = field(payload, name, limit, name == "title")
        idea["kind"] = kind
        idea["status"] = status
        if "aliases" in payload:
            idea["aliases"] = idea_aliases(payload)
        idea["updatedAt"] = utc_now()
        result["ideaId"] = idea["id"]
    elif action == "paper.create":
        key = field(payload, "zoteroKey", 40)
        if key and not re.fullmatch(r"[A-Z0-9]{8}", key):
            raise ValueError("Zotero Key 格式无效。")
        existing = next((paper for paper in state["papers"] if key and paper["zoteroKey"] == key), None)
        if existing:
            result["paperId"] = existing["id"]
        else:
            paper_id = fresh_id("p")
            title = field(payload, "title", 300, True)
            state["papers"].append({
                "id": paper_id, "title": title, "fileName": f"{slug(title)}-{paper_id}.md",
                "authors": field(payload, "authors", 500),
                "year": field(payload, "year", 20), "doi": field(payload, "doi", 300),
                "zoteroKey": key,
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
        edge["note"] = field(payload, "note", 3000)
        edge["sourceUrl"] = safe_url(field(payload, "sourceUrl", 1500))
        result["edgeId"] = edge["id"]
    elif action == "edge.delete":
        edge = find(state, "edges", field(payload, "id", 40, True))
        state["edges"] = [item for item in state["edges"] if item["id"] != edge["id"]]
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
    elif action == "session.create":
        line = find(state, "lines", field(payload, "lineId", 40, True))
        idea = find(state, "ideas", field(payload, "ideaId", 40, True))
        if idea["id"] not in line["ideaIds"]:
            raise ValueError("这张卡不在当前阅读线中。")
        duration = payload.get("durationSeconds", 0)
        if not isinstance(duration, int) or not 0 <= duration <= 86400:
            raise ValueError("阅读时间无效。")
        state["sessions"].append({
            "id": fresh_id("s"), "lineId": line["id"], "ideaId": idea["id"],
            "note": field(payload, "note", 4000, True),
            "nextQuestion": field(payload, "nextQuestion", 1000),
            "durationSeconds": duration, "createdAt": utc_now(),
        })
        line["activeIdeaId"] = idea["id"]
        line["updatedAt"] = utc_now()
        if idea["status"] == "inbox":
            idea["status"] = "learning"
        result.update(lineId=line["id"], ideaId=idea["id"])
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
        for creator in creators[:5]:
            name = creator.get("name") or " ".join(
                part for part in (creator.get("firstName"), creator.get("lastName")) if part
            )
            if name:
                authors.append(name)
        year_match = re.search(r"\b(?:19|20)\d{2}\b", data.get("date", ""))
        result.append({
            "title": data.get("title") or "未命名论文", "authors": ", ".join(authors),
            "year": year_match.group(0) if year_match else "",
            "doi": data.get("DOI", ""), "zoteroKey": item.get("key", ""),
        })
    return result


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
    folder = {"idea": "思想卡", "paper": "论文", "line": "阅读线"}[kind]
    label = item["title"].replace("|", "｜").replace("[", "［").replace("]", "］")
    return f"[[PaperLine/{folder}/{note_name(item)[:-3]}|{label}]]"


def markdown_link(label: str, url: str) -> str:
    clean_label = label.replace("[", "［").replace("]", "］")
    return f"[{clean_label}](<{url}>)"


def render_note(state: dict[str, Any], kind: str, item: dict[str, Any]) -> str:
    english = state.get("settings", {}).get("language") == "en"
    def tr(zh: str, en: str) -> str:
        return en if english else zh

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
        lines += [f"## {tr('相关论文', 'Related papers')}", ""]
        rel = {"proposes": tr("提出", "Proposes"), "uses": tr("使用", "Uses"), "improves": tr("改进", "Improves"), "questions": tr("质疑", "Questions")}
        for edge in sources:
            paper = find(state, "papers", edge["fromId"])
            source = f" · {markdown_link(tr('原文位置', 'Source passage'), edge['sourceUrl'])}" if edge["sourceUrl"] else ""
            lines.append(f"- {wiki('paper', paper)} · {rel[edge['relation']]}{source}")
            if edge["note"]:
                lines.append(f"  - {edge['note']}")
        if not sources:
            lines.append(tr("待关联。", "No connections yet."))
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
        if item.get("authors"):
            lines.append(f"{tr('作者', 'Authors')}：{item['authors']}")
        if item.get("year"):
            lines.append(f"{tr('年份', 'Year')}：{item['year']}")
        if item.get("doi"):
            lines.append(f"DOI：{item['doi']}")
        if item.get("zoteroUrl"):
            lines.append(markdown_link(tr("在 Zotero 打开", "Open in Zotero"), item["zoteroUrl"]))
        lines += ["", f"## {tr('相关思想', 'Related ideas')}", ""]
        related = [edge for edge in state["edges"] if edge["fromType"] == "paper" and edge["fromId"] == item["id"]]
        rel = {"proposes": tr("提出", "Proposes"), "uses": tr("使用", "Uses"), "improves": tr("改进", "Improves"), "questions": tr("质疑", "Questions")}
        for edge in related:
            idea = find(state, "ideas", edge["toId"])
            lines.append(f"- {rel[edge['relation']]} {wiki('idea', idea)}")
        if not related:
            lines.append(tr("待关联。", "No connections yet."))
    elif kind == "line":
        lines += [f"## {tr('研究问题', 'Research question')}", "", item.get("question") or tr("待补充。", "To be added."), "", f"## {tr('阅读顺序', 'Reading order')}", ""]
        for index, idea_id in enumerate(item["ideaIds"], 1):
            idea = find(state, "ideas", idea_id)
            marker = f" ← {tr('下一张', 'Up next')}" if idea_id == item["activeIdeaId"] else ""
            lines.append(f"{index}. {wiki('idea', idea)}{marker}")
        if not item["ideaIds"]:
            lines.append(tr("待添加思想卡。", "No idea cards yet."))
    return "\n".join(lines).rstrip() + "\n"


def managed_document(item_id: str, generated: str, extra: str) -> str:
    return f"<!-- PAPERLINE:START {item_id} -->\n{generated}<!-- PAPERLINE:END {item_id} -->\n\n{extra}"


def merge_managed(existing: str, item_id: str, generated: str) -> str:
    start = f"<!-- PAPERLINE:START {item_id} -->"
    end = f"<!-- PAPERLINE:END {item_id} -->"
    if existing.count(start) != 1 or existing.count(end) != 1:
        raise ValueError("已存在同名笔记且没有应用标记；为保护手写内容，已跳过。")
    before, rest = existing.split(start, 1)
    _, after = rest.split(end, 1)
    return before + start + "\n" + generated + end + after


def export_obsidian(state: dict[str, Any]) -> dict[str, Any]:
    vault_path = state["settings"].get("vaultPath", "")
    if not vault_path:
        raise ValueError("请先设置 Obsidian 库路径。")
    vault = Path(vault_path).resolve()
    if not vault.is_dir() or not (vault / ".obsidian").is_dir():
        raise ValueError("Obsidian 库路径已失效，请重新设置。")
    root = vault / "PaperLine"
    plans = []
    for kind, collection, folder in (
        ("line", "lines", "阅读线"),
        ("idea", "ideas", "思想卡"),
        ("paper", "papers", "论文"),
    ):
        for item in state[collection]:
            target = root / folder / note_name(item)
            generated = render_note(state, kind, item)
            if target.exists():
                content = merge_managed(target.read_text(encoding="utf-8"), item["id"], generated)
            else:
                if kind == "paper":
                    if state.get("settings", {}).get("language") == "en":
                        extra = "## In one sentence\n\n## Problem addressed\n\n## Core mechanism\n\n## My thoughts\n\n## Techniques\n\n### Relationship to other methods\n\n## Limitations\n\n## Paper / report\n"
                    else:
                        extra = "## 一句话\n\n## 解决问题\n\n## 核心机制\n\n## 思考\n\n## 技巧\n\n### 与其他方法的关系\n\n## 局限\n\n## 论文/报告\n"
                else:
                    extra = "## My additions\n\n" if state.get("settings", {}).get("language") == "en" else "## 我的补充\n\n"
                content = managed_document(item["id"], generated, extra)
            plans.append((target, content))
    for target, content in plans:
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=target.parent, delete=False, prefix=".paperline-"
        ) as handle:
            handle.write(content)
            temp_name = handle.name
        os.replace(temp_name, target)
    return {"count": len(plans), "folder": str(root)}


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
            elif parsed.path == "/api/state":
                with LOCK:
                    self._json(200, load_state())
            elif parsed.path == "/api/zotero/search":
                query = urllib.parse.parse_qs(parsed.query).get("q", [""])[0]
                self._json(200, {"items": zotero_search(query)})
            elif parsed.path == "/api/zotero/annotations":
                key = urllib.parse.parse_qs(parsed.query).get("key", [""])[0]
                self._json(200, {"annotations": zotero_annotations(key)})
            elif parsed.path == "/api/backup":
                with LOCK:
                    body = json.dumps(load_state(), ensure_ascii=False, indent=2).encode("utf-8")
                self._send(200, body, "application/json; charset=utf-8")
            else:
                self._json(404, {"error": "页面不存在。"})
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
            if not 0 < length <= 1_000_000:
                raise ValueError("请求内容过大或为空。")
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ValueError("请求内容无效。")
            if self.path == "/api/action":
                action = request.get("action")
                payload = request.get("payload", {})
                if not isinstance(action, str) or not isinstance(payload, dict):
                    raise ValueError("操作内容无效。")
                with LOCK:
                    state = load_state()
                    result = apply_action(state, action, payload)
                    save_state(state)
                self._json(200, {"state": state, "result": result})
            elif self.path == "/api/export":
                with LOCK:
                    result = export_obsidian(load_state())
                self._json(200, result)
            else:
                self._json(404, {"error": "页面不存在。"})
        except (ValueError, json.JSONDecodeError) as error:
            self._json(400, {"error": str(error)})


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
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
