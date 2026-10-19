"""Schema-2 knowledge and model-stage domain rules, independent of transports."""
from __future__ import annotations

import copy
import re
import unicodedata
from typing import Any

ENTITY_TYPES = {"method", "concept", "question", "unclassified"}
ACTIONS = {"paper.annotate_method", "paper.add_to_stage", "stage.create", "stage.update",
           "line.attach_stage", "line.detach_stage", "line.move_stage", "stage.remove_paper", "stage.add_contribution", "session.create"}


def upgrade_v1(data: dict[str, Any]) -> dict[str, Any]:
    state = copy.deepcopy(data)
    if not isinstance(state.get("settings"), dict):
        raise ValueError("旧备份设置无效。")
    for name in ("ideas", "lines", "papers", "edges", "sessions"):
        if not isinstance(state.get(name), list) or any(not isinstance(item, dict) or not isinstance(item.get("id"), str) for item in state[name]):
            raise ValueError("旧备份内容不完整。")
    state["version"] = 2
    state["stages"] = []
    for idea in state.get("ideas", []):
        idea.setdefault("entityType", "question" if idea.get("kind") == "question" else "unclassified")
    for line in state.get("lines", []):
        line.update(kind="research", stageIds=[], activeStageId="")
    for edge in state.get("edges", []):
        edge.setdefault("toType", "idea")
    for session in state.get("sessions", []):
        if isinstance(session, dict) and session.get("ideaId"):
            session.setdefault("targetType", "idea")
            session.setdefault("targetId", session["ideaId"])
    return state


