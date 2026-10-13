"""Read a local Zotero library and conservatively match its bibliography links."""

from __future__ import annotations

import re
import hashlib
import unicodedata
from collections import defaultdict
from typing import Any, Callable


PAGE_SIZE = 100
CACHE_VERSION = 2
RECOMMENDATIONS_VERSION = 1
KEY = re.compile(r"[A-Z0-9]{8}")
DOI = re.compile(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.I)
ARXIV = re.compile(r"(?:arxiv\s*[:.]\s*|arxiv\.org/(?:abs|pdf)/)(\d{4}\.\d{4,5}|[a-z.-]+/\d{7})(?:v\d+)?(?!\d)", re.I)
REFERENCE_HEADING = re.compile(
    r"^\s*(?:(?:\d+(?:\.\d+)*|[A-Z])\.?\s+)?(?:references|bibliography|参考文献)\s*[:：]?\s*$",
    re.I | re.M,
)
AFTER_REFERENCES = re.compile(
    r"^\s*(?:(?:\d+(?:\.\d+)*|[A-Z])\.?\s+)?(?:(?:appendix|appendices|supplementary material|acknowledg(?:e)?ments?)\b|附录)[^\n]*$",
    re.I | re.M,
)
# Letter-labelled appendix headings commonly omit the word "Appendix". Require
# a blank line or PDF page break and heading-like text, not an author-initial line.
LETTER_SECTION = re.compile(
    r"(?:\n[ \t]*\n[ \t\f]*|\f[ \t]*)(?:[A-Z](?:\.\d+)+|[A-Z]\.?)"
    r"[ \t]+[A-Z][^\n.,;:!?]{4,100}(?=\n|$)")


def normalized(text: str) -> str:
    return " ".join(re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text).casefold()))


def doi_key(text: str) -> str:
    match = DOI.search(text)
    if not match:
        return ""
    value = match.group().casefold().rstrip(".,;:")
    while value.endswith(")") and value.count(")") > value.count("("):
        value = value[:-1]
    return value


def reference_section(text: str) -> str:
    # PDF text often wraps a word at a line-end. Join only explicit hyphenation.
    text = unicodedata.normalize("NFKC", text).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(?<=\w)[-\u00ad]\s*\n\s*(?=\w)", "", text)
    heading = REFERENCE_HEADING.search(text)
    if not heading:
        return ""
    remaining = text[heading.end():]
    ends = [match.start() for pattern in (AFTER_REFERENCES, LETTER_SECTION)
            if (match := pattern.search(remaining))]
    return remaining[:min(ends)].strip() if ends else remaining.strip()


def library_items(zotero_get: Callable, progress: Callable) -> list[dict[str, Any]]:
    items = []
    seen = set()
    start = 0
    while True:
        page = zotero_get("/items", {
            "limit": str(PAGE_SIZE), "start": str(start),
            "sort": "dateAdded", "direction": "asc",
        })
        if not isinstance(page, list) or any(not isinstance(item, dict) for item in page):
            raise ValueError("Zotero 返回的论文列表格式不正确，未更新地图。")
        new = [item for item in page if item.get("key") not in seen]
        if page and not new:
            raise ValueError("Zotero 分页没有继续前进，未更新地图。")
        items.extend(new)
        seen.update(item.get("key") for item in page)
        progress({"phase": "library", "current": len(items), "total": 0, "title": ""})
        if len(page) < PAGE_SIZE:
            return items
        start += len(page)


def paper_metadata(item: dict[str, Any]) -> dict[str, Any]:
    data = item.get("data", {})
    authors = []
    for creator in data.get("creators", []):
        name = creator.get("name") or " ".join(
            part for part in (creator.get("firstName"), creator.get("lastName")) if part
        )
        if name:
            authors.append(name)
    year = re.search(r"\b(?:19|20)\d{2}\b", data.get("date", ""))
    identifiers = " ".join(str(data.get(field, "")) for field in ("DOI", "url", "extra", "archiveID"))
    if re.fullmatch(r"\d{4}\.\d{4,5}(?:v\d+)?", data.get("archiveID", "")):
        identifiers += " arxiv:" + data["archiveID"]
    return {
        "zoteroKey": item["key"], "zoteroVersion": item.get("version", 0),
        "title": data.get("title") or "未命名论文", "authors": ", ".join(authors),
        "authorNames": authors, "authorCount": len(authors),
        "year": year.group() if year else "", "doi": data.get("DOI", ""),
        "url": data.get("url", ""), "itemType": data.get("itemType", ""),
        "arxivIds": sorted({match.group(1).casefold() for match in ARXIV.finditer(identifiers)}),
        "tags": [tag["tag"] for tag in data.get("tags", []) if tag.get("tag")],
        "institution": data.get("extra", ""), "extra": data.get("extra", ""),
        "zoteroUrl": f"zotero://select/library/items/{item['key']}",
    }


