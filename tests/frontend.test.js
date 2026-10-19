const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appSource = readFileSync(resolve(__dirname, "../static/app.js"), "utf8");
const i18nSource = readFileSync(resolve(__dirname, "../static/i18n.js"), "utf8");
const sourceUrl = "zotero://open-pdf/library/items/ABCD1234?page=4&annotation=EFGH5678";

function fixture() {
  return {
    settings: { language: "zh" },
    lines: [{ id: "l1", title: "Research", ideaIds: ["i1", "i2"], activeIdeaId: "i1" }],
    ideas: ["i1", "i2"].map((id) => ({ id, title: id, kind: "concept", status: "inbox", summary: "Saved note", mechanism: "", thoughts: "" })),
    papers: [{ id: "p1", title: "Paper", zoteroUrl: "zotero://select/library/items/ABCD1234" }],
    edges: [{ id: "e1", fromType: "paper", fromId: "p1", toId: "i1", relation: "uses", sourceUrl }],
    sessions: [],
  };
}

// Small fixtures for application logic; these tests do not run a browser or check layout.
function createApp(storage = new Map(), clock = { now: 0 }, bootFetch = () => new Promise(() => {})) {
  const nodes = new Map();
  const documentListeners = new Map();
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      id: selector.slice(1), value: "", innerHTML: "", textContent: "", dataset: {}, open: false,
      listeners: {}, classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      focus() {},
      click() { this.clickCount = (this.clickCount || 0) + 1; },
      close() { this.open = false; this.listeners.close?.(); },
      showModal() { this.open = true; },
    });
    return nodes.get(selector);
  }
  const context = vm.createContext({
    document: {
      documentElement: { style: { setProperty(key, value) { this[key] = value; } } },
      querySelector: node,
      querySelectorAll: (selector) => selector === "dialog" ? [node("#session-dialog")] : [],
      addEventListener(type, callback, options) {
        const callbacks = [...(documentListeners.get(type)?.callbacks || []), callback];
        documentListeners.set(type, { callback, callbacks, options });
      },
    },
    window: { addEventListener() {} },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    FormData: class { constructor(form) { this.form = form; } entries() { return Object.entries(this.form.values); } },
    Date: class extends Date { static now() { return clock.now; } },
    fetch: bootFetch,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    PaperLineI18n: { translate: (value) => value, apply() {} },
  });
  vm.runInContext(appSource, context);
  const app = vm.runInContext(`({ ui, openDialog, openIdeaDialog, ideaDialogDraftKey, captureDialogDraft, openSession, closeDialog, stopTimer, sessionSeconds, captureIdeaDraft, searchIdeas, selectIdea, latestSession, readingRecap, sessionHistory,
    paperRelationRank, editableEdge, timelineLayout, stageContributions, selectTimelineStage, renderStageInspector, rememberTimelineViewport, restoreTimelineViewport, paperPickerResults, removeStageContribution, queueContributionAction, fitMethodGraph, switchWorkspaceView, methods, methodChoices, paperIdeaEdges, stagePaperEdges, workspaceDraft, submitWorkspaceForm, renderMethodsWorkspace, renderStageLine, renderPaperInspector, openStageSession, sessionDraftKey, graphZoomHint, setPageZoom, zoomGraph, zoomGraphWheel, graphMarkup, orderedMapPapers, paperMapLayout, updatePaperSelection, syncInspectorLayout, syncSelection, graphNode, displayAuthors, paperInstitution, libraryCitationCounts, rankedRecommendations, renderRecommendations, openPaperLineDialog, paperReadStatus, mapPapers, validCitations, renderPaperMap, renderPaperMapResults, renderMapInspector, renderZoteroSync, applyZoteroSync, refreshZoteroSync, startZoteroSync, markPaper, renderIdeaInspector, renderInspector, renderIdeas, renderPaperResults, searchResult, searchPapers, searchLines, searchEverything, markIdea, toast, readDraft, act, refreshState, formatDuration, readingTotal, renderOutline, setState(value) { state = value; } })`, context);
  app.setState(fixture());
  app.ui.selectedLineId = "l1";
  return { app, node, context, storage, clock, documentListeners };
}

test("Continue later and a page reload preserve notes and elapsed time without counting the break", () => {
  const first = createApp();
  first.app.openSession("i1");
  first.node("#session-note").value = "Understand the reward.\nNext: variance.";
  first.node("#session-next-question").value = "What if the variance is zero?";
  first.clock.now = 72_000;
  first.app.closeDialog(first.node("#session-dialog"));
  first.clock.now += 3_600_000;
  const reloaded = createApp(first.storage, first.clock);
  reloaded.app.openSession("i1");
  assert.equal(reloaded.node("#session-time").textContent, "01:12");
  assert.equal(reloaded.node("#session-note").value, "Understand the reward.\nNext: variance.");
  assert.equal(reloaded.node("#session-next-question").value, "What if the variance is zero?");
  reloaded.clock.now += 8_000;
  assert.equal(reloaded.app.sessionSeconds(), 80);
});

test("the reading shortcut preserves the Zotero annotation query parameters", () => {
  const { app, node } = createApp();
  app.openSession("i1");
  assert.equal(node("#session-zotero").href, sourceUrl);
});

test("saving a reading session clears its draft only after the server accepts it", async () => {
  const { app, node, context } = createApp();
  app.openSession("i1");
  node("#session-note").value = "My reading notes";
  context.fetch = async () => ({ ok: false, json: async () => ({ error: "Failed" }) });
  await node("#session-form").listeners.submit({ preventDefault() {} });
  assert.equal(node("#session-dialog").open, true);
  assert.equal(node("#session-note").value, "My reading notes");
  context.fetch = async () => ({ ok: true, json: async () => ({ state: fixture(), result: { lineId: "l1", ideaId: "i1" } }) });
  await node("#session-form").listeners.submit({ preventDefault() {} });
  assert.equal(node("#session-dialog").open, false);
  app.openSession("i1");
  assert.equal(node("#session-note").value, "");
  assert.equal(app.sessionSeconds(), 0);
});

test("card drafts survive selection changes, rerenders, and a reload", () => {
  const first = createApp();
  const values = { title: "i1", kind: "concept", status: "learning", summary: "Unsaved <insight>", mechanism: "Equation", thoughts: "Question" };
  first.app.captureIdeaDraft({ dataset: { id: "i1" }, values });
  first.app.ui.selectedIdeaId = "i2";
  first.app.renderInspector();
  assert.doesNotMatch(first.node("#inspector").innerHTML, /Unsaved/);
  const reloaded = createApp(first.storage);
  reloaded.app.ui.selectedIdeaId = "i1";
  reloaded.app.renderMethodsWorkspace();
  assert.match(reloaded.node("#main-view").innerHTML, /Unsaved &lt;insight&gt;/);
  assert.match(reloaded.node("#main-view").innerHTML, /value="learning" checked/);
});

test("a pending session save cannot be submitted twice or close a different session", async () => {
  const { app, node, context } = createApp();
  app.openSession("i1");
  node("#session-note").value = "My note";
  let finish;
  let requests = 0;
  context.fetch = () => { requests += 1; return new Promise((resolve) => { finish = resolve; }); };
  const submit = () => node("#session-form").listeners.submit({ preventDefault() {} });
  const pending = submit();
  await submit();
  app.closeDialog(node("#session-dialog"));
  app.openSession("i2");
  assert.equal(requests, 1);
  assert.equal(node("#session-dialog").open, true);
  assert.equal(app.ui.session.ideaId, "i1");
  assert.equal(node("#session-note").disabled, true);
  finish({ ok: true, json: async () => ({ state: fixture(), result: { ideaId: "i1" } }) });
  await pending;
  assert.equal(node("#session-note").disabled, false);
  assert.equal(node("#session-dialog").open, false);
});

test("an edit made while a save is in flight remains a draft", async () => {
  const { app, context } = createApp();
  const values = { title: "i1", kind: "concept", status: "learning", summary: "First edit", mechanism: "", thoughts: "" };
  app.captureIdeaDraft({ dataset: { id: "i1" }, values });
  let finish;
  context.fetch = () => new Promise((resolve) => { finish = resolve; });
  const saving = app.act("idea.update", { id: "i1", ...values });
  app.captureIdeaDraft({ dataset: { id: "i1" }, values: { ...values, summary: "Second edit" } });
  finish({ ok: true, json: async () => ({ state: fixture(), result: { ideaId: "i1" } }) });
  await saving;
  assert.equal(app.readDraft("idea:i1").summary, "Second edit");
  context.fetch = async () => ({ ok: true, json: async () => ({ state: fixture(), result: { ideaId: "i1" } }) });
  await app.act("idea.update", { id: "i1", ...values, summary: "Second edit" });
  assert.equal(app.readDraft("idea:i1"), null);
});

