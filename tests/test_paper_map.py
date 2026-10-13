import unittest
from unittest.mock import patch

import paper_map


def paper(key, title, **fields):
    return {"key": key, "version": 1, "data": {"itemType": "journalArticle", "title": title, **fields}}


def pdf(key, parent, version=1):
    return {"key": key, "version": version, "data": {
        "itemType": "attachment", "parentItem": parent, "contentType": "application/pdf",
    }}


class Zotero:
    def __init__(self, items, texts=None):
        self.items = items
        self.texts = texts or {}
        self.calls = []

    def get(self, path, params=None):
        self.calls.append((path, params))
        if path == "/items":
            start, limit = int(params["start"]), int(params["limit"])
            return self.items[start:start + limit]
        key = path.split("/")[2]
        if key not in self.texts:
            raise ConnectionError("Zotero 返回错误 404。")
        value = self.texts[key]
        if isinstance(value, str):
            return {"content": value, "indexedPages": 10, "totalPages": 10}
        return value


class PaperMapTests(unittest.TestCase):
    def test_institution_and_complete_author_metadata_preserve_zotero_values(self):
        extra = "清华大学\nDepartment: Computer Science\n原始信息"
        creators = [{"firstName": "Jane", "lastName": "Doe, Jr."},
                    {"name": "Research Consortium"}, {"firstName": "张", "lastName": "三"}]
        metadata = paper_map.paper_metadata(paper("AAAAAAAA", "Paper", extra=extra, creators=creators))
        self.assertEqual(metadata["institution"], extra)
        self.assertEqual(metadata["extra"], extra)
        self.assertEqual(metadata["authorNames"], ["Jane Doe, Jr.", "Research Consortium", "张 三"])
        self.assertEqual(metadata["authorCount"], 3)
        self.assertEqual(metadata["authors"], "Jane Doe, Jr., Research Consortium, 张 三")

    def test_shared_external_references_count_distinct_papers_and_exclude_body_appendix(self):
        items = [paper("AAAAAAAA", "First Source"), pdf("PPPPPPPP", "AAAAAAAA"),
                 pdf("QQQQQQQQ", "AAAAAAAA"), paper("BBBBBBBB", "Second Source"),
                 pdf("RRRRRRRR", "BBBBBBBB"), paper("CCCCCCCC", "Third Source"),
                 pdf("SSSSSSSS", "CCCCCCCC")]
        common = ("[1] Smith et al. Learning Better Models Through Examples. doi:10.1234/shared.\n"
                  "[2] Jones et al. Scaling Models With Human Feedback. arXiv:2305.12345v2.\n"
                  "[3] Author. Attention Is All You Need.\n"
                  "[4] Uncertain doi:10.1234/unknown.\n")
        first = "Body doi:10.1234/body.\nReferences\n" + common + common + "Appendix\ndoi:10.1234/appendix."
        second = "Body doi:10.1234/body.\nReferences\n" + common + "Appendix\ndoi:10.1234/appendix."
        third = "References\n[1] Smith et al. 2023. Learning Better Models Through Examples. https://doi.org/10.1234/shared."
        result = paper_map.collect_snapshot(Zotero(items, {
            "PPPPPPPP": first, "QQQQQQQQ": first, "RRRRRRRR": second, "SSSSSSSS": third,
        }).get, [])
        recommendations = {item["id"]: item for item in result["recommendations"]}
        self.assertEqual(len(recommendations), 4)
        shared = recommendations["doi:10.1234/shared"]
        self.assertEqual(shared["citingKeys"], ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC"])
        self.assertEqual(shared["citationCount"], 3)
        self.assertEqual(result["recommendations"][0]["id"], "doi:10.1234/shared")
        self.assertEqual(recommendations["arxiv:2305.12345"]["citationCount"], 2)
        self.assertEqual(recommendations["title:attention is all you need"]["title"], "Attention Is All You Need")
        self.assertEqual(recommendations["doi:10.1234/unknown"]["title"], "")
        self.assertEqual(result["citations"], [])

    def test_author_year_wrapped_entries_and_title_alias_match_identifier(self):
        items = [paper("AAAAAAAA", "First Source"), pdf("PPPPPPPP", "AAAAAAAA"),
                 paper("BBBBBBBB", "Second Source"), pdf("QQQQQQQQ", "BBBBBBBB")]
        title = "Learning Better Models Through Examples"
        result = paper_map.collect_snapshot(Zotero(items, {
            "PPPPPPPP": "References\nSmith, J. and Jones, A. 2023. Learning Better Models\nThrough Examples. In Conference. doi:10.1234/model.\n"
                          "Jones et al. 2022. Another Paper On Language Learning. In Workshop.",
            "QQQQQQQQ": "References\n[1] John Smith and Jane Miller. 2023. " + title + ". In Conference.\n"
                          "[2] Unrelated Singleton Reference Title Here. doi:10.1234/one.",
        }).get, [])
        self.assertEqual(len(result["recommendations"]), 1)
        self.assertEqual(result["recommendations"][0]["id"], "doi:10.1234/model")
        self.assertEqual(result["recommendations"][0]["title"], title)

    def test_conflicting_identifiers_do_not_merge_by_same_title(self):
        items, texts = [], {}
        for source, attachment, identifier in (("AAAAAAAA", "PPPPPPPP", "one"),
                                                ("BBBBBBBB", "QQQQQQQQ", "two")):
            items.extend([paper(source, "Source"), pdf(attachment, source)])
            texts[attachment] = "References\n[1] Author. Learning Better Models Through Examples. doi:10.1234/" + identifier + "."
        self.assertEqual(paper_map.collect_snapshot(Zotero(items, texts).get, [])["recommendations"], [])

    def test_unseparated_paragraph_never_unions_unrelated_doi_arxiv_or_library_titles(self):
        items = [paper("AAAAAAAA", "First Source"), pdf("PPPPPPPP", "AAAAAAAA"),
                 paper("BBBBBBBB", "Second Source"), pdf("QQQQQQQQ", "BBBBBBBB"),
                 paper("CCCCCCCC", "Adam: A Method for Stochastic Optimization")]
        # Real PDF failure shape: several bibliography entries flattened into a
        # paragraph. Nearby title and IDs must never contaminate one another.
        text = ("References\nD. Kingma and J. Ba. Adam: A Method for Stochastic Optimization. "
                "arXiv:1412.6980, 2014. A. Vaswani et al. Attention Is All You Need. "
                "doi:10.18653/v1/p17-1147, 2017. Another Reference. arXiv:2507.06261, 2025.")
        result = paper_map.collect_snapshot(Zotero(items, {"PPPPPPPP": text, "QQQQQQQQ": text}).get, [])
        by_id = {item["id"]: item for item in result["recommendations"]}
        adam = by_id["zotero:CCCCCCCC"]
        self.assertEqual(adam["title"], "Adam: A Method for Stochastic Optimization")
        self.assertEqual(adam["doi"], "")
        self.assertEqual(adam["arxivId"], "")
        external = by_id["doi:10.18653/v1/p17-1147"]
        self.assertEqual(external["arxivId"], "")
        self.assertEqual(external["title"], "")
        self.assertEqual(external["verification"], "identifier_only")
        self.assertEqual(by_id["arxiv:2507.06261"]["doi"], "")
        self.assertEqual(by_id["arxiv:2507.06261"]["citationCount"], 2)

    def test_arxiv_doi_alias_and_raw_fallback_are_counted_without_fabricated_metadata(self):
        items = [paper("AAAAAAAA", "First Source"), pdf("PPPPPPPP", "AAAAAAAA"),
                 paper("BBBBBBBB", "Second Source"), pdf("QQQQQQQQ", "BBBBBBBB")]
        result = paper_map.collect_snapshot(Zotero(items, {
            "PPPPPPPP": "References\n[1] URL https://doi.org/10.48550/arXiv.2507.06261.\n[2] Unknown [unverified].",
            "QQQQQQQQ": "References\n[1] arXiv:2507.06261v2.\n[2] Unknown [unverified].",
        }).get, [])
        self.assertEqual(len(result["recommendations"]), 2)
        arxiv = next(item for item in result["recommendations"] if item["id"] == "arxiv:2507.06261")
        self.assertEqual(arxiv["title"], "")
        self.assertEqual(arxiv["citationCount"], 2)
        raw = next(item for item in result["recommendations"] if item["id"].startswith("raw:"))
        self.assertEqual(raw["title"], "")
        self.assertEqual(raw["verification"], "raw")
        self.assertEqual(raw["referenceText"], "Unknown [unverified].")

    def test_adjacent_real_author_entries_are_not_grouped_together(self):
        text = ("V. Barres, H. Dong, S. Ray, X. Si, and K. Narasimhan. "
                "Evaluating conversational agents in a dual-control environment, 2025. URL https://arxiv.org/abs/2506.07982.\n"
                "DeepMind. Gemini 2.5: Pushing the frontier with advanced reasoning. arXiv:2507.06261, 2025a.")
        entries = paper_map.bibliography_entries(text)
        self.assertEqual(len(entries), 2)
        self.assertIn("2506.07982", entries[0])
        self.assertNotIn("2507.06261", entries[0])


    def test_recommendations_recompute_from_cache_and_remove_self_citations(self):
        items = [paper("AAAAAAAA", "Learning Better Models Through Examples", DOI="10.1234/model"),
                 pdf("PPPPPPPP", "AAAAAAAA"), paper("BBBBBBBB", "Second Source"),
                 pdf("QQQQQQQQ", "BBBBBBBB"), paper("CCCCCCCC", "Third Source"),
                 pdf("RRRRRRRR", "CCCCCCCC")]
        text = "References\n[1] Author. Learning Better Models Through Examples. doi:10.1234/model.\n[2] Author. Shared External Paper With Enough Words."
        first = paper_map.collect_snapshot(Zotero(items, {key: text for key in ("PPPPPPPP", "QQQQQQQQ", "RRRRRRRR")}).get, [])
        matched = next(item for item in first["recommendations"] if item["matchedKey"] == "AAAAAAAA")
        self.assertEqual(matched["citingKeys"], ["BBBBBBBB", "CCCCCCCC"])
        later = Zotero(items + [paper("DDDDDDDD", "Shared External Paper With Enough Words")])
        refreshed = paper_map.collect_snapshot(later.get, first["papers"])
        self.assertEqual([path for path, _ in later.calls], ["/items"])
        external = next(item for item in refreshed["recommendations"] if item["matchedKey"] == "DDDDDDDD")
        self.assertEqual(external["citationCount"], 3)
        self.assertEqual(external["id"], "zotero:DDDDDDDD")

    def test_paginates_whole_library_and_reports_missing_pdfs(self):
        zotero = Zotero([
            paper("AAAAAAAA", "First paper"), pdf("DDDDDDDD", "AAAAAAAA"),
            paper("BBBBBBBB", "Second paper"), paper("CCCCCCCC", "Third paper"),
            {"key": "NNNNNNNN", "data": {"itemType": "note"}},
        ])
        events = []
        with patch.object(paper_map, "PAGE_SIZE", 2):
            result = paper_map.collect_snapshot(zotero.get, [], events.append)
        self.assertEqual([int(params["start"]) for path, params in zotero.calls
                          if path == "/items" and params["limit"] == "2"], [0, 2, 4])
        self.assertEqual(result["stats"]["papers"], 3)
        self.assertEqual(result["stats"]["no_pdf"], 2)
        self.assertEqual(result["stats"]["no_text"], 1)
        self.assertEqual(result["citations"], [])
        self.assertEqual(events[-1]["current"], 3)

    def test_references_point_from_cited_to_citing_with_evidence(self):
        zotero = Zotero([
            paper("AAAAAAAA", "A new work on useful science"), pdf("PPPPPPPP", "AAAAAAAA"),
            paper("BBBBBBBB", "Attention Is All You Need", DOI="https://doi.org/10.1234/attention"),
            paper("CCCCCCCC", "Generalized Multi Query Attention", url="https://arxiv.org/abs/2305.13245v2"),
        ], {"PPPPPPPP": "Body\n\n\fReferences\n[1] Vaswani et al. Attention Is All You Need. doi:10.1234/attention.\n[2] Ainslie et al. arXiv:2305.13245v1.\nA Appendix\nMore prose"})
        result = paper_map.collect_snapshot(zotero.get, [])
        self.assertEqual([(edge["fromKey"], edge["toKey"], edge["method"]) for edge in result["citations"]], [
            ("BBBBBBBB", "AAAAAAAA", "doi"), ("CCCCCCCC", "AAAAAAAA", "arxiv"),
        ])
        self.assertIn("Vaswani", result["citations"][0]["evidence"])
        self.assertEqual(result["citations"][0]["attachmentKey"], "PPPPPPPP")
        self.assertEqual(result["papers"][0]["referenceAnalysis"]["matchedCount"], 2)
        self.assertEqual(result["papers"][0]["referenceAnalysis"]["status"], "complete")

    def test_title_normalization_and_no_body_or_appendix_edges(self):
        zotero = Zotero([
            paper("AAAAAAAA", "Source Paper With A Long Name"), pdf("PPPPPPPP", "AAAAAAAA"),
            paper("BBBBBBBB", "Attention Is All You Need"),
            paper("CCCCCCCC", "Training Generalized Multi-Query Transformer Models"),
            paper("DDDDDDDD", "Only Found In The Appendix"),
        ], {"PPPPPPPP": "Attention Is All You Need.\nReferences\n[1] Ainslie et al. Training generalized multi-query trans-\nformer models. In proceedings.\nAppendix A\nOnly Found In The Appendix.\n"})
        result = paper_map.collect_snapshot(zotero.get, [])
        self.assertEqual([(x["fromKey"], x["method"]) for x in result["citations"]], [("CCCCCCCC", "title")])

    def test_missing_reference_heading_does_not_infer_citations(self):
        zotero = Zotero([paper("AAAAAAAA", "Source"), pdf("PPPPPPPP", "AAAAAAAA"),
                         paper("BBBBBBBB", "Attention Is All You Need", DOI="10.1234/abc")],
                        {"PPPPPPPP": "Body cites Attention Is All You Need. doi:10.1234/abc"})
        result = paper_map.collect_snapshot(zotero.get, [])
        self.assertEqual(result["citations"], [])
        self.assertEqual(result["papers"][0]["referenceAnalysis"]["status"], "no_references")

    def test_longer_titles_short_titles_and_ambiguous_identifiers_do_not_match(self):
        zotero = Zotero([
            paper("AAAAAAAA", "Source"), pdf("PPPPPPPP", "AAAAAAAA"),
            paper("BBBBBBBB", "Attention Is All You Need"), paper("CCCCCCCC", "Training Models"),
            paper("DDDDDDDD", "Duplicate entry one long title", DOI="10.1234/same"),
            paper("EEEEEEEE", "Duplicate entry two long title", DOI="10.1234/same"),
        ], {"PPPPPPPP": "References\n[1] Author. Attention Is All You Need For Retrieval.\n[2] Author. Beyond Attention Is All You Need.\n[3] Training Models.\n[4] doi:10.1234/same.\n[5] Author. Attention Is All You Need: A New Approach.\n[6] Beyond: Attention Is All You Need.\n"})
        self.assertEqual(paper_map.collect_snapshot(zotero.get, [])["citations"], [])

    def test_cache_rematches_references_when_new_library_paper_arrives(self):
        source = paper("AAAAAAAA", "Source")
        attachment = pdf("PPPPPPPP", "AAAAAAAA")
        first = Zotero([source, attachment], {"PPPPPPPP": "References\n[1] Author. Attention Is All You Need.\n"})
        snapshot = paper_map.collect_snapshot(first.get, [])
        later = Zotero([source, attachment, paper("BBBBBBBB", "Attention Is All You Need")])
        refreshed = paper_map.collect_snapshot(later.get, snapshot["papers"])
        self.assertEqual([path for path, _ in later.calls], ["/items"])
        self.assertEqual(refreshed["stats"]["cachedAttachments"], 1)
        self.assertEqual(refreshed["citations"][0]["fromKey"], "BBBBBBBB")
        changed = Zotero([source, pdf("PPPPPPPP", "AAAAAAAA", 2)], {"PPPPPPPP": "References\n[1] Something else.\n"})
        revised = paper_map.collect_snapshot(changed.get, snapshot["papers"])
        self.assertEqual(revised["stats"]["cachedAttachments"], 0)
        self.assertIn(("/items/PPPPPPPP/fulltext", None), changed.calls)

    def test_partial_and_failed_extraction_are_retried(self):
        items = [paper("AAAAAAAA", "Source"), pdf("PPPPPPPP", "AAAAAAAA"), pdf("QQQQQQQQ", "AAAAAAAA")]
        first = Zotero(items, {"PPPPPPPP": {"content": "References\n[1] Some work.\n", "indexedPages": 5, "totalPages": 10}})
        snapshot = paper_map.collect_snapshot(first.get, [])
        self.assertEqual(snapshot["papers"][0]["referenceAnalysis"]["status"], "partial")
        later = Zotero(items, {"PPPPPPPP": "References\n[1] Some work.\n", "QQQQQQQQ": "References\n[1] Another work.\n"})
        refreshed = paper_map.collect_snapshot(later.get, snapshot["papers"])
        self.assertEqual(refreshed["stats"]["analyzedAttachments"], 2)
        self.assertEqual(refreshed["papers"][0]["referenceAnalysis"]["status"], "complete")

    def test_library_error_aborts_snapshot(self):
        with self.assertRaises(ConnectionError):
            paper_map.collect_snapshot(lambda *_: (_ for _ in ()).throw(ConnectionError("offline")), [])
        with self.assertRaises(ValueError):
            paper_map.collect_snapshot(lambda *_: {"invalid": "response"}, [])

    def test_letter_appendix_boundaries_do_not_include_body_references(self):
        for heading in ("A Experimental Details", "A.1 Additional Results", "附录A 实验细节"):
            with self.subTest(heading=heading):
                text = "References\n[1] Author. Original Paper Title Is Here.\n\n\f" + heading + "\nBody doi:10.1234/appendix."
                section = paper_map.reference_section(text)
                self.assertIn("Original Paper", section)
                self.assertNotIn("10.1234/appendix", section)
        self.assertIn("A. Smith", paper_map.reference_section(
            "References\n[1] A. Smith, J. Jones. Original Paper Title Is Here.\n"))

    def test_duplicate_titles_self_links_and_non_paper_entries(self):
        zotero = Zotero([
            paper("AAAAAAAA", "Source Paper With A Long Title", DOI="10.1234/self"),
            pdf("PPPPPPPP", "AAAAAAAA"),
            paper("BBBBBBBB", "Attention Is All You Need"),
            paper("CCCCCCCC", "Attention Is All You Need"),
            paper("DDDDDDDD", "Deleted Paper With Long Title", deleted=True, DOI="10.1234/deleted"),
            {"key": "EEEEEEEE", "data": {"itemType": "annotation"}},
            {"key": "FFFFFFFF", "data": {"itemType": "attachment", "parentItem": "BBBBBBBB", "contentType": "text/html"}},
        ], {"PPPPPPPP": "References\n[1] Attention Is All You Need.\n[2] doi:10.1234/self.\n[3] doi:10.1234/deleted.\n"})
        result = paper_map.collect_snapshot(zotero.get, [])
        self.assertEqual(result["stats"]["papers"], 3)
        self.assertEqual(result["citations"], [])
        self.assertEqual(result["papers"][1]["referenceAnalysis"]["status"], "no_pdf")

    def test_unknown_index_coverage_is_partial_and_retried(self):
        items = [paper("AAAAAAAA", "Source"), pdf("PPPPPPPP", "AAAAAAAA")]
        for coverage in ({}, {"indexedPages": 0, "totalPages": 0}, {"indexedPages": -1, "totalPages": 2}):
            with self.subTest(coverage=coverage):
                first = Zotero(items, {"PPPPPPPP": {"content": "References\n[1] Some work.", **coverage}})
                snapshot = paper_map.collect_snapshot(first.get, [])
                self.assertEqual(snapshot["stats"]["partial"], 1)
                attachment = snapshot["papers"][0]["referenceAnalysis"]["attachments"][0]
                self.assertIn("indexedPages", attachment)
                self.assertIn("totalPages", attachment)
                later = Zotero(items, {"PPPPPPPP": "References\n[1] Some work."})
                self.assertEqual(paper_map.collect_snapshot(later.get, snapshot["papers"])["stats"]["analyzedAttachments"], 1)

    def test_library_disconnect_during_fulltext_aborts_snapshot(self):
        calls = []
        def disconnected(path, params=None):
            calls.append(path)
            if len(calls) == 1:
                return [paper("AAAAAAAA", "Source"), pdf("PPPPPPPP", "AAAAAAAA")]
            raise ConnectionError("无法连接 Zotero。")
        with self.assertRaises(ConnectionError):
            paper_map.collect_snapshot(disconnected, [])
        self.assertEqual(calls, ["/items", "/items/PPPPPPPP/fulltext", "/items"])

    def test_attachment_404_remains_coverage_gap_if_library_is_available(self):
        zotero = Zotero([paper("AAAAAAAA", "Source"), pdf("PPPPPPPP", "AAAAAAAA")])
        result = paper_map.collect_snapshot(zotero.get, [])
        self.assertEqual(result["stats"]["no_text"], 1)
        self.assertEqual(zotero.calls[-1], ("/items", {"limit": "1", "start": "0"}))


if __name__ == "__main__":
    unittest.main()