def analyze_attachment(zotero_get: Callable, attachment: dict[str, Any], cached: dict[str, Any]) -> dict[str, Any]:
    key = attachment["key"]
    version = attachment.get("version", 0)
    if (cached.get("status") == "complete" and cached.get("version") == version
            and cached.get("cacheVersion") == CACHE_VERSION and isinstance(cached.get("referenceText"), str)):
        return {**cached, "cached": True}
    result = {"key": key, "version": version, "cacheVersion": CACHE_VERSION,
              "source": "zotero_fulltext", "referenceText": "", "cached": False,
              "indexedPages": None, "totalPages": None}
    try:
        fulltext = zotero_get(f"/items/{key}/fulltext")
    except (ConnectionError, OSError, ValueError) as error:
        return {**result, "status": "no_text", "message": f"Zotero 全文不可用：{error}",
                "_retrievalError": True}
    if not isinstance(fulltext, dict) or not isinstance(fulltext.get("content"), str) or not fulltext["content"].strip():
        return {**result, "status": "no_text", "message": "PDF 暂无可读取的 Zotero 全文；请下载附件并建立全文索引。"}
    references = reference_section(fulltext["content"])
    result["referenceText"] = references
    partial = False
    coverage_known = False
    for unit in ("Pages", "Chars"):
        indexed, total = fulltext.get("indexed" + unit), fulltext.get("total" + unit)
        if (isinstance(indexed, (int, float)) and not isinstance(indexed, bool)
                and isinstance(total, (int, float)) and not isinstance(total, bool)
                and 0 <= indexed <= total):
            result["indexed" + unit], result["total" + unit] = indexed, total
            partial = partial or indexed < total
            coverage_known = coverage_known or total > 0
    if partial:
        return {**result, "status": "partial", "message": "Zotero 全文索引不完整；当前仅分析已索引的参考文献。"}
    if not coverage_known:
        return {**result, "status": "partial", "message": "已读取全文，但 Zotero 未提供有效索引覆盖范围；引用关系可能缺失。"}
    if not references:
        return {**result, "status": "no_references", "message": "全文中未识别到参考文献区，未推测引用关系。"}
    return {**result, "status": "complete", "message": "已分析参考文献区。"}


def citation_matches(papers: list[dict[str, Any]]) -> list[dict[str, str]]:
    identifiers: dict[str, dict[str, list[str]]] = {
        method: defaultdict(list) for method in ("doi", "arxiv", "title")
    }
    title_patterns = []
    for paper in papers:
        key = paper["zoteroKey"]
        doi = doi_key(paper["doi"])
        if doi:
            identifiers["doi"][doi].append(key)
        for arxiv in paper.get("arxivIds", []):
            identifiers["arxiv"][arxiv].append(key)
        title = normalized(paper["title"])
        # Very short titles are ambiguous in bibliography prose; use identifiers instead.
        if len(title) >= 18 and (len(title.split()) >= 4 or re.search(r"[\u3400-\u9fff]", title)):
            identifiers["title"][title].append(key)
    for title, keys in identifiers["title"].items():
        if len(keys) == 1:
            pattern = r"(?<!\w)" + r"[\W_]+".join(re.escape(word) for word in title.split()) + r"(?!\w)"
            title_patterns.append((keys[0], re.compile(pattern, re.I)))
    edges = {}
    for paper in papers:
        to_key = paper["zoteroKey"]
        for attachment in paper["referenceAnalysis"]["attachments"]:
            text = attachment.get("referenceText", "")
            candidates = []
            for method, expression in (("doi", DOI), ("arxiv", ARXIV)):
                for match in expression.finditer(text):
                    value = doi_key(match.group()) if method == "doi" else match.group(1).casefold()
                    keys = identifiers[method].get(value, [])
                    if len(keys) == 1:
                        candidates.append((keys[0], method, match))
            for key, pattern in title_patterns:
                for match in pattern.finditer(text):
                    # A matching title prefix in a different, longer title is not evidence.
                    preceding = text[:match.start()].rstrip()
                    following = text[match.end():].lstrip()
                    if (following and (following[0].isalnum() or following[0] in ":：")) or (
                            preceding and (preceding[-1].isalnum() or preceding[-1] in ":：")):
                        continue
                    candidates.append((key, "title", match))
            for from_key, method, match in candidates:
                pair = (from_key, to_key)
                if from_key == to_key or pair in edges:
                    continue
                evidence = " ".join(text[max(0, match.start() - 90):match.end() + 180].split())
                edges[pair] = {"fromKey": from_key, "toKey": to_key, "method": method,
                               "evidence": evidence, "attachmentKey": attachment["key"]}
    return list(edges.values())