test("language switching translates graph labels while preserving user content", () => {
  const makeText = (text, user = false) => ({ nodeValue: text, parentElement: { closest: () => user ? {} : null } });
  const nodes = [makeText("设置"), makeText("设置", true), makeText("基础概念 · 正在学"), makeText("→ 依赖")];
  const context = vm.createContext({
    document: {
      documentElement: {},
      createTreeWalker() {
        let index = -1;
        return { nextNode: () => ++index < nodes.length, get currentNode() { return nodes[index]; } };
      },
    },
    NodeFilter: { SHOW_TEXT: 4 },
  });
  vm.runInContext(i18nSource, context);
  const root = { querySelectorAll: () => [] };
  context.PaperLineI18n.apply(root, "en");
  assert.deepEqual(nodes.map((node) => node.nodeValue), ["Settings", "设置", "Core concept · Learning", "→ Depends on"]);
  context.PaperLineI18n.apply(root, "zh");
  assert.deepEqual(nodes.map((node) => node.nodeValue), ["设置", "设置", "基础概念 · 正在学", "→ 依赖"]);
});

test("idea search matches normalized names, aliases, and note content", () => {
  const { app } = createApp();
  const data = fixture();
  Object.assign(data.ideas[0], { title: "GRPO", aliases: ["Group Relative Policy Optimization"], mechanism: "组内奖励归一化" });
  data.ideas[1].summary = "Compare GRPO with PPO";
  app.setState(data);
  assert.equal(app.searchIdeas("ＧＲＰＯ")[0].id, "i1");
  assert.equal(app.searchIdeas("relative POLICY")[0].id, "i1");
  assert.equal(app.searchIdeas("奖励归一化")[0].id, "i1");
  assert.equal(app.searchIdeas("GRPO", "i1")[0].id, "i2");
  assert.equal(app.searchIdeas("not present").length, 0);
});

test("reading recap selects the latest saved session and keeps its next question", () => {
  const { app, node } = createApp();
  const data = fixture();
  data.sessions = [
    { ideaId: "i1", createdAt: "2026-09-24T12:00:00Z", note: "Latest <insight>", nextQuestion: "Which baseline?" },
    { ideaId: "i1", createdAt: "2026-09-23T12:00:00Z", note: "Old note" },
    { ideaId: "i2", createdAt: "2026-09-25T12:00:00Z", note: "Another card" },
  ];
  app.setState(data);
  app.openSession("i1");
  assert.match(node("#session-recap").innerHTML, /Latest &lt;insight&gt;/);
  assert.match(node("#session-recap").innerHTML, /Which baseline\?/);
  assert.doesNotMatch(node("#session-recap").innerHTML, /Old note|Another card/);
  assert.equal(node("#session-note").value, "");
});

test("an idea outside every reading path can still be opened from the library", () => {
  const { app, node } = createApp();
  const data = fixture();
  data.lines[0].ideaIds = ["i1"];
  app.setState(data);
  app.selectIdea("i2");
  assert.equal(app.ui.selectedLineId, "");
  assert.equal(app.ui.selectedIdeaId, "i2");
  assert.match(node("#main-view").innerHTML, /这张思想卡还没有加入阅读线/);
});

test("one click on a status button saves the card and keeps unsaved text as a draft", async () => {
  const { app, context } = createApp();
  const values = { title: "i1", kind: "concept", status: "inbox", summary: "Unsaved text", mechanism: "", thoughts: "" };
  app.captureIdeaDraft({ dataset: { id: "i1" }, values });
  const sent = [];
  context.fetch = async (_path, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ state: fixture(), result: { ideaId: "i1" } }) };
  };
  await app.markIdea("i1", "status", "learning");
  assert.deepEqual(sent, [{ action: "idea.mark", payload: { id: "i1", status: "learning" } }]);
  const draft = app.readDraft("idea:i1");
  assert.equal(draft.summary, "Unsaved text");
  assert.equal(draft.status, "learning");
});

test("the paper library matches titles, authors, years, and DOIs", () => {
  const { app } = createApp();
  const data = fixture();
  data.papers = [
    { id: "p1", title: "GRPO for reasoning", authors: "Zhang", year: "2024", doi: "10.1/a" },
    { id: "p2", title: "PPO baseline", authors: "Li", year: "2019", doi: "10.2/b" },
  ];
  app.setState(data);
  assert.deepEqual(app.searchPapers("ｇｒｐｏ").map((item) => item.id), ["p1"]);
  assert.deepEqual(app.searchPapers("2019").map((item) => item.id), ["p2"]);
  assert.deepEqual(app.searchPapers("10.2/B").map((item) => item.id), ["p2"]);
  assert.equal(app.searchPapers("not present").length, 0);
});