def validate(state: dict[str, Any]) -> None:
    collections = {name: {item["id"] for item in state[name]} for name in ("papers", "ideas", "stages", "lines", "edges", "sessions")}
    for name, ids in collections.items():
        if len(ids) != len(state[name]) or any(not item for item in ids):
            raise ValueError("备份里存在重复或空的内容编号。")
    entity_ids = [item["id"] for name in ("papers", "ideas", "stages", "lines") for item in state[name]]
    if len(set(entity_ids)) != len(entity_ids):
        raise ValueError("不同实体不能使用相同编号。")
    for name in ("papers", "ideas", "stages", "lines"):
        for item in state[name]:
            if (not isinstance(item.get("title"), str) or not item["title"].strip()
                    or not isinstance(item.get("fileName", ""), str)):
                raise ValueError("备份实体名称或文件名无效。")
    for idea in state["ideas"]:
        if (any(not isinstance(idea.get(name), str) for name in ("entityType", "kind", "status"))
                or idea.get("entityType") not in ENTITY_TYPES or idea.get("kind") not in {"concept", "innovation", "question"}
                or idea.get("status") not in {"inbox", "learning", "understood"}
                or any(not isinstance(idea.get(name, ""), str) for name in ("summary", "mechanism", "thoughts"))
                or not isinstance(idea.get("aliases", []), list)
                or any(not isinstance(alias, str) for alias in idea.get("aliases", []))):
            raise ValueError("知识实体类型或内容无效。")
    for stage in state["stages"]:
        if (not isinstance(stage.get("title"), str) or not stage["title"].strip()
                or any(not isinstance(stage.get(key, ""), str) for key in ("date", "summary", "fileName", "createdAt", "updatedAt"))):
            raise ValueError("模型阶段内容无效。")
        validate_date(stage.get("date", ""))
    for line in state["lines"]:
        ids = line.get("stageIds")
        if (not isinstance(line.get("kind"), str) or line.get("kind") not in {"research", "model_family"} or not isinstance(ids, list)
                or not all(isinstance(item, str) for item in ids) or len(set(ids)) != len(ids)
                or not set(ids) <= collections["stages"]
                or (line.get("kind") == "research" and bool(ids))
                or line.get("activeStageId", "") not in ["", *ids]
                or line.get("activeIdeaId", "") not in ["", *line["ideaIds"]]
                or not isinstance(line.get("question", ""), str)):
            raise ValueError("阅读线的阶段引用无效。")
    edge_by_id = {edge["id"]: edge for edge in state["edges"]}
    membership_pairs = set()
    edge_keys = set()
    for edge in state["edges"]:
        key = (edge.get("fromType"), edge.get("fromId"), edge.get("toType", "idea"), edge.get("toId"), edge.get("relation"))
        if (key in edge_keys or any(not isinstance(edge.get(name, ""), str) for name in ("note", "sourceUrl"))
                or (edge.get("fromType") == "idea" and edge.get("fromId") == edge.get("toId"))):
            raise ValueError("关系内容或重复关系无效。")
        edge_keys.add(key)
        if edge.get("toType", "idea") == "stage":
            pair = (edge.get("fromId"), edge.get("toId"))
            if (edge.get("fromType") != "paper" or edge.get("relation") != "documents"
                    or edge.get("fromId") not in collections["papers"] or edge.get("toId") not in collections["stages"]
                    or pair in membership_pairs):
                raise ValueError("阶段论文成员关系无效。")
            membership_pairs.add(pair)
        refs = edge.get("contributionRefs", [])
        if (not isinstance(refs, list) or not all(isinstance(value, str) for value in refs)
                or len(set(refs)) != len(refs) or (refs and edge.get("toType") != "stage")):
            raise ValueError("阶段贡献引用无效。")
        for reference in refs:
            target = edge_by_id.get(reference, {})
            if (target.get("fromType") != "paper" or target.get("fromId") != edge.get("fromId")
                    or target.get("toType", "idea") != "idea"):
                raise ValueError("阶段贡献必须引用同一篇论文的方法关系。")
    for session in state["sessions"]:
        kind = session.get("targetType", "idea")
        target = session.get("targetId", session.get("ideaId"))
        collection = {"idea": "ideas", "paper": "papers", "stage": "stages"}.get(kind) if isinstance(kind, str) else None
        if collection is None or not isinstance(target, str):
            raise ValueError("阅读记录对象无效。")
        if target not in collections[collection]:
            snapshot = session.get("targetSnapshot")
            if (not isinstance(snapshot, dict) or snapshot.get("deleted") is not True
                    or snapshot.get("id") != target or snapshot.get("type") != kind
                    or not isinstance(snapshot.get("title"), str)):
                raise ValueError("已删除的阅读对象缺少历史说明。")
        duration = session.get("durationSeconds", 0)
        if (type(duration) is not int or not 0 <= duration <= 86400
                or any(not isinstance(session.get(name, ""), str) for name in ("note", "nextQuestion", "createdAt"))):
            raise ValueError("阅读记录内容无效。")
        # Historical line context may already be absent in v1; do not discard records.
        if not isinstance(session.get("lineId", ""), str):
            raise ValueError("阅读记录上下文无效。")

    migration = state.get("_migration")
    if migration is not None and (not isinstance(migration, dict) or migration.get("fromVersion") != 1
                                  or type(migration.get("pendingCloudConfirmation")) is not bool):
        raise ValueError("迁移确认状态无效。")


def validate_date(value: str) -> None:
    if value:
        from datetime import date
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError("阶段日期需为 YYYY-MM-DD 或留空。")
        try:
            date.fromisoformat(value)
        except ValueError as error:
            raise ValueError("阶段日期无效。") from error