def bibliography_entries(text: str) -> list[str]:
    """Group only the already-isolated bibliography, retaining uncertain text."""
    lines = text.splitlines()
    numbered = re.compile(r"^\s*(?:\[\d+\]|\d+[.)])\s+")
    has_numbers = any(numbered.match(line) for line in lines)
    entries, current = [], []
    for line in lines:
        if re.fullmatch(r"\s*\d+\s*", line):
            continue  # PDF page number, not a reference boundary.
        # Author/year styles may wrap titles over several lines. A new author
        # line must have its year before any sentence-ending title punctuation.
        author_year = re.match(
            r"^[A-Z][^\n]{1,160}?\b(?:19|20)\d{2}[a-z]?\s*[.)]?\s*[A-Z]", line)
        author_start = re.match(
            r"^(?:[A-Z]\.\s+[A-Z]|[A-Z][\w’' -]{1,35},\s*(?:[A-Z]\.|[A-Z][a-z])|"
            r"[A-Z][\w’'-]+(?: [A-Z][\w’'-]+){1,3}[,.]|[A-Z][\w@'-]+\.\s+[A-Z])", line)
        previous = " ".join(current)
        completed = (DOI.search(previous) or ARXIV.search(previous)
                     or (previous.endswith(".") and reference_title(previous)))
        starts = bool(numbered.match(line)) if has_numbers else bool(author_year or (author_start and completed))
        if (starts or (not has_numbers and not line.strip())) and current:
            entries.append(" ".join(current))
            current = []
        if line.strip():
            current.append(numbered.sub("", line).strip())
    if current:
        entries.append(" ".join(current))
    return entries


def reference_title(text: str) -> str:
    """Extract a substantive title only when sentence boundaries support it."""
    def substantive(value: str) -> bool:
        value = value.strip()
        norm = normalized(value)
        return (len(norm) >= 18 and (len(norm.split()) >= 4 or re.search(r"[\u3400-\u9fff]", norm))
                and not DOI.search(value) and not ARXIV.search(value)
                and not re.match(r"(?:in\b|proceedings\b|journal\b|corr\b|abs/|arxiv\b|preprint\b|url\b|https?://|vol\b|pp\b|pages\b|isbn\b|doi\b)", value, re.I)
                and not re.search(r"\bet\s+al\b|\b(?:19|20)\d{2}\b", value)
                and not ("," in value and re.search(r"\b[A-Z]\.|\band\b|[A-Z][a-z]+ [A-Z][a-z]+", value))
                and not re.fullmatch(r"[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}(?: and [A-Z][a-z]+(?: [A-Z][a-z]+){1,2})+", value))
    quoted = re.search(r'[“"]([^”"\n]+)[”"]', text)
    if quoted and substantive(quoted.group(1)):
        return quoted.group(1).strip()
    # A year at the start of a reference usually separates authors from title.
    year = re.search(r"\b(?:19|20)\d{2}[a-z]?\b[.)]?\s*", text)
    candidates = []
    if year and year.start() < 180:
        after_year = text[year.end():].lstrip(" .,:;)")
        candidates.extend(re.split(r"(?<=\.)\s+", after_year)[:1])
    candidates.extend(re.split(r"(?<=\.)\s+", text)[:8])
    titles = {}
    for candidate in candidates:
        candidate = candidate.strip(" .,:;\"“”")
        candidate = re.sub(r",?\s+\b(?:19|20)\d{2}[a-z]?$", "", candidate)
        if substantive(candidate):
            titles.setdefault(normalized(candidate), candidate)
    return next(iter(titles.values())) if len(titles) == 1 else ""