test("a status filter narrows the search to idea cards", () => {
  const { app, node } = createApp();
  const data = fixture();
  data.ideas[0].status = "learning";
  data.ideas[1].status = "understood";
  app.setState(data);
  app.ui.ideaStatus = "learning";
  app.renderIdeas();
  assert.match(node("#idea-search-results").innerHTML, /1 条结果/);
  assert.match(node("#main-view").innerHTML, /data-status="learning"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(node("#idea-search-results").innerHTML, /type-tag (line|paper)/);
  app.ui.ideaStatus = "";
  app.renderIdeas();
  assert.match(node("#idea-search-results").innerHTML, /4 条结果/);
});

test("one search covers reading paths, idea cards, and papers, each tagged by type", () => {
  const { app, node } = createApp();
  const data = fixture();
  data.lines[0].title = "如何稳定策略更新";
  data.lines[0].question = "policy 更新为什么会崩";
  data.ideas[0].title = "策略梯度";
  data.ideas[1].title = "无关卡片";
  data.papers[0].title = "Stable policy updates";
  app.setState(data);

  // Array.from 把跨 realm 的数组搬回当前 realm，否则 deepEqual 会比较原型。
  assert.deepEqual(Array.from(app.searchEverything("策略"), (hit) => hit.kind), ["line", "idea"]);
  assert.deepEqual(Array.from(app.searchEverything("policy"), (hit) => hit.kind), ["line", "paper"]);
  assert.deepEqual(app.searchLines("崩").map((item) => item.id), ["l1"]);

  app.ui.ideaQuery = "策略";
  app.renderIdeas();
  const html = node("#idea-search-results").innerHTML;
  assert.match(html, /class="search-result line"[^>]*data-kind="line"/);
  assert.match(html, /class="search-result idea"[^>]*data-kind="idea"/);
  assert.match(html, /<span class="type-tag line">阅读线<\/span>/);
  assert.match(html, /<span class="type-tag idea">思想卡<\/span>/);
});

test("the top bar offers help and the guide covers every section", () => {
  const html = readFileSync(resolve(__dirname, "../static/index.html"), "utf8");
  assert.match(html, /data-action="open-help"[^>]*>帮助</);
  assert.match(html, /<dialog id="help-dialog"/);
  for (const heading of ["三个概念", "五步上手", "每天怎么用", "配合 Zotero", "导出到 Obsidian", "数据与删除", "快捷键"]) {
    assert.ok(html.includes(`<h3>${heading}</h3>`), `缺少章节：${heading}`);
  }
  assert.match(appSource, /action === "open-help"/);
  assert.match(appSource, /event\.key === "\?"/);
});

test("toasts rise above an open dialog so settings feedback stays visible", () => {
  const { app, node, context } = createApp();
  const appended = [];
  const dialog = { appendChild(child) { appended.push(child); child.parentElement = dialog; } };
  const toastNode = node("#toast");
  let open = false;
  const calls = [];
  Object.assign(toastNode, {
    parentElement: null, offsetWidth: 0, matches: () => open,
    showPopover() { open = true; calls.push("show"); },
    hidePopover() { open = false; calls.push("hide"); },
  });
  context.document.querySelector = (selector) => selector === "dialog[open]" ? dialog : node(selector);
  app.toast("WebDAV 连接正常。");
  app.toast("已上传到 WebDAV。");
  assert.equal(appended.length, 1);
  assert.deepEqual(calls, ["show", "hide", "show"]);
  assert.equal(toastNode.textContent, "已上传到 WebDAV。");
});

test("reading time adds up per card and per reading path", () => {
  const { app, node } = createApp();
  const data = fixture();
  data.sessions = [
    { ideaId: "i1", createdAt: "2026-09-29T12:00:00Z", note: "a", durationSeconds: 1500 },
    { ideaId: "i1", createdAt: "2026-09-30T12:00:00Z", note: "b", durationSeconds: 2400 },
    { ideaId: "i2", createdAt: "2026-09-30T13:00:00Z", note: "c", durationSeconds: 300 },
  ];
  app.setState(data);
  assert.equal(app.formatDuration(20), "不到 1 分钟");
  assert.equal(app.formatDuration(3900), "1 小时 5 分钟");
  assert.equal(app.readingTotal(["i1"]).count, 2);
  app.renderIdeaInspector(data.ideas[0]);
  assert.match(node("#inspector").innerHTML, /累计阅读 1 小时 5 分钟 · 2 次/);
  app.renderOutline(data.lines[0]);
  assert.match(node("#main-view").innerHTML, /累计阅读 1 小时 10 分钟/);
  assert.match(node("#main-view").innerHTML, /data-action="move-idea"[^>]*data-offset="-1"[^>]*disabled/);
});

test("a stale draft remembers the version it started from", async () => {
  const { app, context } = createApp();
  const data = fixture();
  data.ideas[0].updatedAt = "2026-09-30T01:00:00+00:00";
  app.setState(data);
  const values = { title: "i1", kind: "concept", status: "inbox", summary: "本页", mechanism: "", thoughts: "" };
  app.captureIdeaDraft({ dataset: { id: "i1" }, values });
  assert.equal(app.readDraft("idea:i1").baseUpdatedAt, "2026-09-30T01:00:00+00:00");
  // 测试替身对任何选择器都返回节点；这里声明没有打开的弹窗。
  const fallback = context.document.querySelector;
  context.document.querySelector = (selector) => selector === "dialog[open]" ? null : fallback(selector);
  let polled = 0;
  context.fetch = async () => { polled += 1; return { ok: true, json: async () => data }; };
  assert.equal(await app.refreshState(), false);
  assert.equal(polled, 1);
  const newer = { ...data, ideas: [{ ...data.ideas[0], summary: "别处改的" }, data.ideas[1]] };
  context.fetch = async () => ({ ok: true, json: async () => newer });
  assert.equal(await app.refreshState(), true);
});

function mapFixture() {
  const data = fixture();
  data.lines = []; data.ideas = []; data.edges = [];
  data.papers = [
    { id: "b", title: "Earlier <paper>", year: "2020", readStatus: "read" },
    { id: "a", title: "Citing paper", year: "2022", referenceAnalysis: { status: "partial", message: "Only one PDF readable" } },
    { id: "isolated", title: "Isolated paper", year: "2022" },
  ];
  data.citations = [
    { id: "c1", fromId: "b", toId: "a", evidence: "[2] Earlier <paper>", attachmentKey: "PDFKEY" },
    { id: "bad", fromId: "gone", toId: "a" },
    { id: "self", fromId: "a", toId: "a" },
  ];
  return data;
}

test("paper map retains isolated papers and directs cited B toward citing A with escaped evidence", () => {
  const { app, node } = createApp();
  app.setState(mapFixture()); app.ui.view = "map"; app.ui.selectedPaperId = "a";
  app.renderPaperMap();
  const svg = node("#paper-map-results").innerHTML;
  assert.match(svg, /data-from-id="b" data-to-id="a"/);
  assert.match(svg, /marker-end="url\(#citation-arrow\)"/);
  assert.doesNotMatch(svg, /data-id="isolated"/);
  app.ui.selectedPaperId = ""; app.renderPaperMapResults();
  assert.match(node("#paper-map-results").innerHTML, /data-id="isolated"/);
  assert.doesNotMatch(svg, /data-from-id="gone"/);
  assert.equal(app.validCitations().length, 1);
  app.renderMapInspector(mapFixture().papers[1]);
  const inspector = node("#inspector").innerHTML;
  assert.match(inspector, /引用的论文 <span>1/);
  assert.match(inspector, /引用它的论文 <span>0/);
  assert.match(inspector, /参考文献分析不完整/);
  assert.match(inspector, /Earlier &lt;paper&gt;/);
  assert.match(inspector, /zotero:\/\/open-pdf\/library\/items\/PDFKEY/);
  assert.match(inspector, /没有连线不代表没有引用/);
  app.renderMapInspector(mapFixture().papers[0]);
  assert.match(node("#inspector").innerHTML, /引用它的论文 <span>1/);
});

test("paper map search and read filters include old papers as unread and keep only visible edges", () => {
  const { app, node } = createApp(); app.setState(mapFixture()); app.ui.view = "map";
  app.ui.mapStatus = "unread";
  assert.deepEqual(Array.from(app.mapPapers(), (item) => item.id), ["a", "isolated"]);
  app.renderPaperMap(); assert.doesNotMatch(node("#paper-map-results").innerHTML, /class="citation-link/);
  app.ui.mapQuery = "isolated";
  assert.deepEqual(Array.from(app.mapPapers(), (item) => item.id), ["isolated"]);
  app.ui.mapStatus = "read"; app.renderPaperMap();
  assert.match(node("#paper-map-results").innerHTML, /没有符合筛选条件/);
});

test("a 91-paper map uses a bounded-width ranking grid", () => {
  const { app, node } = createApp(); const data = mapFixture();
  data.papers = Array.from({ length: 91 }, (_, index) => ({ id: `p${index}`, title: `Paper ${index}`, year: "2026" }));
  data.citations = []; app.setState(data); app.ui.view = "map"; app.renderPaperMap();
  const svg = node("#paper-map-results").innerHTML;
  assert.match(svg, /viewBox="0 0 1350 3484"/);
  assert.equal((svg.match(/class="map-node /g) || []).length, 91);
});

test("read marks persist through server state and later synchronization", async () => {
  const { app, context, node } = createApp(); app.setState(mapFixture()); app.ui.view = "map"; app.ui.selectedPaperId = "a";
  const persisted = mapFixture(); persisted.papers[1].readStatus = "read";
  let request;
  context.fetch = async (url, options) => {
    if (url === "/api/action") { request = JSON.parse(options.body); return { ok: true, json: async () => ({ state: persisted, result: { paperId: "a" } }) }; }
    return { ok: true, json: async () => persisted };
  };
  vm.runInContext("noteLocalChange = () => {};", context);
  await app.markPaper("a", "read");
  assert.deepEqual(request, { action: "paper.mark", payload: { id: "a", readStatus: "read" } });
  assert.match(node("#inspector").innerHTML, /标记为未读/);
  await app.applyZoteroSync({ status: "complete", result: { stats: { papers: 3, complete: 1, partial: 1, no_pdf: 1 } } });
  assert.equal(app.paperReadStatus(app.mapPapers().find((item) => item.id === "a")), "read");
  assert.match(node("#paper-map-sync").innerHTML, /部分分析 1/);
});

test("sync reports progress, terminal errors, and retries a failed completion state fetch", async () => {
  const { app, context, node } = createApp(); app.setState(mapFixture()); app.ui.view = "map";
  await app.applyZoteroSync({ status: "running", processed: 2, total: 9, title: "Current <PDF>", message: "Extracting references" });
  assert.match(node("#paper-map-sync").innerHTML, /value="2"/);
  assert.match(node("#paper-map-sync").innerHTML, /Current &lt;PDF&gt;/);
  assert.match(node("#paper-map-sync").innerHTML, /disabled/);
  await app.applyZoteroSync({ status: "error", error: "Zotero offline" });
  assert.match(node("#paper-map-sync").innerHTML, /Zotero offline/);
  assert.doesNotMatch(node("#paper-map-sync").innerHTML, /disabled/);
  context.fetch = async (url) => { if (url === "/api/state") throw Error("State unavailable"); return { ok: true, json: async () => ({ status: "complete" }) }; };
  await app.refreshZoteroSync();
  assert.match(node("#paper-map-sync").innerHTML, /State unavailable/);
  context.fetch = async (url) => ({ ok: true, json: async () => url === "/api/state" ? mapFixture() : { status: "complete" } });
  await app.refreshZoteroSync();
  assert.doesNotMatch(node("#paper-map-sync").innerHTML, /State unavailable/);
});

test("map ranks distinct citing papers, keeps no edges until selected, and can show all", () => {
  const { app, node } = createApp(); const data = mapFixture();
  data.citations.push({ id: "copy", fromId: "b", toId: "a" }, { id: "extra", fromId: "b", toId: "isolated" });
  app.setState(data); app.ui.view = "map";
  assert.equal(app.libraryCitationCounts().get("b"), 2);
  app.renderPaperMap();
  let html = node("#paper-map-results").innerHTML;
  assert.doesNotMatch(html, /class="citation-link/);
  assert.ok(html.indexOf('data-id="b"') < html.indexOf('data-id="a"'));
  assert.match(html, /data-citation-count="2"/);
  app.ui.selectedPaperId = "isolated"; app.renderPaperMapResults();
  html = node("#paper-map-results").innerHTML;
  assert.match(html, /data-from-id="b" data-to-id="isolated"/);
  assert.doesNotMatch(html, /data-from-id="b" data-to-id="a"/);
  app.ui.mapAllConnections = true; app.ui.selectedPaperId = ""; app.renderPaperMapResults();
  assert.match(node("#paper-map-results").innerHTML, /data-from-id="b" data-to-id="a"/);
});

test("institution is escaped on map and library, first three authors do not mutate full metadata", () => {
  const { app, node } = createApp(); const data = mapFixture();
  const item = data.papers[0]; item.institution = 'Lab <script>alert(1)</script>'; item.authors = 'A; B; C; D';
  item.authorNames = ['A', 'B', 'C', 'D']; item.authorCount = 4;
  app.setState(data); app.ui.view = "map"; app.renderPaperMap();
  assert.equal(app.displayAuthors(item), 'A; B; C 等');
  assert.equal(item.authors, 'A; B; C; D');
  assert.match(node("#paper-map-results").innerHTML, /class="map-node-institution" data-user-content>Lab &lt;script&gt;/);
  assert.doesNotMatch(node("#paper-map-results").innerHTML, /<script>/);
  app.renderPaperResults();
  assert.match(node("#paper-search-results").innerHTML, /Lab &lt;script&gt;alert/);
  app.ui.selectedPaperId = item.id; app.renderMapInspector(item);
  assert.match(node("#inspector").innerHTML, /Lab &lt;script&gt;alert/);
  assert.equal(app.paperInstitution({extra: 'Fallback Lab'}), 'Fallback Lab');
  data.settings.language = 'en'; assert.equal(app.displayAuthors(item), 'A; B; C; et al.');
});

test("recommendations rank unique library citing sources and show evidence with safe links", () => {
  const { app, node } = createApp(); const data = mapFixture();
  data.recommendations = [
    { id: 'external', title: 'Shared <paper>', url: 'javascript:alert(1)', citingIds: ['a', 'a', 'isolated', 'missing'], evidence: [{citingId:'a', text:'Raw <reference>', attachmentKey:'PDFKEY'}] },
    { id: 'already-read', title: 'Read paper', matchedPaperId: 'b', citingIds: ['a','isolated'] },
    { id: 'unread', title: 'Unread paper', matchedPaperId: 'a', citingIds: ['b','isolated'] },
  ];
  app.setState(data); app.ui.view = 'recommendations'; app.renderRecommendations();
  assert.deepEqual(Array.from(app.rankedRecommendations(), item => [item.id,item.citationCount]), [['already-read',2],['external',2],['unread',2]]);
  let html = node('#main-view').innerHTML;
  assert.match(html, /被 2 篇库内论文共同引用/);
  assert.match(html, /Raw &lt;reference&gt;/);
  assert.match(html, /zotero:\/\/open-pdf\/library\/items\/PDFKEY/);
  assert.match(html, /尚未入库/); assert.doesNotMatch(html, /javascript:|Read paper/);
  assert.match(html, /非全网引用量/);
  app.ui.recommendationAll = true; app.renderRecommendations(); assert.match(node('#main-view').innerHTML, /Read paper/);
});

test("map bridges to explicit reading-line creation or an existing paper-linked card", async () => {
  const {app,node,context} = createApp(); app.ui.view='map'; app.ui.selectedPaperId='p1';
  app.renderMapInspector(fixture().papers[0]);
  assert.match(node('#inspector').innerHTML, /data-action="paper-add-line"/);
  assert.match(node('#inspector').innerHTML, /data-action="link-paper-to-idea"/);
  assert.match(node('#inspector').innerHTML, /data-action="paper-view-idea" data-id="i1"/);
  app.openPaperLineDialog('p1');
  assert.match(node('#paper-line-idea').innerHTML, /value="i1"/);
  assert.doesNotMatch(node('#paper-line-idea').innerHTML, /value="i2"/);
  node('#paper-line-choice').value='l1'; node('#paper-line-idea').value='i1';
  let request;
  context.fetch=async (url, options) => {request=JSON.parse(options.body); return {ok:true,json:async()=>({state:fixture(),result:{}})};};
  await node('#paper-line-form').listeners.submit({preventDefault(){}});
  assert.equal(request.action,'paper.add_to_line');
  assert.deepEqual(request.payload,{id:'p1',lineId:'l1',ideaId:'i1'});
  assert.equal(app.ui.view,'map');
});

test('map and recommendations wait for explicit selection and thought graph shows institutions', () => {
  const {app} = createApp(); app.setState(mapFixture()); app.ui.view='map'; app.ui.selectedPaperId='';
  app.syncSelection(); assert.equal(app.ui.selectedPaperId,'');
  app.ui.view='recommendations'; app.syncSelection(); assert.equal(app.ui.selectedPaperId,'');
  const html=app.graphNode('paper',{id:'p',title:'Title',institution:'Lab <test>',authors:'A; B; C; D',year:'2026'},35,30,255);
  assert.match(html,/class="graph-node-institution" data-user-content>Lab &lt;test&gt;/);
  assert.match(html,/A; B; C 等/);
  assert.doesNotMatch(html,/<test>/);
});

test('recommendations require two distinct citing papers and mark identifier-only titles unverified', () => {
  const {app,node} = createApp(); const data=mapFixture();
  data.recommendations=[
    {id:'one',title:'Single source',citingIds:['a','a']},
    {id:'pending',title:'Potential wrong title',doi:'10.1000/test',referenceText:'Original <reference>',verification:'identifier_only',citingIds:['a','b'],evidence:[{citingId:'a',text:'Original <reference>'}]},
  ];
  app.setState(data); app.renderRecommendations();
  const html=node('#main-view').innerHTML;
  assert.doesNotMatch(html,/Single source|Potential wrong title/);
  assert.match(html,/标题尚未核实/);
  assert.match(html,/Original &lt;reference&gt;/);
  assert.match(html,/https:\/\/doi.org\/10.1000%2Ftest/);
});


test("map sort switches between chronology and distinct library citations with stable ties", () => {
  const { app, node } = createApp(); const data = mapFixture();
  data.papers.push({ id: "old", title: "Old paper", year: "1990" }, { id: "unknown", title: "Unknown year" });
  data.citations.push({ id: "c2", fromId: "a", toId: "isolated" }, { id: "c3", fromId: "a", toId: "old" });
  app.setState(data); app.ui.view = "map";
  assert.deepEqual(Array.from(app.orderedMapPapers(), (item) => item.id), ["a", "b", "isolated", "old", "unknown"]);
  app.ui.mapSort = "year";
  assert.deepEqual(Array.from(app.orderedMapPapers(), (item) => item.id), ["old", "b", "a", "isolated", "unknown"]);
  app.renderPaperMap();
  assert.match(node("#main-view").innerHTML, /id="map-sort"/);
  assert.match(node("#main-view").innerHTML, /value="year" selected/);
  assert.match(node("#paper-map-results").innerHTML, /按年份从早到晚排序/);
});

test("selected paper focus uses cited-left, current-middle, citing-right and includes neighbors hidden by overview filters", () => {
  const { app, node } = createApp(); const data = mapFixture();
  data.papers.push({ id: "later", title: "Later paper", year: "2024" });
  data.citations.push({ id: "later-cites-a", fromId: "a", toId: "later" });
  app.setState(data); app.ui.view = "map"; app.ui.mapSort = "year"; app.ui.selectedPaperId = "a";
  app.ui.mapStatus = "unread"; app.ui.mapQuery = "Citing paper";
  const layout = app.paperMapLayout();
  assert.deepEqual(Array.from(layout.nodes, (node) => [node.item.id, node.side, node.x]), [["b", "cited", 30], ["a", "current", 360], ["later", "citing", 690]]);
  assert.equal(layout.links.length, 2);
  for (const link of layout.links) assert.ok(link.from.x < link.to.x);
  app.renderPaperMapResults();
  const html = node("#paper-map-results").innerHTML;
  assert.match(html, /它引用的论文/); assert.match(html, /当前论文/); assert.match(html, /引用它的论文/);
  assert.match(html, /搜索和阅读筛选仅作用于全库视图/);
  assert.match(html, /data-action="map-overview"/);
  assert.doesNotMatch(html, /data-id="isolated"/);
  app.ui.selectedPaperId = "isolated";
  assert.deepEqual(Array.from(app.paperMapLayout().nodes, (node) => node.item.id), ["isolated"]);
  app.ui.selectedPaperId = "";
  assert.deepEqual(Array.from(app.paperMapLayout().nodes, (node) => node.item.id), ["a"]);
});

test("year overview groups papers chronologically with prominent year labels and citation arrows by default", () => {
  const { app, node } = createApp(); const data = mapFixture();
  data.papers.push({ id: "unknown", title: "No year" });
  app.setState(data); app.ui.view = "map"; app.ui.mapSort = "year";
  const layout = app.paperMapLayout();
  assert.deepEqual(Array.from(layout.headings, (heading) => heading.label), ["2020", "2022", "年份未知"]);
  const positions = new Map(Array.from(layout.nodes, (node) => [node.item.id, node]));
  assert.ok(positions.get("b").x < positions.get("a").x);
  assert.equal(positions.get("a").x, positions.get("isolated").x);
  assert.notEqual(positions.get("a").y, positions.get("isolated").y);
  assert.ok(positions.get("unknown").x > positions.get("a").x);
  assert.equal(layout.links.length, 1);
  app.renderPaperMapResults();
  assert.match(node("#paper-map-results").innerHTML, /class="map-year">2020/);
  assert.match(node("#paper-map-results").innerHTML, /class="map-year">2022/);
  assert.match(node("#paper-map-results").innerHTML, /data-from-id="b" data-to-id="a"/);
  app.ui.mapTimelineConnections = false;
  assert.equal(app.paperMapLayout().links.length, 0);
});

test("a mutual citation neighbor appears on both sides with distinct keys and both arrows", () => {
  const { app } = createApp(); const data = mapFixture();
  data.citations.push({ id: "reverse", fromId: "a", toId: "b" });
  app.setState(data); app.ui.view = "map"; app.ui.selectedPaperId = "a";
  const layout = app.paperMapLayout();
  assert.deepEqual(Array.from(layout.nodes, (node) => node.key), ["cited:b", "current:a", "citing:b"]);
  assert.deepEqual(Array.from(layout.links, (link) => [link.from.key, link.to.key]), [["cited:b", "current:a"], ["current:a", "citing:b"]]);
});

test("map selection preserves the document and controls while moving only the graph to its focused cluster", () => {
  const { app, node, context } = createApp(); app.setState(mapFixture()); app.ui.view = "map";
  const main = node("#main-view"); main.innerHTML = "existing controls";
  const scroll = node(".paper-map-scroll"); scroll.scrollTop = 720; scroll.scrollLeft = 180; scroll.clientWidth = 510;
  app.ui.mapZoom = 1.4;
  const focusCalls = [], outerScroll = [], classes = new Map();
  const selected = { dataset: { id: "a" }, focus: (options) => focusCalls.push(options) };
  context.document.activeElement = { matches: () => true };
  context.document.querySelectorAll = (selector) => selector === ".map-node" ? [selected] : [];
  context.window.scrollY = 430; context.window.scrollX = 12;
  context.window.scrollTo = (options) => outerScroll.push(options);
  node("#inspector").scrollTop = 580;
  node("#inspector").classList.toggle = (name, enabled) => classes.set(name, enabled);
  app.updatePaperSelection("a");
  assert.equal(main.innerHTML, "existing controls");
  assert.equal(node("#inspector").scrollTop, 0);
  assert.equal(app.ui.selectedPaperId, "a");
  assert.equal(app.ui.mapZoom, .5);
  assert.equal(scroll.scrollTop, 0); assert.equal(scroll.scrollLeft, 0);
  assert.equal(focusCalls[0].preventScroll, true);
  assert.equal(outerScroll[0].top, 430); assert.equal(outerScroll[0].left, 12);
  assert.equal(classes.get("paper-inspector"), true); assert.equal(classes.get("is-open"), true);
  assert.match(node("#inspector").innerHTML, /data-action="close-paper-inspector"/);
  context.document.activeElement = { matches: () => false };
  app.updatePaperSelection("");
  assert.equal(classes.get("is-open"), false);
  assert.equal(app.ui.selectedPaperId, "");
  assert.equal(app.ui.mapZoom, 1.4);
});

function zoomFixture(map = true) {
  const harness = createApp();
  const attributes = {};
  const svg = { viewBox: { baseVal: { width: 1000, height: 800 } }, setAttribute(key, value) { attributes[key] = value; } };
  const scroller = { clientWidth: 500, clientHeight: 400, clientLeft: 2, clientTop: 3, scrollLeft: 300, scrollTop: 200,
    classList: { contains: (name) => map && name === "paper-map-scroll" }, querySelector: () => svg,
    getBoundingClientRect: () => ({ left: 20, top: 30 }) };
  const event = (deltaY, extra = {}) => ({ metaKey: true, cancelable: true, deltaY, deltaMode: 0, clientX: 172, clientY: 133,
    target: { closest: () => scroller }, preventDefault() { this.prevented = true; }, ...extra });
  return { ...harness, scroller, attributes, event };
}
test("Command-wheel zooms each graph around the pointer without rebuilding either view", () => {
  for (const map of [true, false]) {
    const h = zoomFixture(map), key = map ? "mapZoom" : "ideaGraphZoom";
    const before = h.node("#main-view").innerHTML;
    const input = h.event(-100);
    h.app.zoomGraphWheel(input);
    const ratio = Math.exp(.2);
    assert.equal(input.prevented, true);
    assert.ok(Math.abs(h.app.ui[key] - ratio) < 1e-12);
    assert.ok(Math.abs((h.scroller.scrollLeft + 150) / ratio - 450) < 1e-10);
    assert.ok(Math.abs((h.scroller.scrollTop + 100) / ratio - 300) < 1e-10);
    assert.equal(h.attributes.width, 1000 * ratio);
    assert.equal(h.node(map ? "[data-action='map-zoom'][data-step='0']" : "[data-action='idea-zoom'][data-step='0']").textContent, "122%");
    assert.equal(h.node("#main-view").innerHTML, before);
    h.app.zoomGraphWheel(h.event(100));
    assert.ok(Math.abs(h.app.ui[key] - 1) < 1e-12);
  }
});
test("graph zoom handles line/page wheel units, frequent fractional trackpad deltas and clamps", () => {
  const h = zoomFixture();
  h.app.zoomGraphWheel(h.event(-1, { deltaMode: 1 }));
  assert.ok(Math.abs(h.app.ui.mapZoom - Math.exp(.032)) < 1e-12);
  h.app.zoomGraph(h.scroller, 1);
  for (let index = 0; index < 20; index++) h.app.zoomGraphWheel(h.event(-.25));
  assert.ok(Math.abs(h.app.ui.mapZoom - Math.exp(.01)) < 1e-12);
  h.app.zoomGraph(h.scroller, 1);
  h.app.zoomGraphWheel(h.event(-1, { deltaMode: 2 }));
  assert.equal(h.app.ui.mapZoom, 2);
  h.app.zoomGraph(h.scroller, -100);
  assert.equal(h.app.ui.mapZoom, .15);
  assert.equal(h.scroller.scrollLeft >= 0 && h.scroller.scrollTop >= 0, true);
  h.app.zoomGraphWheel(h.event(1000));
  assert.equal(h.app.ui.mapZoom, .15);
  assert.equal(h.app.ui.mapOverviewZoom, .15);
});
test("ordinary wheel, graph-external Command-wheel and uncancelable input keep normal behavior", () => {
  const h = zoomFixture();
  assert.deepEqual(h.documentListeners.get("wheel").options.passive, false);
  for (const input of [h.event(100, { metaKey: false }), h.event(100, { target: { closest: () => null } }), h.event(100, { cancelable: false }), h.event(0), h.event(NaN)]) {
    h.app.zoomGraphWheel(input);
    assert.equal(input.prevented, undefined);
  }
  assert.equal(h.app.ui.mapZoom, 1);
  assert.deepEqual(h.attributes, {});
});
test("zoom button helper uses the same clamp, center anchor and percentage as wheel input", () => {
  const h = zoomFixture();
  h.app.zoomGraph(h.scroller, 1.2);
  assert.equal(h.scroller.scrollLeft, 410);
  assert.equal(h.scroller.scrollTop, 280);
  assert.equal(h.node("[data-action='map-zoom'][data-step='0']").textContent, "120%");
  h.app.zoomGraph(h.scroller, 1);
  assert.equal(h.scroller.scrollLeft, 300);
  assert.equal(h.scroller.scrollTop, 200);
  assert.equal(h.node("[data-action='map-zoom'][data-step='0']").textContent, "100%");
});

test("whole-page zoom clamps, resets and survives reload without changing graph zoom or drafts", () => {
  const h = createApp();
  h.storage.set("paperline-draft:idea:i1", '{"title":"Unsaved"}');
  const view = h.app.ui.view, content = h.node("#main-view").innerHTML;
  h.app.setPageZoom(99);
  assert.equal(h.app.ui.pageZoom, 1.5);
  assert.equal(h.context.document.documentElement.style.zoom, "1.5");
  assert.equal(h.node("[data-page-zoom-percent]").textContent, "150%");
  assert.equal(createApp(h.storage).app.ui.pageZoom, 1.5);
  h.app.setPageZoom(.1);
  assert.equal(h.app.ui.pageZoom, .7);
  h.app.setPageZoom(1);
  assert.equal(h.app.ui.pageZoom, 1);
  assert.equal(h.storage.get("paperline-page-zoom"), "1");
  assert.equal(h.app.ui.mapZoom, 1);
  assert.equal(h.app.ui.ideaGraphZoom, 1);
  assert.equal(h.app.ui.view, view);
  assert.equal(h.node("#main-view").innerHTML, content);
  assert.equal(h.storage.get("paperline-draft:idea:i1"), '{"title":"Unsaved"}');
});
test("Command-wheel preserves the graph point under a scaled whole-page pointer", () => {
  for (const scale of [.7, 1.5]) {
    const h = zoomFixture();
    h.app.setPageZoom(scale);
    h.scroller.offsetWidth = 504; h.scroller.offsetHeight = 406;
    h.scroller.getBoundingClientRect = () => ({ left: 20, top: 30, width: 504 * scale, height: 406 * scale });
    const input = h.event(-100, { clientX: 20 + 152 * scale, clientY: 30 + 103 * scale });
    h.app.zoomGraphWheel(input);
    const ratio = h.app.ui.mapZoom;
    assert.ok(Math.abs((h.scroller.scrollLeft + 150) / ratio - 450) < 1e-10);
    assert.ok(Math.abs((h.scroller.scrollTop + 100) / ratio - 300) < 1e-10);
  }
});

test("Windows uses Ctrl-wheel only inside graphs and renders the corresponding hint", () => {
  for (const map of [true, false]) {
    const h = zoomFixture(map);
    h.context.navigator = { platform: "Win32" };
    const input = h.event(-100, { metaKey: false, ctrlKey: true });
    h.app.zoomGraphWheel(input);
    assert.equal(input.prevented, true);
    assert.ok((map ? h.app.ui.mapZoom : h.app.ui.ideaGraphZoom) > 1);
    assert.equal(h.app.graphZoomHint(), "按住 Ctrl + 滚轮缩放");
    assert.match(h.app.graphMarkup({ id: "i1", title: "Card", kind: "concept", status: "inbox" }), /按住 Ctrl \+ 滚轮缩放/);
    for (const ignored of [h.event(-100), h.event(-100, { metaKey: false, ctrlKey: true, target: { closest: () => null } }), h.event(-100, { metaKey: false, ctrlKey: true, cancelable: false })]) {
      h.app.zoomGraphWheel(ignored);
      assert.equal(ignored.prevented, undefined);
    }
    h.context.navigator = { platform: "MacIntel" };
    assert.equal(h.app.graphZoomHint(), "按住 Command + 滚轮缩放");
    const macCtrl = h.event(-100, { metaKey: false, ctrlKey: true });
    h.app.zoomGraphWheel(macCtrl);
    assert.equal(macCtrl.prevented, undefined);
  }
});

function learningFixture() {
  const data = fixture(); data.version = 2;
  data.ideas[0].entityType = "method"; data.ideas[0].title = "GRPO"; data.ideas[0].aliases = ["Group Relative Policy Optimization"];
  data.ideas[1].entityType = "unclassified"; data.ideas[1].title = "Legacy paper-title card";
  data.lines[0].kind = "research"; data.lines[0].stageIds = [];
  data.lines.push({ id: "family", title: "Model evolution", kind: "model_family", ideaIds: [], stageIds: ["s1"], activeStageId: "s1" });
  data.stages = [{ id: "s1", title: "Reasoning stage", date: "2025-01-20", summary: "Independent contribution" }];
  data.edges.push({ id: "membership", fromType: "paper", fromId: "p1", toType: "stage", toId: "s1", relation: "documents" });
  return data;
}
test("global methods preserve selected paper and map position across views without classifying legacy cards", () => {
  const h = createApp(); h.app.setState(learningFixture()); h.app.ui.selectedPaperId = "p1"; h.app.ui.selectedIdeaId = "i1";
  h.app.ui.view = "map"; h.node(".paper-map-scroll").scrollLeft = 340; h.node(".paper-map-scroll").scrollTop = 120;
  h.app.switchWorkspaceView("graph");
  assert.equal(h.app.ui.selectedPaperId, "p1");
  assert.deepEqual(Array.from(h.app.methods(), (item) => item.id), ["i1"]);
  assert.equal(h.app.methodChoices("group relative")[0].id, "i1");
  assert.equal(h.app.paperIdeaEdges("p1").length, 1);
  assert.equal(h.app.stagePaperEdges("s1")[0].id, "membership");
  h.app.ui.selectedLineId = "family"; h.app.switchWorkspaceView("outline");
  assert.equal(h.app.ui.selectedPaperId, "p1");
  assert.match(h.node("#main-view").innerHTML, /class="reading-timeline"/);
  assert.doesNotMatch(h.node("#main-view").innerHTML, /data-workspace-form="stage"/);
  h.app.switchWorkspaceView("map");
  assert.equal(h.app.ui.selectedPaperId, "p1");
  assert.equal(h.node(".paper-map-scroll").scrollLeft, 340);
});
test("method annotation submits one atomic action and failed saves retain the paper draft", async () => {
  const h = createApp(); const data = learningFixture(); h.app.setState(data); h.app.ui.selectedPaperId = "p1";
  const form = { dataset: { workspaceForm: "annotate-method", workspaceDraft: "paper-method:p1", id: "p1" }, values: { title: "Group Relative Policy Optimization", note: "Evidence", sourceUrl } };
  h.app.workspaceDraft(form);
  h.context.fetch = async () => ({ ok: false, json: async () => ({ error: "offline" }) });
  await assert.rejects(h.app.submitWorkspaceForm(form, { value: "uses" }), /offline/);
  assert.equal(h.app.readDraft("paper-method:p1").note, "Evidence");
  const sent = [];
  h.context.fetch = async (path, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ state: data, result: { paperId: "p1", ideaId: "i1", edgeId: "e1" } }) }; };
  await h.app.submitWorkspaceForm(form, { value: "uses" });
  assert.equal(sent.length, 1); assert.equal(sent[0].action, "paper.annotate_method");
  assert.equal(sent[0].payload.title, "Group Relative Policy Optimization");
  assert.equal(sent[0].payload.relation, "uses");
  assert.equal(h.app.readDraft("paper-method:p1"), null);
  assert.equal(h.app.ui.selectedPaperId, "p1");
});
test("adding a paper to a new model stage does not require or mutate a method", async () => {
  const h = createApp(); const data = learningFixture(); data.ideas = []; data.edges = [];
  h.app.setState(data); h.app.ui.selectedLineId = "family"; h.app.ui.selectedIdeaId = "";
  const form = { dataset: { workspaceForm: "join-stage", workspaceDraft: "paper-stage:p1", id: "p1" }, values: { lineId: "", lineTitle: "New model family", stageId: "", stageTitle: "New contribution", date: "2026-10-16", summary: "User-authored contribution" } };
  h.app.workspaceDraft(form); let request;
  h.context.fetch = async (path, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ state: data, result: { paperId: "p1", lineId: "family", stageId: "s1" } }) }; };
  await h.app.submitWorkspaceForm(form, {});
  assert.equal(request.action, "paper.add_to_stage");
  assert.equal(request.payload.lineTitle, "New model family");
  assert.equal(request.payload.stageTitle, "New contribution");
  assert.equal(request.payload.ideaId, undefined);
  assert.equal(data.ideas.length, 0);
  assert.equal(h.app.readDraft("paper-stage:p1"), null);
});
test("stage reading restores its own elapsed time and saves a typed target without creating an idea session", async () => {
  const h = createApp(); const data = learningFixture(); h.app.setState(data); h.app.ui.selectedLineId = "family";
  h.app.openStageSession("s1"); h.node("#session-note").value = "Stage notes"; h.clock.now = 61000; h.app.stopTimer();
  assert.equal(h.app.readDraft("session:stage:s1:family").elapsed, 61);
  h.clock.now = 900000; h.app.openStageSession("s1");
  assert.equal(h.app.sessionSeconds(), 61); assert.equal(h.node("#session-note").value, "Stage notes");
  let request;
  h.context.fetch = async (path, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ state: data, result: {} }) }; };
  await h.node("#session-form").listeners.submit({ preventDefault() {} });
  assert.equal(request.payload.targetType, "stage"); assert.equal(request.payload.targetId, "s1");
  assert.equal(request.payload.ideaId, undefined);
  assert.equal(h.app.readDraft("session:stage:s1:family"), null);
});