def normalized(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def clean_refs(state: dict[str, Any]) -> None:
    ids = {edge["id"] for edge in state["edges"]}
    for edge in state["edges"]:
        if "contributionRefs" in edge:
            edge["contributionRefs"] = [value for value in edge["contributionRefs"] if value in ids]


def retain_sessions(state: dict[str, Any], kind: str, item: dict[str, Any]) -> None:
    for session in state["sessions"]:
        if session.get("targetType", "idea") == kind and session.get("targetId", session.get("ideaId")) == item["id"]:
            session["targetSnapshot"] = {"id": item["id"], "title": item["title"], "type": kind, "deleted": True}


def apply_action(state: dict[str, Any], action: str, payload: dict[str, Any], core) -> dict[str, str]:
    # Composite operations publish all changes together, including when called directly.
    draft = copy.deepcopy(state)
    result = _apply(draft, action, payload, core)
    state.clear()
    state.update(draft)
    return result


def _apply(state, action, payload, c):
    field = c.field
    find = c.find
    if action == "stage.create":
        title = field(payload, "title", 120, True)
        date = field(payload, "date", 10)
        validate_date(date)
        stage_id = c.fresh_id("st")
        stage = {"id": stage_id, "title": title, "date": date,
                 "summary": field(payload, "summary", 6000), "fileName": f"{c.slug(title)}-{stage_id}.md",
                 "createdAt": c.utc_now(), "updatedAt": c.utc_now()}
        state["stages"].append(stage)
        line_id = field(payload, "lineId", 40)
        if line_id:
            _apply(state, "line.attach_stage", {"lineId": line_id, "stageId": stage_id}, c)
        return {"stageId": stage_id, **({"lineId": line_id} if line_id else {})}
    if action == "stage.update":
        stage = find(state, "stages", field(payload, "id", 40, True))
        for name, limit in (("title", 120), ("date", 10), ("summary", 6000)):
            if name in payload:
                stage[name] = field(payload, name, limit, name == "title")
        validate_date(stage["date"])
        stage["updatedAt"] = c.utc_now()
        return {"stageId": stage["id"]}
    if action in {"line.attach_stage", "line.detach_stage", "line.move_stage"}:
        line = find(state, "lines", field(payload, "lineId", 40, True))
        stage_id = find(state, "stages", field(payload, "stageId", 40, True))["id"]
        if action == "line.attach_stage":
            if line["kind"] != "model_family":
                raise ValueError("阶段只能加入模型族演进线；请选择演进线或使用新名称创建。")
            if stage_id not in line["stageIds"]:
                line["stageIds"].append(stage_id)
            if not line["activeStageId"]:
                line["activeStageId"] = stage_id
        elif action == "line.detach_stage":
            line["stageIds"] = [value for value in line["stageIds"] if value != stage_id]
            if line["activeStageId"] == stage_id:
                line["activeStageId"] = next(iter(line["stageIds"]), "")
        else:
            offset = payload.get("offset")
            if type(offset) is not int or offset not in (-1, 1) or stage_id not in line["stageIds"]:
                raise ValueError("阶段移动内容无效。")
            index = line["stageIds"].index(stage_id)
            target = index + offset
            if 0 <= target < len(line["stageIds"]):
                line["stageIds"][index], line["stageIds"][target] = line["stageIds"][target], line["stageIds"][index]
        line["updatedAt"] = c.utc_now()
        return {"lineId": line["id"], "stageId": stage_id}
    if action == "paper.add_to_stage":
        paper_id = find(state, "papers", field(payload, "paperId", 40, True))["id"]
        line_id, stage_id = field(payload, "lineId", 40), field(payload, "stageId", 40)
        if line_id:
            if find(state, "lines", line_id)["kind"] != "model_family":
                raise ValueError("请选择模型族演进线；旧研究线保持原样。")
        elif field(payload, "lineTitle", 120):
            title = field(payload, "lineTitle", 120, True)
            matches = [line for line in state["lines"] if normalized(line["title"]) == normalized(title)]
            if len(matches) > 1:
                raise ValueError("找到多条同名阅读线，请明确选择阅读线。")
            if matches and matches[0]["kind"] != "model_family":
                raise ValueError("同名研究线已存在，请使用新名称创建模型族演进线。")
            line_id = matches[0]["id"] if matches else c.apply_action(state, "line.create", {"title": title, "kind": "model_family"})["lineId"]
        if stage_id:
            find(state, "stages", stage_id)
        else:
            title = field(payload, "stageTitle", 120, True)
            matches = [stage for stage in state["stages"] if normalized(stage["title"]) == normalized(title)]
            if len(matches) > 1:
                raise ValueError("找到多个同名阶段，请明确选择阶段。")
            stage_id = matches[0]["id"] if matches else _apply(state, "stage.create", {"title": title,
                               "date": payload.get("date", ""), "summary": payload.get("summary", "")}, c)["stageId"]
        if any(name in payload for name in ("date", "summary")):
            _apply(state, "stage.update", {"id": stage_id, **{name: payload[name] for name in ("date", "summary") if name in payload}}, c)
        if line_id:
            _apply(state, "line.attach_stage", {"lineId": line_id, "stageId": stage_id}, c)
        edge = next((edge for edge in state["edges"] if edge["fromType"] == "paper" and edge["fromId"] == paper_id
                     and edge.get("toType", "idea") == "stage" and edge["toId"] == stage_id), None)
        if edge is None:
            edge = {"id": c.fresh_id("e"), "fromType": "paper", "fromId": paper_id, "toType": "stage", "toId": stage_id,
                    "relation": "documents", "note": "", "sourceUrl": "", "createdAt": c.utc_now(), "contributionRefs": []}
            state["edges"].append(edge)
        if "contributionRefs" in payload:
            edge["contributionRefs"] = copy.deepcopy(payload["contributionRefs"])
            validate(state)
        return {"paperId": paper_id, "stageId": stage_id, "lineId": line_id, "edgeId": edge["id"]}
    if action == "stage.remove_paper":
        stage_id = find(state, "stages", field(payload, "stageId", 40, True))["id"]
        paper_id = find(state, "papers", field(payload, "paperId", 40, True))["id"]
        state["edges"] = [edge for edge in state["edges"] if not (edge.get("toType") == "stage" and edge["toId"] == stage_id
                                                               and edge["fromType"] == "paper" and edge["fromId"] == paper_id)]
        return {"stageId": stage_id, "paperId": paper_id}
    if action == "stage.add_contribution":
        if set(payload) - {"stageId", "edgeId"}:
            raise ValueError("加入阶段贡献只接受阶段和已有关系编号。")
        stage_id = find(state, "stages", field(payload, "stageId", 40, True))["id"]
        edge = find(state, "edges", field(payload, "edgeId", 40, True))
        if (edge.get("fromType") != "paper" or edge.get("toType", "idea") != "idea"
                or edge.get("relation") not in {"proposes", "improves", "uses"}):
            raise ValueError("请选择论文与方法之间的提出、使用或改进关系。")
        paper_id = find(state, "papers", edge["fromId"])["id"]
        method = find(state, "ideas", edge["toId"])
        if method.get("entityType") != "method":
            raise ValueError("阶段贡献必须关联已明确分类的方法。")
        membership = next((item for item in state["edges"] if item.get("fromType") == "paper"
                           and item.get("fromId") == paper_id and item.get("toType") == "stage"
                           and item.get("toId") == stage_id and item.get("relation") == "documents"), None)
        if membership is None:
            raise ValueError("请先将这篇论文加入所选模型阶段，再加入方法贡献。")
        membership["contributionRefs"] = list(dict.fromkeys([*membership.get("contributionRefs", []), edge["id"]]))
        return {"stageId": stage_id, "paperId": paper_id, "ideaId": method["id"],
                "edgeId": edge["id"], "membershipEdgeId": membership["id"]}
    if action == "paper.annotate_method":
        paper_id = find(state, "papers", field(payload, "paperId", 40, True))["id"]
        stage_id = field(payload, "stageId", 40)
        membership = None
        if stage_id:
            find(state, "stages", stage_id)
            membership = next((edge for edge in state["edges"] if edge["fromType"] == "paper" and edge["fromId"] == paper_id
                               and edge.get("toType") == "stage" and edge["toId"] == stage_id and edge["relation"] == "documents"), None)
            if membership is None:
                raise ValueError("请先将这篇论文加入所选模型阶段，再标注方法。")
        relation = field(payload, "relation", 20, True)
        if relation not in c.PAPER_RELATIONS:
            raise ValueError("论文关系类型无效。")
        idea_id = field(payload, "ideaId", 40)
        if idea_id:
            method = find(state, "ideas", idea_id)
        else:
            title = field(payload, "title", 120, True)
            matches = [idea for idea in state["ideas"] if normalized(title) in
                       {normalized(value) for value in [idea["title"], *idea.get("aliases", [])]}]
            if len(matches) > 1:
                raise ValueError("找到多个同名知识实体，请明确选择要关联的方法。")
            if matches:
                method = matches[0]
            else:
                idea_id = c.apply_action(state, "idea.create", {"title": title, "entityType": "method"})["ideaId"]
                method = find(state, "ideas", idea_id)
        idea_id = method["id"]
        method["entityType"] = "method"  # Explicit method annotation, never automatic batch classification.
        method["updatedAt"] = c.utc_now()
        matches = [edge for edge in state["edges"] if edge["fromType"] == "paper" and edge["fromId"] == paper_id
                   and edge.get("toType", "idea") == "idea" and edge["toId"] == idea_id]
        edge_id = field(payload, "edgeId", 40)
        if edge_id:
            edge = find(state, "edges", edge_id)
            if edge not in matches:
                raise ValueError("请选择这篇论文与该方法之间的关系。")
        elif len(matches) > 1:
            raise ValueError("存在多条旧关系，请明确选择要编辑的关系；旧事实已保留。")
        else:
            edge = matches[0] if matches else None
        if edge is None:
            edge_id = c.add_edge(state, "paper", paper_id, idea_id, relation,
                                 field(payload, "note", 3000), field(payload, "sourceUrl", 1500))
        else:
            edge_id = edge["id"]
            c.apply_action(state, "edge.update", {"id": edge_id, "relation": relation,
                           **{name: payload[name] for name in ("note", "sourceUrl") if name in payload}})
        result = {"paperId": paper_id, "ideaId": idea_id, "edgeId": edge_id}
        if membership is not None:
            membership["contributionRefs"] = list(dict.fromkeys([*membership.get("contributionRefs", []), edge_id]))
            result.update(stageId=stage_id, membershipEdgeId=membership["id"])
        return result
    if action == "session.create":
        kind = field(payload, "targetType", 20) or "idea"
        target_id = field(payload, "targetId", 40) or field(payload, "ideaId", 40, True)
        collection = {"idea": "ideas", "paper": "papers", "stage": "stages"}.get(kind)
        if collection is None:
            raise ValueError("阅读对象类型无效。")
        target = find(state, collection, target_id)
        line_id = field(payload, "lineId", 40)
        line = find(state, "lines", line_id) if line_id else None
        duration = payload.get("durationSeconds", 0)
        if type(duration) is not int or not 0 <= duration <= 86400:
            raise ValueError("阅读时间无效。")
        session_id = c.fresh_id("s")
        state["sessions"].append({"id": session_id, "lineId": line_id, "targetType": kind, "targetId": target_id,
                                  "ideaId": target_id if kind == "idea" else "", "targetSnapshot": {"id": target_id, "title": target["title"], "type": kind},
                                  "note": field(payload, "note", 4000, True), "nextQuestion": field(payload, "nextQuestion", 1000),
                                  "durationSeconds": duration, "createdAt": c.utc_now()})
        if line and kind == "idea" and target_id in line["ideaIds"]:
            line["activeIdeaId"] = target_id
        if line and kind == "stage" and target_id in line["stageIds"]:
            line["activeStageId"] = target_id
        if line:
            line["updatedAt"] = c.utc_now()
        if kind == "idea" and target.get("status") == "inbox":
            target["status"] = "learning"
        return {"sessionId": session_id, "targetType": kind, "targetId": target_id, "lineId": line_id,
                **({"ideaId": target_id} if kind == "idea" else {})}
    raise ValueError("未知学习操作。")