def reference_recommendations(papers: list[dict[str, Any]], citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Count library edges and external identifiers without guessing alias links."""
    by_key = {paper["zoteroKey"]: paper for paper in papers}
    library_ids, library_titles = defaultdict(set), defaultdict(set)

    def identifier(doi: str = "", arxiv: str = "") -> str:
        # This DOI namespace encodes an arXiv ID; other DOI/arXiv pairs need
        # verified metadata and must not be joined merely by nearby PDF text.
        encoded = re.fullmatch(r"10\.48550/arxiv\.(\d{4}\.\d{4,5})(?:v\d+)?", doi)
        return "arxiv:" + (encoded.group(1) if encoded else arxiv) if encoded or arxiv else "doi:" + doi

    for paper in papers:
        key = paper["zoteroKey"]
        if doi := doi_key(paper.get("doi", "")):
            library_ids[identifier(doi=doi)].add(key)
        for arxiv in paper.get("arxivIds", []):
            library_ids[identifier(arxiv=arxiv)].add(key)
        library_titles[normalized(paper["title"])].add(key)

    groups = {}

    def add(identity: str, title: str, doi: str, arxiv: str, matched: str,
            citing: str, attachment: str, text: str, verification: str):
        if matched == citing:
            return
        item = groups.setdefault(identity, {
            "id": identity, "title": title, "doi": doi, "arxivId": arxiv,
            "url": "https://doi.org/" + doi if doi else "https://arxiv.org/abs/" + arxiv if arxiv else "",
            "matchedKey": matched, "referenceText": text, "verification": verification,
            "citingKeys": set(), "evidence": [],
        })
        if title and not item["title"]:
            item["title"] = title
            item["verification"] = verification
        item["citingKeys"].add(citing)
        evidence = {"citingKey": citing, "attachmentKey": attachment, "text": text}
        if evidence not in item["evidence"]:
            item["evidence"].append(evidence)

    for edge in citations:
        target = by_key[edge["fromKey"]]
        doi = doi_key(target.get("doi", ""))
        arxiv = next(iter(target.get("arxivIds", [])), "")
        identity = identifier(doi=doi) if doi else identifier(arxiv=arxiv) if arxiv else "zotero:" + edge["fromKey"]
        add(identity, target["title"], doi, arxiv, edge["fromKey"], edge["toKey"],
            edge["attachmentKey"], edge["evidence"], "library")

    for paper in papers:
        for attachment in paper["referenceAnalysis"]["attachments"]:
            for text in bibliography_entries(attachment.get("referenceText", "")):
                ids = {}
                for match in DOI.finditer(text):
                    doi = doi_key(match.group())
                    identity = identifier(doi=doi)
                    ids[identity] = (doi, identity[6:] if identity.startswith("arxiv:") else "")
                for match in ARXIV.finditer(text):
                    arxiv = match.group(1).casefold()
                    identity = identifier(arxiv=arxiv)
                    ids.setdefault(identity, ("", arxiv))
                # Multiple distinct identifiers may mean the PDF paragraph
                # contains several references. Keep each ID's own nearby text,
                # never transfer a guessed title or another ID into its record.
                years = set(re.findall(r"\b(?:19|20)\d{2}\b", text))
                title = reference_title(text) if len(ids) <= 1 and len(years) <= 1 else ""
                if ids:
                    for identity, (doi, arxiv) in ids.items():
                        if identity in library_ids or (title and normalized(title) in library_titles):
                            continue  # Library recommendations come from edges.
                        evidence_text = text
                        if len(ids) > 1:
                            value = doi or arxiv
                            position = text.casefold().find(value)
                            evidence_text = text[max(0, position - 100):position + len(value) + 100]
                        add(identity, title, doi, arxiv, "", paper["zoteroKey"],
                            attachment["key"], evidence_text,
                            "identifier" if title else "identifier_only")
                elif title:
                    title_key = normalized(title)
                    if title_key not in library_titles:
                        add("title:" + title_key, title, "", "", "", paper["zoteroKey"],
                            attachment["key"], text, "title")
                else:
                    identity = "raw:" + hashlib.sha256(normalized(text).encode()).hexdigest()[:24]
                    add(identity, "", "", "", "", paper["zoteroKey"], attachment["key"], text, "raw")

    # A title-only reference can join a uniquely identified external title. A
    # conflicting pair of IDs with the same title remains separate.
    title_ids = defaultdict(set)
    for identity, item in groups.items():
        if item["title"] and (item["doi"] or item["arxivId"]):
            title_ids[normalized(item["title"])].add(identity)
    for identity, item in list(groups.items()):
        if identity.startswith("title:") and len(title_ids.get(normalized(item["title"]), set())) == 1:
            target = groups[next(iter(title_ids[normalized(item["title"]) ]))]
            target["citingKeys"].update(item["citingKeys"])
            target["evidence"].extend(evidence for evidence in item["evidence"] if evidence not in target["evidence"])
            del groups[identity]
    recommendations = []
    for item in groups.values():
        item["citingKeys"].discard(item["matchedKey"])
        item["citingKeys"] = sorted(item["citingKeys"])
        item["citationCount"] = len(item["citingKeys"])
        if item["citationCount"] >= 2:
            recommendations.append(item)
    return sorted(recommendations, key=lambda item: (-item["citationCount"], item["id"]))


def collect_snapshot(zotero_get: Callable, previous_papers: list[dict[str, Any]],
                     progress: Callable | None = None) -> dict[str, Any]:
    """Read-only sync; the caller commits this complete snapshot atomically."""
    progress = progress or (lambda event: None)
    items = library_items(zotero_get, progress)
    papers = [paper_metadata(item) for item in items
              if KEY.fullmatch(str(item.get("key", "")))
              and item.get("data", {}).get("itemType") not in {"attachment", "note", "annotation"}
              and not item.get("data", {}).get("deleted")]
    attachments = defaultdict(list)
    for item in items:
        data = item.get("data", {})
        if (KEY.fullmatch(str(item.get("key", ""))) and data.get("itemType") == "attachment"
                and data.get("contentType") == "application/pdf" and not data.get("deleted")):
            attachments[data.get("parentItem", "")].append(item)
    previous = {paper.get("zoteroKey"): paper for paper in previous_papers}
    stats = {"papers": len(papers), "citations": 0, "cachedAttachments": 0, "analyzedAttachments": 0,
             "complete": 0, "partial": 0, "no_pdf": 0, "no_text": 0, "no_references": 0}
    retrieval_error = False
    for index, paper in enumerate(papers):
        key = paper["zoteroKey"]
        progress({"phase": "references", "current": index, "total": len(papers), "title": paper["title"]})
        old = previous.get(key, {}).get("referenceAnalysis", {})
        cache = {item.get("key"): item for item in old.get("attachments", [])}
        analyses = [analyze_attachment(zotero_get, item, cache.get(item["key"], {})) for item in attachments[key]]
        for analysis in analyses:
            retrieval_error = analysis.pop("_retrievalError", False) or retrieval_error
            stats["cachedAttachments" if analysis["cached"] else "analyzedAttachments"] += 1
        statuses = {analysis["status"] for analysis in analyses}
        if not analyses:
            status, message = "no_pdf", "此条目没有 PDF 附件，尚未分析引用。"
        elif statuses == {"complete"}:
            status, message = "complete", "已分析参考文献区；仅连接当前库内可明确匹配的论文。"
        elif "complete" in statuses or "partial" in statuses:
            status, message = "partial", "部分 PDF 全文不可用或分析不完整，引用关系可能缺失。"
        elif "no_text" in statuses:
            status, message = "no_text", "PDF 全文不可用；请在 Zotero 下载附件并重建全文索引后同步。"
        else:
            status, message = "no_references", "全文中未识别到参考文献区，未推测引用关系。"
        paper["referenceAnalysis"] = {"status": status, "message": message, "attachments": analyses, "matchedCount": 0}
        stats[status] += 1
    if retrieval_error:
        # An unavailable attachment is a coverage gap. A disconnected library is
        # a failed sync: let the caller retain the last successful snapshot.
        check = zotero_get("/items", {"limit": "1", "start": "0"})
        if not isinstance(check, list):
            raise ValueError("无法确认 Zotero 连接，未更新地图。")
    citations = citation_matches(papers)
    by_key = {paper["zoteroKey"]: paper for paper in papers}
    for citation in citations:
        by_key[citation["toKey"]]["referenceAnalysis"]["matchedCount"] += 1
    stats["citations"] = len(citations)
    progress({"phase": "references", "current": len(papers), "total": len(papers), "title": ""})
    recommendations = reference_recommendations(papers, citations)
    stats["recommendations"] = len(recommendations)
    return {"papers": papers, "citations": citations, "stats": stats, "recommendations": recommendations,
            "recommendationsVersion": RECOMMENDATIONS_VERSION}