test("stage memberships never inflate idea counts in paper library and cross-library search", () => {
  const h = createApp(); const data = learningFixture(); h.app.setState(data);
  h.app.renderPaperResults();
  assert.match(h.node("#paper-search-results").innerHTML, /1 个思想/);
  assert.doesNotMatch(h.node("#paper-search-results").innerHTML, /2 个思想/);
  assert.match(h.app.searchResult({ kind: "paper", item: data.papers[0] }), /1 个思想/);
  assert.equal(h.app.paperIdeaEdges("p1").length, 1);
  assert.equal(h.app.stagePaperEdges("s1").length, 1);
});

test("method workspace fits on first method selection but preserves explicit user zoom on saves", () => {
  const h = createApp(); const data = learningFixture(); h.app.setState(data); h.app.ui.selectedIdeaId = "i1";
  const svg = { viewBox: { baseVal: { width: 700, height: 390 } }, setAttribute() {} };
  const scroll = h.node(".graph-scroll"); scroll.clientWidth = 560; scroll.clientHeight = 390; scroll.scrollLeft = 0; scroll.scrollTop = 0; scroll.querySelector = () => svg; scroll.classList.contains = () => false;
  h.app.renderMethodsWorkspace();
  assert.equal(h.app.ui.ideaGraphZoom, .8);
  h.app.zoomGraph(scroll, 1.4);
  h.app.renderMethodsWorkspace();
  assert.equal(h.app.ui.ideaGraphZoom, 1.4);
  h.app.fitMethodGraph(true);
  assert.equal(h.app.ui.ideaGraphZoom, .8);
});
test("stage reading history shows saved stage notes and next questions independently of idea sessions", () => {
  const h = createApp(); const data = learningFixture();
  data.sessions = [{ id: "old", ideaId: "i1", targetType: "idea", targetId: "i1", createdAt: "2026-10-15T00:00:00Z", note: "Legacy idea note" }, { id: "new", targetType: "stage", targetId: "s1", createdAt: "2026-10-16T00:00:00Z", note: "Stage observation", nextQuestion: "Stage next question" }];
  h.app.setState(data); h.app.ui.view = "outline"; h.app.ui.selectedLineId = "family"; h.app.selectTimelineStage("s1");
  assert.match(h.node("#inspector").innerHTML, /Stage observation/);
  assert.match(h.node("#inspector").innerHTML, /Stage next question/);
  assert.doesNotMatch(h.node("#inspector").innerHTML, /Legacy idea note/);
  assert.match(h.app.sessionHistory("i1"), /Legacy idea note/);
});

test("quick role changes omit empty evidence fields so existing relationship evidence is preserved", async () => {
  const h = createApp(); const data = learningFixture(); h.app.setState(data); let request;
  h.context.fetch = async (path, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ state: data, result: { paperId: "p1", ideaId: "i1", edgeId: "e1" } }) }; };
  await h.app.submitWorkspaceForm({ dataset: { workspaceForm: "annotate-method", id: "p1" }, values: { title: "", ideaId: "i1", note: "", sourceUrl: "" } }, { value: "improves" });
  assert.equal(request.payload.ideaId, "i1");
  assert.equal(request.payload.relation, "improves");
  assert.equal(Object.hasOwn(request.payload, "note"), false);
  assert.equal(Object.hasOwn(request.payload, "sourceUrl"), false);
});

test("timeline renders only explicit contribution references, shares method identities and preserves route order", () => {
  const h = createApp(); const data = learningFixture();
  data.stages[0].summary = "This free text says a new imaginary method was proposed";
  data.stages.push({ id: "s2", title: "Earlier date, later reading step", date: "2020-01-01", summary: "" });
  data.lines[1].stageIds.push("s2"); data.edges.push({ id: "member2", fromType: "paper", fromId: "p1", toType: "stage", toId: "s2", relation: "documents", contributionRefs: ["e1"] });
  h.app.setState(data);
  assert.equal(h.app.stageContributions("s1").length, 0);
  assert.equal(h.app.stageContributions("s2").length, 1);
  const layout = h.app.timelineLayout(data.lines[1]);
  assert.deepEqual(Array.from(layout.stages, (item) => item.id), ["s1", "s2"]);
  assert.deepEqual(Array.from(layout.methodIds), ["i1"]);
  data.edges.find((item) => item.id === "membership").contributionRefs = ["e1"];
  assert.equal(h.app.timelineLayout(data.lines[1]).contributions.length, 2);
  assert.equal(h.app.timelineLayout(data.lines[1]).methodIds.length, 1);
  assert.equal(h.app.timelineLayout(data.lines[1]).methodInstances.length, 2);
});
test("paper picker searches metadata with bounded results and stage methods only choose member papers", () => {
  const h = createApp(); const data = learningFixture();
  data.papers[0].institution = "Target Institute";
  data.papers.push(...Array.from({ length: 20 }, (_, index) => ({ id: `extra${index}`, title: `Extra paper ${index}`, authors: "An Author", year: "2026", doi: `10.1234/${index}` })));
  h.app.setState(data);
  assert.equal(h.app.paperPickerResults("target institute", { kind: "stage", id: "empty" })[0].id, "p1");
  assert.equal(h.app.paperPickerResults("An Author", { kind: "method", id: "i1" }).length, 12);
  assert.equal(h.app.paperPickerResults("10.1234/19", { kind: "method", id: "i1" })[0].id, "extra19");
  assert.deepEqual(Array.from(h.app.paperPickerResults("", { kind: "stage-method", id: "s1" }), (item) => item.id), ["p1"]);
  assert.equal(h.app.paperPickerResults("Paper", { kind: "stage", id: "s1" }).some((item) => item.id === "p1"), false);
});
test("paper picker input events filter rendered results without changing the query or stage membership", () => {
  const h = createApp(); const data = learningFixture();
  data.papers.push(
    { id: "p2", title: "Research report 02", authors: "Other Author", year: "2024" },
    { id: "p3", title: "Research report 03", authors: "Other Author", year: "2025" },
  );
  h.app.setState(data); h.app.ui.paperPicker = { kind: "stage", id: "empty" };
  const input = h.node("#picker-paper-query"); input.value = "research report 02";
  const before = JSON.stringify(data);
  for (const listener of h.documentListeners.get("input").callbacks) listener({ target: input });
  assert.match(h.node("#picker-paper-results").innerHTML, /Research report 02/);
  assert.doesNotMatch(h.node("#picker-paper-results").innerHTML, /Research report 03/);
  assert.doesNotMatch(h.node("#picker-paper-results").innerHTML, />Paper</);
  assert.equal(input.value, "research report 02");
  assert.equal(JSON.stringify(data), before);
});
test("stage method annotation can select a specific legacy relationship without changing entity identity", async () => {
  const h = createApp(); const data = learningFixture(); data.edges.push({ ...data.edges[0], id: "old-second", relation: "proposes" }); h.app.setState(data); let request;
  h.context.fetch = async (path, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ state: data, result: { paperId: "p1", ideaId: "i1", edgeId: "old-second", stageId: "s1" } }) }; };
  await h.app.submitWorkspaceForm({ dataset: { workspaceForm: "annotate-method", id: "p1", stageId: "s1" }, values: { title: "", ideaId: "", edgeId: "old-second", note: "", sourceUrl: "" } }, { value: "proposes" });
  assert.equal(request.payload.stageId, "s1"); assert.equal(request.payload.edgeId, "old-second"); assert.equal(request.payload.ideaId, "i1");
  assert.equal(Object.hasOwn(request.payload, "note"), false); assert.equal(data.edges.filter((item) => item.toId === "i1").length, 2);
});
test("rapid contribution removals serialize against the latest membership references", async () => {
  const h = createApp(); const data = learningFixture(); data.edges.find((item) => item.id === "membership").contributionRefs = ["a", "b"];
  h.app.setState(data); const sent = [];
  h.context.fetch = async (path, options) => {
    const request = JSON.parse(options.body); sent.push(request);
    await new Promise((resolve) => setImmediate(resolve));
    data.edges.find((item) => item.id === "membership").contributionRefs = request.payload.contributionRefs;
    return { ok: true, json: async () => ({ state: data, result: {} }) };
  };
  await Promise.all([h.app.removeStageContribution("membership", "a"), h.app.removeStageContribution("membership", "b")]);
  assert.deepEqual(sent.map((request) => request.payload.contributionRefs), [["b"], []]);
  assert.equal(data.edges.some((item) => item.id === "e1"), true);
  assert.equal(data.ideas.length, 2);
});
test("timeline zoom and viewport survive selection and render without affecting map or method zoom", () => {
  const h = createApp(); const data = learningFixture(); h.app.setState(data); h.app.ui.selectedLineId = "family";
  const scroll = h.node(".timeline-scroll"); scroll.dataset.lineId = "family"; scroll.clientWidth = 500; scroll.clientHeight = 400; scroll.scrollLeft = 250; scroll.scrollTop = 100;
  scroll.classList.contains = (name) => name === "timeline-scroll";
  scroll.querySelector = () => ({ viewBox: { baseVal: { width: 1200, height: 560 } }, setAttribute() {} });
  h.app.zoomGraph(scroll, 1.2); h.app.selectTimelineStage("s1"); h.app.renderStageLine(data.lines[1]); h.app.restoreTimelineViewport();
  assert.equal(h.app.ui.timelineZoom, 1.2); assert.equal(scroll.scrollLeft, 350); assert.equal(scroll.scrollTop, 160);
  assert.equal(h.app.ui.mapZoom, 1); assert.equal(h.app.ui.ideaGraphZoom, 1);
});


test("timeline roles order methods within a stage and use the strongest explicit relationship without changing data", () => {
  const h = createApp(); const data = learningFixture();
  for (const [id, title] of [["improved", "Improved method"], ["proposed", "Proposed method"], ["used", "Used method"]]) data.ideas.push({ ...data.ideas[0], id, title });
  data.edges.push(
    { ...data.edges[0], id: "improve", toId: "improved", relation: "improves" },
    { ...data.edges[0], id: "propose", toId: "proposed", relation: "proposes" },
    { ...data.edges[0], id: "shared-propose", relation: "proposes" },
    { ...data.edges[0], id: "use", toId: "used", relation: "uses" },
  );
  data.edges.find((item) => item.id === "membership").contributionRefs = ["e1", "improve", "propose", "shared-propose", "use"];
  h.app.setState(data); const before = JSON.stringify(data);
  assert.deepEqual(Array.from(h.app.stageContributions("s1"), ({ connection }) => connection.id), ["propose", "shared-propose", "improve", "e1", "use"]);
  h.app.renderStageLine(data.lines[1]);
  const html = h.node("#main-view").innerHTML;
  const methodNodes = [...html.matchAll(/<g class="timeline-node method paper-role-(\w+)[^"]*"[^>]*data-id="([^"]+)"/g)];
  assert.deepEqual(methodNodes.map((match) => [match[1], match[2]]), [["proposes", "proposed"], ["proposes", "i1"], ["improves", "improved"], ["uses", "used"]]);
  assert.equal(h.app.timelineLayout(data.lines[1]).contributions.length, 5);
  assert.match(html, /class="timeline-verb"[^>]*>使用<\/text>/);
  assert.match(html, /class="timeline-verb"[^>]*>提出<\/text>/);
  assert.match(html, /class="paper-relation-legend"/);
  assert.equal(JSON.stringify(data), before);
});

test("idea graph and relationship cards consistently display proposes, improves, then uses without changing identities", () => {
  const h = createApp(); const data = learningFixture();
  data.papers.push({ ...data.papers[0], id: "p2", title: "Improving paper" }, { ...data.papers[0], id: "p3", title: "Proposing paper" });
  data.edges.push({ ...data.edges[0], id: "improve", fromId: "p2", relation: "improves" }, { ...data.edges[0], id: "propose", fromId: "p3", relation: "proposes" });
  h.app.setState(data); h.app.ui.selectedIdeaId = "i1"; const before = JSON.stringify(data);
  assert.deepEqual(["proposes", "improves", "uses", "questions"].map(h.app.paperRelationRank), [0, 1, 2, 3]);
  const graph = h.app.graphMarkup(data.ideas[0]);
  const nodes = [...graph.matchAll(/class="graph-node paper-node paper-role-(\w+)"[^>]*data-id="([^"]+)"/g)];
  assert.deepEqual(nodes.map((match) => [match[1], match[2]]), [["proposes", "p3"], ["improves", "p2"], ["uses", "p1"]]);
  h.app.renderMethodsWorkspace();
  const html = h.node("#main-view").innerHTML;
  assert.deepEqual([...html.matchAll(/class="editable-edge paper-role-(\w+)"/g)].map((match) => match[1]), ["proposes", "improves", "uses"]);
  for (const connection of data.edges.filter((item) => item.toId === "i1")) assert.match(h.app.editableEdge(connection), new RegExp(`data-id="${connection.id}"`));
  data.edges.push({ ...data.edges[0], id: "same-paper-improve", relation: "improves" });
  assert.deepEqual(Array.from(h.app.paperIdeaEdges("p1"), (item) => item.relation), ["improves", "uses"]);
  data.edges.pop();
  assert.equal(JSON.stringify(data), before);
});


test("ordinary, paper annotation, and derived card drafts keep separate creation contexts", () => {
  const h = createApp();
  const capture = (title) => {
    h.node("#idea-title").value = title;
    h.app.captureDialogDraft({ id: "idea-form" });
  };
  h.app.openIdeaDialog(); capture("Ordinary draft");
  const source = { paperId: "p1", sourceUrl, text: "Original excerpt" };
  h.app.openIdeaDialog(source); capture("Annotation draft");
  h.node("#idea-source-relation").value = "proposes";
  h.app.captureDialogDraft({ id: "idea-form" });
  h.app.openIdeaDialog(null, "i1"); capture("Derived draft");
  h.app.openIdeaDialog();
  assert.equal(h.node("#idea-title").value, "Ordinary draft");
  h.app.openIdeaDialog(source);
  assert.equal(h.node("#idea-title").value, "Annotation draft");
  assert.equal(h.node("#idea-source-relation").value, "proposes");
  h.app.openIdeaDialog({ ...source, sourceUrl: sourceUrl + "2" });
  assert.equal(h.node("#idea-title").value, "");
  h.app.openIdeaDialog(null, "i1");
  assert.equal(h.node("#idea-title").value, "Derived draft");
  const reloaded = createApp(h.storage);
  reloaded.app.openIdeaDialog(source);
  assert.equal(reloaded.node("#idea-title").value, "Annotation draft");
});

test("new card, paper and reading line submits ignore repeated clicks until the request finishes", async () => {
  for (const name of ["idea", "paper", "line"]) {
    const h = createApp();
    let finish, count = 0;
    h.context.fetch = () => { count++; return new Promise((resolve) => { finish = resolve; }); };
    const submit = () => h.node(`#${name}-form`).listeners.submit({ preventDefault() {} });
    const pending = submit();
    await submit();
    assert.equal(count, 1, name);
    finish({ ok: false, json: async () => ({ error: "offline" }) });
    await pending;
    const retry = submit();
    assert.equal(count, 2, name);
    finish({ ok: true, json: async () => ({ state: fixture(), result: {} }) });
    await retry;
  }
});

test("a repeated stage creation request runs once and a failed request remains retryable", async () => {
  const h = createApp();
  const form = { dataset: { workspaceForm: "new-stage", workspaceDraft: "stage-new:l1", id: "l1" }, values: { title: "Stage draft", date: "", summary: "Keep me" } };
  h.app.workspaceDraft(form);
  let finish, count = 0;
  h.context.fetch = () => { count++; return new Promise((resolve) => { finish = resolve; }); };
  const pending = h.app.submitWorkspaceForm(form);
  await h.app.submitWorkspaceForm(form);
  assert.equal(count, 1);
  finish({ ok: false, json: async () => ({ error: "offline" }) });
  await assert.rejects(pending, /offline/);
  assert.equal(h.app.readDraft("stage-new:l1").summary, "Keep me");
  const retry = h.app.submitWorkspaceForm(form);
  assert.equal(count, 2);
  finish({ ok: true, json: async () => ({ state: fixture(), result: {} }) });
  await retry;
  assert.equal(h.app.readDraft("stage-new:l1"), null);
});

test("saving an annotation card clears only that source draft after acceptance", async () => {
  const h = createApp();
  h.app.openIdeaDialog();
  h.node("#idea-title").value = "Ordinary draft";
  h.app.captureDialogDraft({ id: "idea-form" });
  h.app.openIdeaDialog({ paperId: "p1", sourceUrl });
  h.node("#idea-title").value = "Annotation draft";
  h.app.captureDialogDraft({ id: "idea-form" });
  const sourceKey = h.app.ideaDialogDraftKey();
  let finish;
  h.context.fetch = () => new Promise((resolve) => { finish = resolve; });
  const save = h.node("#idea-form").listeners.submit({ preventDefault() {} });
  assert.equal(h.app.readDraft(sourceKey).title, "Annotation draft");
  finish({ ok: true, json: async () => ({ state: fixture(), result: {} }) });
  await save;
  assert.equal(h.app.readDraft(sourceKey), null);
  assert.equal(h.app.readDraft("idea-new").title, "Ordinary draft");
});


test("a failed initial state load exposes restore and recovers through the real file change handler", async () => {
  const requests = [];
  const h = createApp(new Map(), { now: 0 }, async (path) => {
    requests.push(path);
    return { ok: false, status: 500, json: async () => ({ error: "Corrupt JSON" }) };
  });
  h.app.setState(null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.node("#main-view").innerHTML, /data-action="restore-backup">从备份恢复/);
  assert.match(h.node("#main-view").innerHTML, /Corrupt JSON/);
  assert.deepEqual(requests, ["/api/state"]);
  const button = { dataset: { action: "restore-backup" } };
  await h.documentListeners.get("click").callbacks[0]({ target: { closest: () => button } });
  assert.equal(h.node("#restore-file").clickCount, 1);
  let confirmed = 0;
  h.context.PaperLineDesktop = { unpack: (backup) => ({ backup, drafts: null }), confirm: async (message) => { confirmed++; assert.match(message, /替换当前数据/); return true; } };
  h.context.fetch = async (path, options) => {
    requests.push(path);
    assert.deepEqual(JSON.parse(options.body).backup, fixture());
    return { ok: true, json: async () => ({ state: fixture(), result: { kept: "damaged-original.json" } }) };
  };
  await h.node("#restore-file").listeners.change({ target: { files: [{ size: 100, text: async () => JSON.stringify(fixture()) }] } });
  assert.equal(confirmed, 1);
  assert.deepEqual(requests, ["/api/state", "/api/restore"]);
  assert.doesNotMatch(h.node("#main-view").innerHTML, /无法读取应用数据/);
  assert.equal(h.app.ui.selectedLineId, "l1");
});


test("an accepted slow card save does not close a reopened source dialog or clear its draft", async () => {
  const h = createApp();
  h.app.openIdeaDialog({ paperId: "p1", sourceUrl });
  h.node("#idea-title").value = "First annotation";
  h.app.captureDialogDraft({ id: "idea-form" });
  const firstKey = h.app.ideaDialogDraftKey();
  let finish;
  h.context.fetch = () => new Promise((resolve) => { finish = resolve; });
  const save = h.node("#idea-form").listeners.submit({ preventDefault() {} });
  h.app.closeDialog(h.node("#idea-dialog"));
  const secondSource = { paperId: "p1", sourceUrl: sourceUrl + "2" };
  h.app.openIdeaDialog(secondSource);
  h.node("#idea-title").value = "Second annotation draft";
  h.app.captureDialogDraft({ id: "idea-form" });
  const secondKey = h.app.ideaDialogDraftKey();
  finish({ ok: true, json: async () => ({ state: fixture(), result: {} }) });
  await save;
  assert.equal(h.node("#idea-dialog").open, true);
  assert.equal(h.node("#idea-title").value, "Second annotation draft");
  assert.equal(h.app.readDraft(firstKey), null);
  assert.equal(h.app.readDraft(secondKey).title, "Second annotation draft");
  h.app.closeDialog(h.node("#idea-dialog"));
  h.app.openIdeaDialog(secondSource);
  assert.equal(h.node("#idea-title").value, "Second annotation draft");
});

test("a slow method annotation save leaves a newer paper picker open with its draft", async () => {
  const h = createApp();
  h.app.openDialog("#paper-picker-dialog");
  const form = { dataset: { workspaceForm: "annotate-method", workspaceDraft: "paper-method:p1", id: "p1" }, values: { title: "First method", note: "Evidence", sourceUrl } };
  h.app.workspaceDraft(form);
  let finish;
  h.context.fetch = () => new Promise((resolve) => { finish = resolve; });
  const save = h.app.submitWorkspaceForm(form, { value: "uses" });
  h.app.closeDialog(h.node("#paper-picker-dialog"));
  h.app.openDialog("#paper-picker-dialog");
  const newer = { dataset: { workspaceDraft: "paper-method:p2" }, values: { title: "Newer method", note: "Second evidence", sourceUrl: "" } };
  h.app.workspaceDraft(newer);
  finish({ ok: true, json: async () => ({ state: fixture(), result: {} }) });
  await save;
  assert.equal(h.node("#paper-picker-dialog").open, true);
  assert.equal(h.app.readDraft("paper-method:p1"), null);
  assert.equal(h.app.readDraft("paper-method:p2").note, "Second evidence");
});
