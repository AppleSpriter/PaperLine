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
  const windowListeners = new Map();
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
    window: { innerWidth: 1280, addEventListener(type, callback) {
      windowListeners.set(type, [...(windowListeners.get(type) || []), callback]);
    } },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    FormData: class { constructor(form) { this.form = form; } entries() { return Object.entries(this.form.values); } },
    Event: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    Date: class extends Date { static now() { return clock.now; } },
    fetch: bootFetch,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    PaperLineI18n: { translate: (value) => value, apply() {} },
  });
  vm.runInContext(appSource, context);
  const app = vm.runInContext(`({ ui, openAttachPicker, renderAttachPicker, attachPickerIdea, ideaCardMarkup, ideaCardsMarkup, sourceType, isPaperSource, paperSources, renderPickerSourceControls, openPaperPicker, renderPaperPickerResults, submitSourceForm, inspectMethod, inspectedMethod, syncTimelineMethodSelection, openDialog, openIdeaDialog, ideaDialogDraftKey, captureDialogDraft, openSession, closeDialog, stopTimer, sessionSeconds, captureIdeaDraft, searchIdeas, selectIdea, latestSession, readingRecap, sessionHistory,
    revealStageCalendar, validateStageDateInput, stageDateParts, stageDateISO, stageDateToday, stageDateField, stageCalendarMarkup, updateStageDate, closeStageCalendar, newStageEditor, stageEditor, enhanceDirectChoices, paperStageForm, paperMethodForm, methodStageOccurrences, methodMatchChoices, paperRelationRank, editableEdge, timelineLayout, stageContributions, selectTimelineStage, renderStageInspector, rememberTimelineViewport, restoreTimelineViewport, paperPickerResults, removeStageContribution, queueContributionAction, fitMethodGraph, switchWorkspaceView, methods, methodChoices, paperIdeaEdges, stagePaperEdges, workspaceDraft, submitWorkspaceForm, renderMethodsWorkspace, renderStageLine, renderPaperInspector, openStageSession, sessionDraftKey, graphZoomHint, setPageZoom, zoomGraph, zoomGraphWheel, graphMarkup, orderedMapPapers, paperMapLayout, updatePaperSelection, syncInspectorLayout, syncSelection, graphNode, displayAuthors, paperInstitution, libraryCitationCounts, rankedRecommendations, renderRecommendations, openPaperLineDialog, paperReadStatus, mapPapers, validCitations, renderPaperMap, renderPaperMapResults, renderMapInspector, renderZoteroSync, applyZoteroSync, refreshZoteroSync, startZoteroSync, markPaper, renderIdeaInspector, renderInspector, renderIdeas, renderPaperResults, searchResult, searchPapers, searchLines, searchEverything, markIdea, toast, readDraft, act, refreshState, formatDuration, readingTotal, renderOutline, setState(value) { state = value; } })`, context);
  app.setState(fixture());
  app.ui.selectedLineId = "l1";
  return { app, node, context, storage, clock, documentListeners, windowListeners };
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


async function workspaceClick(h, dataset, form) {
  const button = { dataset, closest: (selector) => selector === "form" ? form : null };
  const event = { target: { closest: (selector) => selector === "[data-workspace-action]" ? button : null } };
  await Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener(event)));
  return button;
}

function annotationForm(values) {
  const elements = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { name, value }]));
  const parts = new Map();
  return {
    dataset: { workspaceForm: "annotate-method", workspaceDraft: "paper-method:p1", id: "p1" }, elements,
    get values() { return Object.fromEntries(Object.entries(elements).map(([name, input]) => [name, input.value])); },
    querySelector(selector) { if (!parts.has(selector)) parts.set(selector, { innerHTML: "" }); return parts.get(selector); },
  };
}

test("direct choice clicks use the original select change event without adding draft values", async () => {
  const h = createApp(); let changed = 0;
  const control = { querySelectorAll: () => [] };
  const select = { value: "method", parentElement: {}, nextElementSibling: control, dispatchEvent(event) { changed++; assert.equal(event.type, "change"); assert.equal(event.bubbles, true); } };
  control.previousElementSibling = select;
  const button = { dataset: { directValue: "concept" }, closest: () => control };
  const event = { target: { closest: (selector) => selector === "[data-direct-value]" ? button : null } };
  for (const listener of h.documentListeners.get("click").callbacks) await listener(event);
  assert.equal(select.value, "concept"); assert.equal(changed, 1);
  assert.deepEqual(Object.keys(select).filter((name) => /choice|radio/i.test(name)), []);
});

test("method chips preserve identity and evidence; typing clears explicit selections through the real input handler", async () => {
  const h = createApp(), data = learningFixture(); h.app.setState(data);
  data.edges.push({ ...data.edges[0], id: "legacy-other", relation: "questions" });
  const form = annotationForm({ title: "", ideaId: "", edgeId: "", note: "Keep my evidence", sourceUrl });
  await workspaceClick(h, { workspaceAction: "choose-method", id: "i1" }, form);
  assert.equal(form.elements.ideaId.value, "i1"); assert.equal(form.elements.title.value, data.ideas[0].title);
  await workspaceClick(h, { workspaceAction: "choose-method-edge", id: "legacy-other" }, form);
  assert.equal(h.app.readDraft("paper-method:p1").edgeId, "legacy-other");
  form.elements.title.value = "A new method";
  const input = { ...form.elements.title, form };
  for (const listener of h.documentListeners.get("input").callbacks) listener({ target: input });
  const draft = h.app.readDraft("paper-method:p1");
  assert.equal(draft.ideaId, ""); assert.equal(draft.edgeId, ""); assert.equal(draft.title, "A new method");
  assert.equal(draft.note, "Keep my evidence"); assert.equal(draft.sourceUrl, sourceUrl);
  assert.doesNotMatch(h.app.paperMethodForm(data.papers[0]), /<datalist|<select|legacy-other<\//);
});

test("method matches stay bounded and preserve a selected entity beyond the first results", () => {
  const h = createApp(), data = learningFixture();
  data.ideas = Array.from({ length: 20 }, (_, index) => ({ id: `method-${index}`, title: `Method ${index}`, entityType: "method" }));
  h.app.setState(data);
  const html = h.app.methodMatchChoices({ ideaId: "method-19" });
  assert.equal((html.match(/data-workspace-action="choose-method"/g) || []).length, 8);
  assert.match(html, /data-id="method-19" aria-pressed="true"/);
});

test("stage choices default to the current context while an explicit new-stage draft wins", () => {
  const h = createApp(), data = learningFixture(); h.app.setState(data);
  h.app.ui.selectedLineId = "family"; h.app.ui.selectedStageId = "s1";
  const html = h.app.paperStageForm(data.papers[0]);
  assert.match(html, /value="family" selected/); assert.match(html, /value="s1" selected/);
  assert.match(html, /data-create-line hidden/); assert.match(html, /data-create-stage hidden/);
  h.app.workspaceDraft({ dataset: { workspaceDraft: "paper-stage:p1" }, values: { lineId: "", stageId: "", lineTitle: "My new line", stageTitle: "New stage" } });
  const draftHtml = h.app.paperStageForm(data.papers[0]);
  assert.doesNotMatch(draftHtml, /value="family" selected|value="s1" selected/);
  assert.match(draftHtml, /value="My new line"/); assert.doesNotMatch(draftHtml, /data-create-line hidden|data-create-stage hidden/);
});

test("method stage backlinks use explicit contribution references and navigate to that exact stage", async () => {
  const h = createApp(), data = learningFixture(); data.edges.find((item) => item.id === "membership").contributionRefs = ["e1"]; h.app.setState(data);
  const occurrence = h.app.methodStageOccurrences("i1");
  assert.deepEqual(Array.from(occurrence, ({ lineId, stageId }) => [lineId, stageId]), [["family", "s1"]]);
  data.lines.push({ id: "other", title: "Unannotated family", kind: "model_family", ideaIds: [], stageIds: ["s2"] });
  data.stages.push({ id: "s2", title: "No contribution" });
  data.edges.push({ id: "membership2", fromType: "paper", fromId: "p1", toType: "stage", toId: "s2", contributionRefs: [] });
  assert.equal(h.app.methodStageOccurrences("i1").length, 1);
  await workspaceClick(h, { workspaceAction: "method-stage", id: "s1", lineId: "family" });
  assert.equal(h.app.ui.view, "outline"); assert.equal(h.app.ui.selectedLineId, "family"); assert.equal(h.app.ui.selectedStageId, "s1");
  assert.equal(h.app.ui.stageInspect, true); assert.equal(h.app.ui.inspectorOpen, true);
});

test("empty graph details release the workspace column and selecting a paper restores it", () => {
  const h = createApp(); h.app.ui.view = "graph"; h.app.ui.selectedIdeaId = "i1";
  h.app.syncInspectorLayout(); assert.equal(h.node(".workspace").dataset.inspectorVisible, "false");
  h.app.ui.selectedPaperId = "p1"; h.app.syncInspectorLayout();
  assert.equal(h.node(".workspace").dataset.inspectorVisible, "true");
});


test("stage picker adds repeatedly without closing or losing its query and excludes accepted papers", async () => {
  const h = createApp(), data = learningFixture(); data.papers.push({ id: "p2", title: "Paper two" }, { id: "p3", title: "Paper three" }); h.app.setState(data);
  h.app.ui.selectedLineId = "family"; h.app.ui.paperPicker = { kind: "stage", id: "s1" };
  h.app.openDialog("#paper-picker-dialog"); h.node("#picker-paper-query").value = "Paper";
  const requests = [];
  h.context.fetch = async (path, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    data.edges.push({ id: `member-${request.payload.paperId}`, fromType: "paper", fromId: request.payload.paperId, toType: "stage", toId: "s1", relation: "documents" });
    return { ok: true, json: async () => ({ state: data, result: { paperId: request.payload.paperId, stageId: "s1" } }) };
  };
  await workspaceClick(h, { workspaceAction: "pick-paper", id: "p2" });
  assert.equal(h.node("#paper-picker-dialog").open, true); assert.equal(h.node("#picker-paper-query").value, "Paper");
  assert.doesNotMatch(h.node("#picker-paper-results").innerHTML, /data-id="p2"/); assert.match(h.node("#picker-paper-results").innerHTML, /data-id="p3"/);
  await workspaceClick(h, { workspaceAction: "pick-paper", id: "p3" });
  assert.equal(requests.length, 2); assert.equal(h.node("#paper-picker-dialog").open, true);
});

test("a slow stage picker addition cannot change a reopened picker context or query", async () => {
  const h = createApp(), data = learningFixture(); data.papers.push({ id: "p2", title: "Paper two" }); h.app.setState(data);
  h.app.ui.selectedLineId = "family"; h.app.ui.paperPicker = { kind: "stage", id: "s1" }; h.app.openDialog("#paper-picker-dialog");
  let finish; h.context.fetch = () => new Promise((resolve) => { finish = resolve; });
  const saving = workspaceClick(h, { workspaceAction: "pick-paper", id: "p2" });
  await new Promise((resolve) => setImmediate(resolve));
  h.app.closeDialog(h.node("#paper-picker-dialog")); h.app.openDialog("#paper-picker-dialog");
  const newer = { kind: "method", id: "i1" }; h.app.ui.paperPicker = newer;
  h.node("#picker-paper-query").value = "Newer search"; h.node("#picker-paper-results").innerHTML = "Newer results";
  h.app.ui.selectedStageId = "newer-stage";
  finish({ ok: true, json: async () => ({ state: data, result: {} }) }); await saving;
  assert.equal(h.app.ui.paperPicker, newer); assert.equal(h.node("#paper-picker-dialog").open, true);
  assert.equal(h.node("#picker-paper-query").value, "Newer search"); assert.equal(h.node("#picker-paper-results").innerHTML, "Newer results");
  assert.equal(h.app.ui.selectedStageId, "newer-stage");
});


test("direct list search keeps the same input node, composition state and middle-edit caret", () => {
  const h = createApp();
  const search = { value: "", selectionStart: 0, selectionEnd: 0, composing: true, matches: (selector) => selector === ".choice-search", focus() { throw new Error("Filtering must not move focus"); } };
  const results = { innerHTML: "", setAttribute() {} };
  const group = { classList: { contains: () => true }, querySelector: (selector) => selector === ".choice-search" ? search : results };
  const select = {
    value: "", nextElementSibling: group, parentElement: { firstChild: { textContent: "Choose stage" } },
    hasAttribute: () => true, getAttribute: () => "Choose stage",
    options: Array.from({ length: 14 }, (_, index) => ({ value: String(index), textContent: `阶段 ${index}`, hasAttribute: () => true })),
  };
  const root = { querySelectorAll: () => [select] }; group.parentElement = root; search.closest = () => group;
  const type = (value, caret) => {
    search.value = value; search.selectionStart = caret; search.selectionEnd = caret;
    for (const listener of h.documentListeners.get("input").callbacks) listener({ target: search });
    assert.equal(group.querySelector(".choice-search"), search); assert.equal(search.selectionStart, caret); assert.equal(search.selectionEnd, caret);
    assert.equal(search.value, value); assert.equal(search.composing, true);
  };
  type("阶", 1); type("阶段 12", 5); type("阶段 2", 3);
  assert.match(results.innerHTML, /阶段 2/); assert.doesNotMatch(results.innerHTML, /阶段 12/);
});

test("a unique method relationship needs no extra choice, but an explicit legacy edge draft remains visible", () => {
  const h = createApp(), data = learningFixture(); h.app.setState(data);
  assert.doesNotMatch(h.app.paperMethodForm(data.papers[0]), /choose-method-edge/);
  h.app.workspaceDraft({ dataset: { workspaceDraft: "paper-method:p1" }, values: { title: "GRPO", ideaId: "i1", edgeId: "e1", note: "Evidence", sourceUrl } });
  const html = h.app.paperMethodForm(data.papers[0]);
  assert.match(html, /data-workspace-action="choose-method-edge" data-id="e1" aria-pressed="true"/);
  assert.match(html, /已选择的关系/); assert.doesNotMatch(html, /多条旧关系时/);
});


test("stale method selection does not open details in an empty paper or model-family workspace", () => {
  const h = createApp(), data = learningFixture(); h.app.setState(data); h.app.ui.selectedIdeaId = "i1";
  h.app.ui.selectedLineId = "family"; h.app.ui.view = "outline";
  h.app.syncInspectorLayout(); assert.equal(h.node(".workspace").dataset.inspectorVisible, "false");
  h.app.ui.view = "papers";
  h.app.syncInspectorLayout(); assert.equal(h.node(".workspace").dataset.inspectorVisible, "false");
  h.app.ui.view = "outline"; h.app.ui.selectedLineId = "l1";
  h.app.syncInspectorLayout(); assert.equal(h.node(".workspace").dataset.inspectorVisible, "true");
  assert.equal(h.app.ui.selectedIdeaId, "i1");
  h.app.ui.selectedLineId = "family"; h.app.ui.stageInspect = true; h.app.ui.selectedStageId = "s1";
  h.app.syncInspectorLayout(); assert.equal(h.node(".workspace").dataset.inspectorVisible, "true");
});


test("whole-page zoom and resize use the effective viewport for compact inspector layout", () => {
  const h = createApp(); h.app.ui.selectedIdeaId = "i1"; h.app.ui.selectedPaperId = "p1"; h.app.ui.selectedStageId = "stage-kept";
  assert.equal(h.node(".workspace").dataset.compact, "false");
  h.app.setPageZoom(1.2);
  assert.equal(h.node(".workspace").dataset.compact, "true");
  h.app.setPageZoom(1);
  assert.equal(h.node(".workspace").dataset.compact, "false");
  h.context.window.innerWidth = 1000;
  for (const callback of h.windowListeners.get("resize")) callback();
  assert.equal(h.node(".workspace").dataset.compact, "true");
  h.app.setPageZoom(1.5); h.context.window.innerWidth = 1651;
  for (const callback of h.windowListeners.get("resize")) callback();
  assert.equal(h.node(".workspace").dataset.compact, "false");
  h.context.window.innerWidth = 1650;
  for (const callback of h.windowListeners.get("resize")) callback();
  assert.equal(h.node(".workspace").dataset.compact, "true");
  assert.equal(h.app.ui.selectedIdeaId, "i1"); assert.equal(h.app.ui.selectedPaperId, "p1"); assert.equal(h.app.ui.selectedStageId, "stage-kept");
  assert.equal(h.app.ui.mapZoom, 1); assert.equal(h.app.ui.ideaGraphZoom, 1);
});


test("direct options have distinct explicit accessible names and protect user-title labels from translation", () => {
  const h = createApp(), data = fixture(); h.app.setState(data);
  const labels = { "方法": "Method", "概念": "Concept", "问题": "Question", "尚未分类": "Unclassified" };
  h.context.PaperLineI18n.translate = (value) => labels[value] || value;
  const results = { innerHTML: "", setAttribute() {} };
  const group = { classList: { contains: () => true }, querySelector: (selector) => selector === ".choice-search" ? null : results };
  const select = {
    value: "method", nextElementSibling: group, parentElement: { firstChild: { textContent: "内容分类" } },
    hasAttribute: () => false, getAttribute: () => null,
    options: Object.keys(labels).map((textContent, index) => ({ value: String(index), textContent, hasAttribute: () => false })),
  };
  select.options.push({ value: "user-method-title", textContent: "方法", hasAttribute: (name) => name === "data-user-content" });
  const root = { querySelectorAll: () => [select] };
  h.app.enhanceDirectChoices(root);
  for (const label of Object.keys(labels)) assert.match(results.innerHTML, new RegExp(`aria-label="${label}"`));
  assert.doesNotMatch(results.innerHTML, /aria-label="内容分类"/);
  data.settings.language = "en"; h.app.enhanceDirectChoices(root);
  for (const label of Object.values(labels)) assert.match(results.innerHTML, new RegExp(`aria-label="${label}"`));
  assert.match(results.innerHTML, /data-direct-value="user-method-title"[^>]*aria-label="方法" data-user-content/);
  select.options[0].textContent = "Method";
  data.settings.language = "zh"; h.app.enhanceDirectChoices(root);
  assert.match(results.innerHTML, /data-direct-value="0"[^>]*aria-label="方法"/);
  assert.equal(select.value, "method");
});


test("stage dates reject impossible days and retain years 0001 through 9999", () => {
  const { app } = createApp();
  for (const value of ["2025-02-29", "1900-02-29", "2024-04-31", "0000-01-01", "2024-13-01", "2024-1-01", "2024-01-00"]) assert.equal(app.stageDateParts(value), null, value);
  for (const value of ["0001-01-01", "0099-12-31", "2000-02-29", "2024-02-29", "9999-12-31"]) assert.ok(app.stageDateParts(value), value);
  assert.equal(app.stageDateISO(1, 2, 3), "0001-02-03");
  const leap = app.stageCalendarMarkup(2000, 2, "2000-02-29");
  assert.match(leap, /data-date="2000-02-29"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(app.stageCalendarMarkup(1900, 2, ""), /1900-02-29/);
  assert.match(app.stageCalendarMarkup(1, 1, ""), /data-date-action="previous"[^>]*disabled/);
  assert.match(app.stageCalendarMarkup(9999, 12, ""), /data-date-action="next"[^>]*disabled/);
  assert.match(app.stageCalendarMarkup(99, 1, ""), /data-date="0099-01-01"/);
});

test("all stage forms preserve ISO drafts and use the same scalable calendar", () => {
  const h = createApp(), data = learningFixture(); h.app.setState(data);
  const current = data.lines.find((line) => line.id === "family"), item = data.stages[0];
  h.app.workspaceDraft({ dataset: { workspaceDraft: "stage-new:family" }, values: { title: "Draft", date: "2000-02-29" } });
  h.app.workspaceDraft({ dataset: { workspaceDraft: `stage:${item.id}` }, values: { title: item.title, date: "0099-12-31" } });
  h.app.workspaceDraft({ dataset: { workspaceDraft: "paper-stage:p1" }, values: { stageId: "", date: "2024-02-29" } });
  const forms = [h.app.newStageEditor(current), h.app.stageEditor(item, current, 0), h.app.paperStageForm(data.papers[0])];
  for (const [index, value] of ["2000-02-29", "0099-12-31", "2024-02-29"].entries()) {
    assert.match(forms[index], new RegExp(`name="date" type="text"[^>]*value="${value}"`));
    assert.match(forms[index], /data-stage-calendar hidden/); assert.doesNotMatch(forms[index], /type="date"/);
  }
  h.app.setPageZoom(1.4);
  assert.equal(h.app.newStageEditor(current), forms[0]);
  assert.equal(h.app.readDraft("stage-new:family").date, "2000-02-29");
});

test("calendar selection and clearing dispatch draft events without submitting", () => {
  const h = createApp(), events = [], input = { value: "2024-02-29", setCustomValidity(value) { this.validity = value; }, dispatchEvent(event) { events.push(event); } };
  const panel = { hidden: false }, toggle = { setAttribute(key, value) { this[key] = value; }, focus() { this.focused = true; } };
  const field = { querySelector(selector) { return selector === "[data-stage-date-input]" ? input : selector === "[data-stage-calendar]" ? panel : toggle; } };
  h.app.updateStageDate(field, "2000-02-29"); assert.equal(input.value, "2000-02-29");
  assert.deepEqual(events.map((event) => [event.type, event.bubbles]), [["input", true], ["change", true]]);
  assert.equal(panel.hidden, true); assert.equal(toggle.focused, true); assert.equal(toggle["aria-expanded"], "false");
  events.length = 0; h.app.updateStageDate(field, ""); assert.equal(input.value, ""); assert.equal(input.validity, ""); assert.equal(events.length, 2);
  const markup = h.app.stageCalendarMarkup(2024, 2, "");
  assert.doesNotMatch(markup, /<button(?! type="button")/); assert.doesNotMatch(markup, /<select|type="date"|type="month"|type="number"|name=| min=| max=| pattern=/);
  for (const button of markup.matchAll(/<button[^>]*>/g)) assert.match(button[0], /aria-label=/);
});

test("invalid manually entered stage dates are rejected before an API write", async () => {
  const h = createApp(); let writes = 0; h.context.fetch = async () => { writes++; throw new Error("unexpected write"); };
  for (const kind of ["stage", "new-stage", "join-stage"]) {
    const form = { dataset: { workspaceForm: kind, id: "s1" }, values: { date: "2025-02-29", stageId: "", lineId: "family", stageTitle: "Draft" } };
    await assert.rejects(h.app.submitWorkspaceForm(form), /YYYY-MM-DD/);
    assert.equal(form.dataset.saving, undefined);
  }
  assert.equal(writes, 0);
});


test("joining an existing stage suspends date validation while preserving its raw draft", () => {
  const { app } = createApp(), attributes = new Map(), form = { dataset: { workspaceForm: "join-stage" }, elements: { stageId: { value: "" } } };
  const input = { form, value: "2026-", setAttribute(key, value) { attributes.set(key, value); }, removeAttribute(key) { attributes.delete(key); }, setCustomValidity(value) { this.error = value; } };
  app.validateStageDateInput(input); assert.ok(input.error); assert.ok(attributes.has("pattern"));
  form.elements.stageId.value = "s1"; app.validateStageDateInput(input);
  assert.equal(input.error, ""); assert.equal(attributes.has("pattern"), false); assert.equal(input.value, "2026-");
  form.elements.stageId.value = ""; app.validateStageDateInput(input);
  assert.ok(input.error); assert.ok(attributes.has("pattern")); assert.equal(input.value, "2026-");
  assert.doesNotMatch(app.stageDateField("2026-", false), /pattern=/);
});


test("compact inspector stays below the visible header through zoom, resize and scroll", () => {
  const h = createApp(); let bottom = 84;
  h.node(".topbar").getBoundingClientRect = () => ({ bottom });
  h.app.setPageZoom(1.2);
  assert.equal(h.node(".workspace").dataset.compact, "true");
  assert.equal(h.context.document.documentElement.style["--inspector-header-inset"], "70px");
  bottom = 140; h.app.setPageZoom(1.4);
  assert.equal(h.context.document.documentElement.style["--inspector-header-inset"], "100px");
  bottom = 56;
  for (const callback of h.windowListeners.get("resize")) callback();
  assert.equal(h.context.document.documentElement.style["--inspector-header-inset"], "40px");
  bottom = -10;
  for (const callback of h.windowListeners.get("scroll")) callback();
  assert.equal(h.context.document.documentElement.style["--inspector-header-inset"], "0px");
  const css = readFileSync(resolve(__dirname, "../static/style.css"), "utf8");
  assert.equal((css.match(/top: calc\(var\(--inspector-header-inset, 0px\) \+ 12px\)/g) || []).length, 2);
  assert.equal((css.match(/max-height: calc\(100dvh \/ var\(--page-scale, 1\) - var\(--inspector-header-inset, 0px\) - 24px\)/g) || []).length, 2);
});


test("page zoom reveals only an open calendar without changing its date or rebuilding it", () => {
  const h = createApp(), calls = [], date = "2024-02-29";
  const open = { hidden: false, innerHTML: date, scrollIntoView(options) { calls.push({ ...options }); } };
  const closed = { hidden: true, scrollIntoView() { throw new Error("closed calendar scrolled"); } };
  h.context.document.querySelectorAll = (selector) => selector === "[data-stage-calendar]" ? [closed, open] : [];
  h.app.setPageZoom(1.4);
  assert.deepEqual(calls, [{ block: "nearest", behavior: "instant" }]); assert.equal(open.innerHTML, date);
  open.hidden = true; h.app.setPageZoom(1); assert.equal(calls.length, 1);
  h.context.document.querySelectorAll = () => []; h.app.setPageZoom(1.4); assert.equal(calls.length, 1);
});

test("a member paper opened from a timeline annotates the selected stage atomically with an isolated draft", async () => {
  const h = createApp(), data = learningFixture(); h.app.setState(data);
  h.app.ui.view = "outline"; h.app.ui.selectedLineId = "family";
  h.app.workspaceDraft({ dataset: { workspaceDraft: "paper-method:p1" }, values: { title: "Global draft" } });
  h.app.workspaceDraft({ dataset: { workspaceDraft: "paper-method:p1:s1" }, values: { title: "Stage draft" } });
  await workspaceClick(h, { workspaceAction: "timeline-paper", id: "s1", paperId: "p1" });
  const html = h.node("#inspector").innerHTML;
  assert.match(html, /data-stage-id="s1"/); assert.match(html, /保存后显示于阶段/); assert.match(html, /<strong data-user-content>Reasoning stage<\/strong>/);
  assert.match(html, /value="Stage draft"/); assert.doesNotMatch(html, /value="Global draft"/);
  assert.match(html, /data-workspace-action="method-stage" data-id="s1" data-line-id="family"/);
  let request;
  h.context.fetch = async (path, options) => {
    request = JSON.parse(options.body);
    data.ideas.push({ id: "new-method", title: "Stage draft", entityType: "method" });
    data.edges.push({ id: "new-edge", fromType: "paper", fromId: "p1", toId: "new-method", relation: "proposes" });
    data.edges.find((edge) => edge.id === "membership").contributionRefs = ["new-edge"];
    return { ok: true, json: async () => ({ state: data, result: { paperId: "p1", stageId: "s1" } }) };
  };
  await h.app.submitWorkspaceForm({ dataset: { workspaceForm: "annotate-method", workspaceDraft: "paper-method:p1:s1", id: "p1", stageId: "s1" }, values: { title: "Stage draft", note: "", sourceUrl: "" } }, { value: "proposes" });
  assert.equal(request.action, "paper.annotate_method"); assert.equal(request.payload.stageId, "s1");
  assert.deepEqual(Array.from(h.app.timelineLayout(data.lines[1]).methodIds), ["new-method"]);
  assert.equal(h.app.readDraft("paper-method:p1:s1"), null); assert.equal(h.app.readDraft("paper-method:p1").title, "Global draft");
});

test("paper annotation context excludes other views, other lines, missing stages, and nonmembers", () => {
  for (const scenario of ["papers", "map", "graph", "recommendations", "research", "other-line", "missing-stage", "nonmember"]) {
    const h = createApp(), data = learningFixture();
    h.app.ui.view = "outline"; h.app.ui.selectedLineId = "family"; h.app.ui.selectedStageId = "s1";
    if (["papers", "map", "graph", "recommendations"].includes(scenario)) h.app.ui.view = scenario;
    if (scenario === "research") h.app.ui.selectedLineId = "l1";
    if (scenario === "other-line") data.lines[1].stageIds = [];
    if (scenario === "missing-stage") data.stages = [];
    if (scenario === "nonmember") data.edges = data.edges.filter((edge) => edge.id !== "membership");
    h.app.setState(data); h.app.renderPaperInspector(data.papers[0]);
    const html = h.node("#inspector").innerHTML;
    assert.doesNotMatch(html, /data-stage-id=/, scenario);
    assert.match(html, /data-workspace-draft="paper-method:p1"/, scenario);
  }
});

test("stage editor offers only explicit eligible member relationships missing from this stage", () => {
  const h = createApp(), data = learningFixture();
  data.edges[0].note = "Original evidence <keep>";
  data.edges.push({ id: "already", fromType: "paper", fromId: "p1", toId: "i1", relation: "improves" });
  data.edges.push({ id: "question", fromType: "paper", fromId: "p1", toId: "i1", relation: "questions" });
  data.edges.push({ id: "legacy", fromType: "paper", fromId: "p1", toId: "i2", relation: "uses" });
  data.edges.push({ id: "outsider", fromType: "paper", fromId: "p2", toId: "i1", relation: "proposes" });
  data.edges.find((edge) => edge.id === "membership").contributionRefs = ["already"];
  h.app.setState(data);
  const html = h.app.stageEditor(data.stages[0], data.lines[1], 0);
  assert.match(html, /可加入的已有方法关系/); assert.match(html, /Paper · 使用 · GRPO/);
  assert.match(html, /Original evidence &lt;keep&gt;/);
  const buttons = html.match(/<button[^>]+data-workspace-action="add-stage-contribution"[^>]+>/g);
  assert.equal(buttons.length, 1); assert.match(buttons[0], /data-id="s1" data-paper-id="p1" data-idea-id="i1" data-edge-id="e1" data-relation="uses"/);
  assert.equal(data.edges.find((edge) => edge.id === "membership").contributionRefs.length, 1);
});

test("adding an existing contribution is queued, duplicate-safe, preserves evidence, and affects only its stage", async () => {
  const h = createApp(), data = learningFixture(), requests = [];
  data.edges[0].note = "Keep evidence"; data.edges[0].sourceUrl = sourceUrl;
  data.stages.push({ id: "s2", title: "Other stage" }); data.lines[1].stageIds.push("s2");
  data.edges.push({ id: "member2", fromType: "paper", fromId: "p1", toType: "stage", toId: "s2", relation: "documents", contributionRefs: [] });
  data.edges.find((edge) => edge.id === "membership").contributionRefs = ["unrelated-ref"];
  h.app.setState(data); h.app.ui.view = "outline"; h.app.ui.selectedLineId = "family"; h.app.ui.selectedStageId = "s1"; h.app.ui.stageInspect = true;
  let release;
  h.context.fetch = async (path, options) => {
    requests.push(JSON.parse(options.body));
    await new Promise((resolve) => { release = resolve; });
    data.edges.find((edge) => edge.id === "membership").contributionRefs.push("e1");
    return { ok: true, json: async () => ({ state: data, result: { stageId: "s1", paperId: "p1", ideaId: "i1" } }) };
  };
  const dataset = { workspaceAction: "add-stage-contribution", id: "s1", paperId: "p1", ideaId: "i1", edgeId: "e1", relation: "uses" };
  const button = { dataset, closest() { return null; } };
  const click = () => Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener({ target: { closest: (selector) => selector === "[data-workspace-action]" ? button : null } })));
  const first = click(), duplicate = click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1); assert.equal(button.disabled, true);
  release(); await Promise.all([first, duplicate]);
  assert.deepEqual(requests[0], { action: "stage.add_contribution", payload: { stageId: "s1", edgeId: "e1" } });
  assert.deepEqual(data.edges.find((edge) => edge.id === "membership").contributionRefs, ["unrelated-ref", "e1"]);
  assert.deepEqual(data.edges.find((edge) => edge.id === "member2").contributionRefs, []);
  assert.equal(data.edges[0].note, "Keep evidence"); assert.equal(data.edges[0].sourceUrl, sourceUrl);
  await click(); assert.equal(requests.length, 1); assert.equal(button.disabled, false);
  assert.equal(data.ideas.length, 2); assert.equal(data.edges.filter((edge) => edge.id === "e1").length, 1);
});

test("a failed existing contribution addition remains available for retry", async () => {
  const h = createApp(), data = learningFixture(); h.app.setState(data);
  let calls = 0;
  h.context.fetch = async () => { calls++; return { ok: false, json: async () => ({ error: "Retry me" }) }; };
  const dataset = { workspaceAction: "add-stage-contribution", id: "s1", paperId: "p1", ideaId: "i1", edgeId: "e1", relation: "uses" };
  const button = await workspaceClick(h, dataset);
  assert.equal(button.disabled, false); assert.equal(button.dataset.saving, undefined);
  await workspaceClick(h, dataset); assert.equal(calls, 2);
  assert.match(h.app.stageEditor(data.stages[0], data.lines[1], 0), /data-edge-id="e1" data-relation="uses"/);
});

test("sidebar reordering preserves the selected path, editor draft, and main view", async () => {
  const h = createApp(), data = fixture();
  data.lines.push({ id: "l2", title: "Second path", ideaIds: [], activeIdeaId: "" });
  h.app.setState(data); h.app.ui.selectedLineId = "l1";
  h.node("#main-view").innerHTML = "Editor stays mounted";
  h.app.captureIdeaDraft({ dataset: { id: "i1" }, values: { title: "Unfinished", summary: "Keep notes" } });
  const requests = []; let release;
  h.context.fetch = async (path, options) => {
    requests.push(JSON.parse(options.body));
    await new Promise((resolve) => { release = resolve; });
    data.lines.reverse();
    return { ok: true, json: async () => ({ state: data, result: { movedLineId: "l2" } }) };
  };
  const button = { dataset: { action: "move-reading-line", id: "l2", offset: "-1" } };
  const click = () => Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener({ target: { closest: (selector) => selector === "[data-action]" ? button : null } })));
  const first = click(), duplicate = click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1); assert.equal(button.disabled, true);
  release(); await Promise.all([first, duplicate]);
  assert.deepEqual(requests[0], { action: "line.reorder", payload: { lineId: "l2", offset: -1 } });
  assert.equal(h.app.ui.selectedLineId, "l1");
  assert.equal(h.node("#main-view").innerHTML, "Editor stays mounted");
  assert.equal(h.app.readDraft("idea:i1").summary, "Keep notes");
  const sidebar = h.node("#line-list").innerHTML;
  assert.ok(sidebar.indexOf("Second path") < sidebar.indexOf("Research"));
  assert.match(sidebar, /aria-label="上移阅读线"[^>]*disabled/);
  assert.equal(button.disabled, false);
});

test("failed sidebar reorder can retry without changing the selection", async () => {
  const h = createApp(); let calls = 0;
  h.context.fetch = async () => { calls++; return { ok: false, json: async () => ({ error: "Could not save order" }) }; };
  const button = { dataset: { action: "move-reading-line", id: "l1", offset: "1" } };
  const click = () => Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener({ target: { closest: (selector) => selector === "[data-action]" ? button : null } })));
  await click(); await click();
  assert.equal(calls, 2); assert.equal(button.disabled, false);
  assert.equal(button.dataset.saving, undefined); assert.equal(h.app.ui.selectedLineId, "l1");
});

test("reorder and annotation requests stay in order and do not steal editor focus", async () => {
  const h = createApp(), data = learningFixture(), requests = [];
  h.app.setState(data); h.app.ui.view = "outline"; h.app.ui.selectedLineId = "family";
  let release;
  h.context.fetch = async (path, options) => {
    const request = JSON.parse(options.body); requests.push(request.action);
    if (request.action === "line.reorder") {
      await new Promise((resolve) => { release = resolve; });
      data.lines.reverse();
    } else data.edges.find((edge) => edge.id === "membership").contributionRefs = ["e1"];
    return { ok: true, json: async () => ({ state: structuredClone(data), result: {} }) };
  };
  const input = { focus() { throw new Error("Already focused input should stay mounted"); } };
  h.context.document.activeElement = input;
  const button = { dataset: { action: "move-reading-line", id: "family", offset: "-1" } };
  const reorder = Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener({ target: { closest: (selector) => selector === "[data-action]" ? button : null } })));
  await new Promise((resolve) => setImmediate(resolve));
  const annotation = h.app.act("stage.add_contribution", { stageId: "s1", edgeId: "e1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, ["line.reorder"]);
  release(); await Promise.all([reorder, annotation]);
  assert.deepEqual(requests, ["line.reorder", "stage.add_contribution"]);
  assert.equal(h.context.document.activeElement, input);
  assert.deepEqual(Array.from(h.app.stagePaperEdges("s1")[0].contributionRefs), ["e1"]);
  assert.ok(h.node("#line-list").innerHTML.indexOf("Family") < h.node("#line-list").innerHTML.indexOf("Research"));
});

function methodInspectionFixture(h) {
  const data = learningFixture(); data.edges.find((edge) => edge.id === "membership").contributionRefs = ["e1"];
  data.stages.push({ id: "s2", title: "Second stage" }); data.lines[1].stageIds.push("s2");
  data.edges.push({ id: "member2", fromType: "paper", fromId: "p1", toType: "stage", toId: "s2", relation: "documents", contributionRefs: ["e1"] });
  h.app.setState(data); h.app.ui.view = "outline"; h.app.ui.selectedLineId = "family"; h.app.ui.selectedStageId = "s1";
  return data;
}
async function actionClick(h, dataset) {
  const button = { dataset, closest() { return null; } };
  await Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener({ target: { closest: (selector) => selector === "[data-action]" ? button : null } })));
}

test("timeline method clicks inspect in place and select only the clicked stage occurrence", async () => {
  const h = createApp(), data = methodInspectionFixture(h);
  h.app.ui.selectedPaperId = "p1"; h.app.ui.stageInspect = true;
  h.app.renderStageLine(data.lines[1]);
  const original = h.node("#main-view").innerHTML;
  assert.match(original, /data-id="i1" data-stage-id="s1"/); assert.match(original, /单击查看，双击进入思想图/);
  let mainWrites = 0;
  Object.defineProperty(h.node("#main-view"), "innerHTML", { get: () => original, set: () => { mainWrites++; } });
  const scroll = h.node(".timeline-scroll"); scroll.dataset.lineId = "family"; scroll.scrollLeft = 310; scroll.scrollTop = 75; h.app.ui.timelineZoom = 1.4;
  const nodes = ["s1", "s2"].map((stageId) => ({ dataset: { workspaceAction: "timeline-method", id: "i1", stageId }, classList: { toggle(name, value) { this[name] = value; } }, setAttribute(name, value) { this[name] = value; } }));
  h.context.document.querySelectorAll = (selector) => selector === ".timeline-node" ? nodes : [];
  await workspaceClick(h, { workspaceAction: "timeline-method", id: "i1", stageId: "s2" });
  assert.equal(mainWrites, 0); assert.equal(h.app.ui.view, "outline"); assert.equal(h.app.ui.selectedPaperId, ""); assert.equal(h.app.ui.stageInspect, false);
  assert.equal(h.app.ui.selectedStageId, "s2"); assert.equal(h.app.ui.selectedLineId, "family");
  assert.equal(scroll.scrollLeft, 310); assert.equal(scroll.scrollTop, 75); assert.equal(h.app.ui.timelineZoom, 1.4);
  assert.equal(nodes[0].classList.selected, false); assert.equal(nodes[1].classList.selected, true); assert.equal(nodes[1]["aria-pressed"], "true");
  assert.match(h.node("#inspector").innerHTML, /id="idea-edit-form"/); assert.match(h.node("#inspector").innerHTML, /打开思想图/);
  assert.equal(h.node(".workspace").dataset.inspectorVisible, "true");
});

test("two timeline clicks preserve the target for one native double click and graph opening clears old paper selection", async () => {
  const h = createApp(); methodInspectionFixture(h);
  h.node("#main-view").innerHTML = "Same SVG";
  await workspaceClick(h, { workspaceAction: "timeline-method", id: "i1", stageId: "s1" });
  await workspaceClick(h, { workspaceAction: "timeline-method", id: "i1", stageId: "s1" });
  assert.equal(h.node("#main-view").innerHTML, "Same SVG");
  let graphWrites = 0; let html = "Same SVG";
  Object.defineProperty(h.node("#main-view"), "innerHTML", { get: () => html, set: (value) => { graphWrites++; html = value; } });
  h.app.ui.selectedPaperId = "p1";
  const button = { dataset: { id: "i1" } };
  for (const listener of h.documentListeners.get("dblclick").callbacks) listener({ preventDefault() {}, target: { closest: () => button } });
  assert.equal(graphWrites, 1); assert.equal(h.app.ui.view, "graph"); assert.equal(h.app.ui.selectedIdeaId, "i1"); assert.equal(h.app.ui.selectedPaperId, ""); assert.equal(h.app.ui.methodInspect, null);
  assert.match(html, /id="idea-edit-form"/);
});

test("method inspector saves the global draft while keeping its reading line, stage, and viewport", async () => {
  const h = createApp(), data = methodInspectionFixture(h);
  h.app.inspectMethod("i1", "s1");
  const values = { title: "GRPO edited", aliases: "Alias", kind: "concept", status: "learning", entityType: "method", summary: "Global shared definition", mechanism: "Mechanism", thoughts: "Thoughts" };
  const form = { id: "idea-edit-form", dataset: { id: "i1" }, values };
  h.app.captureIdeaDraft(form); h.app.renderInspector();
  assert.match(h.node("#inspector").innerHTML, /Global shared definition/);
  const scroll = h.node(".timeline-scroll"); scroll.dataset.lineId = "family"; scroll.scrollLeft = 300; scroll.scrollTop = 60; h.app.ui.timelineZoom = 1.2;
  let request;
  h.context.fetch = async (path, options) => { request = JSON.parse(options.body); Object.assign(data.ideas[0], request.payload); return { ok: true, json: async () => ({ state: data, result: { ideaId: "i1" } }) }; };
  await Promise.all(h.documentListeners.get("submit").callbacks.map((listener) => listener({ target: form, preventDefault() {} })));
  assert.equal(request.action, "idea.update"); assert.equal(request.payload.summary, values.summary);
  assert.equal(h.app.ui.view, "outline"); assert.equal(h.app.ui.selectedLineId, "family"); assert.equal(h.app.ui.selectedStageId, "s1"); assert.equal(h.app.inspectedMethod().id, "i1");
  assert.equal(scroll.scrollLeft, 300); assert.equal(scroll.scrollTop, 60); assert.equal(h.app.ui.timelineZoom, 1.2);
  assert.equal(h.app.readDraft("idea:i1"), null); assert.match(h.node("#inspector").innerHTML, /value="GRPO edited"/);
});

test("stage, paper, line, view, close, and removed contribution clear method inspection while retaining drafts", async () => {
  for (const change of ["stage", "new-stage", "paper", "line", "view", "close", "removed"]) {
    const h = createApp(), data = methodInspectionFixture(h); h.app.inspectMethod("i1", "s1");
    h.app.captureIdeaDraft({ dataset: { id: "i1" }, values: { title: "Kept draft", summary: "Keep me" } });
    if (change === "stage") h.app.selectTimelineStage("s2");
    if (change === "new-stage") h.app.selectTimelineStage("", true);
    if (change === "paper") h.app.updatePaperSelection("p1");
    if (change === "line") await actionClick(h, { action: "select-line", id: "l1" });
    if (change === "view") h.app.switchWorkspaceView("map");
    if (change === "close") await actionClick(h, { action: "close-paper-inspector" });
    if (change === "removed") { data.edges.find((edge) => edge.id === "membership").contributionRefs = []; h.app.syncSelection(); h.app.renderInspector(); }
    assert.equal(h.app.ui.methodInspect, null, change); assert.equal(h.app.inspectedMethod(), null, change);
    assert.equal(h.app.readDraft("idea:i1").summary, "Keep me", change);
  }
});

test("paper method links inspect externally, graph tabs keep switching the graph, and the direct graph button works", async () => {
  const h = createApp(); methodInspectionFixture(h);
  h.app.ui.view = "papers"; h.app.ui.selectedPaperId = "p1"; h.node("#main-view").innerHTML = "Library";
  await actionClick(h, { action: "paper-view-idea", id: "i1" });
  assert.equal(h.app.ui.view, "papers"); assert.equal(h.node("#main-view").innerHTML, "Library"); assert.equal(h.app.inspectedMethod().id, "i1");
  await workspaceClick(h, { workspaceAction: "open-method-graph", id: "i1" });
  assert.equal(h.app.ui.view, "graph"); assert.equal(h.app.ui.selectedPaperId, "");
  await actionClick(h, { action: "paper-view-idea", id: "i1" }); assert.equal(h.app.ui.methodInspect, null);
  await actionClick(h, { action: "paper-view-idea", id: "i2" }); assert.equal(h.app.ui.view, "graph"); assert.equal(h.app.ui.selectedIdeaId, "i2");
});

test("saving a method opened in the paper library keeps its details instead of auto-selecting the first paper", async () => {
  const h = createApp(), data = methodInspectionFixture(h);
  h.app.ui.view = "papers"; h.app.ui.selectedPaperId = "p1";
  await actionClick(h, { action: "paper-view-idea", id: "i1" });
  const values = { title: "Library method", aliases: "", entityType: "method", kind: "concept", status: "learning", summary: "Saved from library", mechanism: "", thoughts: "" };
  const form = { id: "idea-edit-form", dataset: { id: "i1" }, values }; h.app.captureIdeaDraft(form);
  h.context.fetch = async (path, options) => { Object.assign(data.ideas[0], JSON.parse(options.body).payload); return { ok: true, json: async () => ({ state: data, result: { ideaId: "i1" } }) }; };
  await Promise.all(h.documentListeners.get("submit").callbacks.map((listener) => listener({ target: form, preventDefault() {} })));
  assert.equal(h.app.ui.view, "papers"); assert.equal(h.app.ui.selectedPaperId, ""); assert.equal(h.app.inspectedMethod().id, "i1");
  assert.match(h.node("#inspector").innerHTML, /Saved from library/); assert.equal(h.app.readDraft("idea:i1"), null);
});

test("opening another method context starts its inspector at the top while repeated clicks keep its scroll", async () => {
  const h = createApp(), data = methodInspectionFixture(h); data.ideas[1].entityType = "method";
  const inspector = h.node("#inspector"); inspector.scrollTop = 800;
  h.app.inspectMethod("i1", "s1"); assert.equal(inspector.scrollTop, 0);
  inspector.scrollTop = 500; h.app.inspectMethod("i1", "s1"); assert.equal(inspector.scrollTop, 500);
  h.app.inspectMethod("i1", "s2"); assert.equal(inspector.scrollTop, 0);
  inspector.scrollTop = 450; h.app.inspectMethod("i2"); assert.equal(inspector.scrollTop, 0);
});

test("the first pointer click waits before opening a hidden inspector so native double clicks keep the same target", async () => {
  const h = createApp(); methodInspectionFixture(h);
  h.app.ui.inspectorOpen = true; h.node(".workspace").dataset.inspectorVisible = "false";
  const timers = new Map(); let nextTimer = 0;
  h.context.setTimeout = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; };
  h.context.clearTimeout = (id) => timers.delete(id);
  const button = { dataset: { workspaceAction: "timeline-method", id: "i1", stageId: "s1" }, closest() { return null; } };
  const click = (detail) => Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener({ detail, target: { closest: (selector) => selector === "[data-workspace-action]" ? button : null } })));
  h.node("#main-view").innerHTML = "Original SVG";
  await click(1);
  assert.equal(h.app.ui.methodInspect, null); assert.equal(h.node(".workspace").dataset.inspectorVisible, "false"); assert.equal(timers.size, 1);
  await click(2); assert.equal(timers.size, 0); assert.equal(h.node("#main-view").innerHTML, "Original SVG");
  for (const listener of h.documentListeners.get("dblclick").callbacks) listener({ preventDefault() {}, target: { closest: () => button } });
  assert.equal(h.app.ui.view, "graph"); assert.equal(h.app.ui.selectedPaperId, "");
});

test("a single pointer click opens details after its wait and navigation cancels stale pending inspection", async () => {
  const h = createApp(); methodInspectionFixture(h);
  const timers = new Map(); let nextTimer = 0;
  h.context.setTimeout = (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; };
  h.context.clearTimeout = (id) => timers.delete(id);
  const button = { dataset: { workspaceAction: "timeline-method", id: "i1", stageId: "s1" } };
  const click = () => Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener({ detail: 1, target: { closest: (selector) => selector === "[data-workspace-action]" ? button : null } })));
  await click(); const show = [...timers.values()][0]; show();
  assert.equal(h.app.inspectedMethod().id, "i1");
  await actionClick(h, { action: "close-paper-inspector" });
  await click(); const stale = [...timers.values()].at(-1);
  h.app.selectTimelineStage("s2"); stale();
  assert.equal(h.app.ui.methodInspect, null); assert.equal(h.app.ui.stageInspect, true); assert.equal(h.app.ui.selectedStageId, "s2");
});

test("rapid pointer targets keep only the last pending method and keyboard activation inspects immediately", async () => {
  const h = createApp(); methodInspectionFixture(h);
  const timers = new Map(); let nextTimer = 0;
  h.context.setTimeout = (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; };
  h.context.clearTimeout = (id) => timers.delete(id);
  const click = (stageId, detail) => {
    const button = { dataset: { workspaceAction: "timeline-method", id: "i1", stageId } };
    return Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener({ detail, target: { closest: (selector) => selector === "[data-workspace-action]" ? button : null } })));
  };
  await click("s1", 1); const stale = [...timers.values()][0];
  await click("s2", 1); const latest = [...timers.values()][0];
  assert.equal(timers.size, 1); stale(); assert.equal(h.app.ui.methodInspect, null);
  latest(); assert.equal(h.app.ui.methodInspect.stageId, "s2");
  await actionClick(h, { action: "close-paper-inspector" });
  await click("s1", 0); assert.equal(h.app.ui.methodInspect.stageId, "s1");
});

test("a delayed method whose contribution was removed does not open stale details", async () => {
  const h = createApp(), data = methodInspectionFixture(h); let callback;
  h.context.setTimeout = (operation) => { callback = operation; return 1; };
  const button = { dataset: { workspaceAction: "timeline-method", id: "i1", stageId: "s1" } };
  await Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener({ detail: 1, target: { closest: (selector) => selector === "[data-workspace-action]" ? button : null } })));
  data.edges.find((edge) => edge.id === "membership").contributionRefs = [];
  callback(); assert.equal(h.app.ui.methodInspect, null);
});

test("pointer links inside an open inspector wait for double clicks without replacing their target", async () => {
  for (const entry of ["stage-contribution", "paper-method"]) {
    const h = createApp(); methodInspectionFixture(h);
    h.app.ui.inspectorOpen = true; h.node(".workspace").dataset.inspectorVisible = "true";
    if (entry === "stage-contribution") h.app.ui.stageInspect = true;
    else { h.app.ui.view = "papers"; h.app.ui.selectedPaperId = "p1"; }
    h.node("#inspector").innerHTML = "Original method link";
    const timers = new Map(); let nextTimer = 0;
    h.context.setTimeout = (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; };
    h.context.clearTimeout = (id) => timers.delete(id);
    const button = { dataset: entry === "stage-contribution" ? { workspaceAction: "timeline-method", id: "i1", stageId: "s1" } : { action: "paper-view-idea", id: "i1" }, matches: () => false };
    const click = (detail) => Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener({ detail, target: { closest: (selector) => selector === (entry === "stage-contribution" ? "[data-workspace-action]" : "[data-action]") ? button : null } })));
    await click(1); assert.equal(timers.size, 1); assert.equal(h.node("#inspector").innerHTML, "Original method link");
    await click(2); assert.equal(timers.size, 0); assert.equal(h.node("#inspector").innerHTML, "Original method link");
    for (const listener of h.documentListeners.get("dblclick").callbacks) listener({ preventDefault() {}, target: { closest: () => button } });
    assert.equal(h.app.ui.view, "graph"); assert.equal(h.app.ui.selectedPaperId, "");
  }
});

test("a timeline node with an existing inspector can inspect immediately without waiting", async () => {
  const h = createApp(); methodInspectionFixture(h);
  h.app.ui.inspectorOpen = true; h.node(".workspace").dataset.inspectorVisible = "true";
  let timers = 0; h.context.setTimeout = () => { timers++; return 1; };
  const button = { dataset: { workspaceAction: "timeline-method", id: "i1", stageId: "s1" }, matches: (selector) => selector === ".timeline-node" };
  await Promise.all(h.documentListeners.get("click").callbacks.map((listener) => listener({ detail: 1, target: { closest: (selector) => selector === "[data-workspace-action]" ? button : null } })));
  assert.equal(timers, 0); assert.equal(h.app.inspectedMethod().id, "i1");
});

function mixedSourceFixture(h) {
  const data = learningFixture();
  data.papers.push({ id: "web1", sourceType: "webpage", title: "Release notes", url: "https://example.com/releases", summary: "Verified capabilities", updatedAt: "old-source" });
  data.papers.push({ id: "model1", sourceType: "model", title: "Model Alpha", url: "", summary: "Local model description" });
  data.papers.push({ id: "p2", sourceType: "paper", title: "Typed paper", year: "2026", readStatus: "read" });
  data.edges.push({ id: "web-method", fromType: "paper", fromId: "web1", toId: "i1", relation: "proposes" });
  h.app.setState(data); h.app.ui.view = "outline"; h.app.ui.selectedLineId = "family"; h.app.ui.selectedStageId = "s1";
  return data;
}
function sourceCreateForm(type = "webpage", stageId = "s1") {
  return { dataset: { workspaceForm: "source-create", workspaceDraft: `stage-source:${stageId}:${type}`, id: stageId, sourceType: type }, values: { title: "New source", url: type === "webpage" ? "https://example.com/new" : "", summary: "Source draft" } };
}

test("stage picker presents three direct types and keeps each type's drafts and search while reusing existing sources", async () => {
  const h = createApp(); mixedSourceFixture(h); h.app.openPaperPicker("stage", "s1");
  assert.equal(h.node("#picker-source-tabs").hidden, false);
  assert.match(h.node("#picker-source-tabs").innerHTML, /data-id="paper"/); assert.match(h.node("#picker-source-tabs").innerHTML, /data-id="webpage"/); assert.match(h.node("#picker-source-tabs").innerHTML, /data-id="model"/);
  assert.deepEqual(Array.from(h.app.paperPickerResults(""), (item) => item.id), ["p2"]);
  await workspaceClick(h, { workspaceAction: "picker-source-type", id: "webpage" });
  assert.deepEqual(Array.from(h.app.paperPickerResults("capabilities"), (item) => item.id), ["web1"]);
  assert.match(h.node("#picker-source-editor").innerHTML, /name="url"[^>]+required/);
  const form = sourceCreateForm(); h.app.workspaceDraft(form);
  const query = h.node("#picker-paper-query"); query.value = "Release";
  for (const listener of h.documentListeners.get("input").callbacks) listener({ target: query });
  await workspaceClick(h, { workspaceAction: "picker-source-type", id: "model" });
  assert.doesNotMatch(h.node("#picker-source-editor").innerHTML, /name="url"[^>]+required/);
  assert.deepEqual(Array.from(h.app.paperPickerResults("description"), (item) => item.id), ["model1"]);
  await workspaceClick(h, { workspaceAction: "picker-source-type", id: "webpage" });
  assert.equal(query.value, "Release"); assert.match(h.node("#picker-source-editor").innerHTML, /value="New source"/);
  h.app.openPaperPicker("method", "i1"); assert.equal(h.node("#picker-source-tabs").hidden, true);
  assert.deepEqual(Array.from(h.app.paperPickerResults(""), (item) => item.id), ["p1", "web1", "model1", "p2"]);
});

test("source creation submits the typed atomic action once, preserves a newer draft, and does not overwrite a reopened picker", async () => {
  const h = createApp(), data = mixedSourceFixture(h); h.app.openPaperPicker("stage", "s1");
  await workspaceClick(h, { workspaceAction: "picker-source-type", id: "webpage" });
  const form = sourceCreateForm(); h.app.workspaceDraft(form);
  let release, request, calls = 0;
  h.context.fetch = async (path, options) => { calls++; request = JSON.parse(options.body); await new Promise((resolve) => { release = resolve; }); return { ok: true, json: async () => ({ state: data, result: { paperId: "web1", stageId: "s1", reused: true } }) }; };
  const first = h.app.submitWorkspaceForm(form), duplicate = h.app.submitWorkspaceForm(form);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 1);
  form.values.title = "Newer draft"; h.app.workspaceDraft(form);
  h.app.openPaperPicker("stage", "s1"); await workspaceClick(h, { workspaceAction: "picker-source-type", id: "model" });
  h.node("#picker-paper-query").value = "New context query";
  release(); await Promise.all([first, duplicate]);
  assert.deepEqual(request, { action: "stage.add_source", payload: { stageId: "s1", lineId: "family", sourceType: "webpage", title: "New source", url: "https://example.com/new", summary: "Source draft" } });
  assert.equal(h.app.ui.paperPicker.sourceType, "model"); assert.equal(h.node("#paper-picker-dialog").open, true); assert.equal(h.node("#picker-paper-query").value, "New context query");
  assert.equal(h.app.readDraft("stage-source:s1:webpage").title, "Newer draft");
});

test("creating a model for stage method annotation allows no URL and selects the returned reused source", async () => {
  const h = createApp(), data = mixedSourceFixture(h); h.app.openPaperPicker("stage-method", "s1");
  await workspaceClick(h, { workspaceAction: "picker-source-type", id: "model" });
  assert.deepEqual(Array.from(h.app.paperPickerResults(""), (item) => item.id), ["model1"]);
  const form = sourceCreateForm("model"); h.app.workspaceDraft(form);
  let request;
  h.context.fetch = async (path, options) => { request = JSON.parse(options.body); data.edges.push({ id: "model-member", fromType: "paper", fromId: "model1", toType: "stage", toId: "s1", relation: "documents" }); return { ok: true, json: async () => ({ state: data, result: { paperId: "model1", stageId: "s1", reused: true } }) }; };
  await h.app.submitWorkspaceForm(form);
  assert.equal(request.payload.url, ""); assert.equal(request.payload.sourceType, "model");
  assert.equal(h.app.ui.stageMethodPaperId, "model1"); assert.equal(h.node("#paper-picker-dialog").open, false); assert.equal(h.app.readDraft("stage-source:s1:model"), null);
  assert.match(h.node("#inspector").innerHTML, /data-id="model1" data-stage-id="s1"/);
});

test("existing web sources can join a stage through its method picker without creating duplicate sources", async () => {
  const h = createApp(), data = mixedSourceFixture(h); h.app.openPaperPicker("stage-method", "s1");
  await workspaceClick(h, { workspaceAction: "picker-source-type", id: "webpage" });
  let request;
  h.context.fetch = async (path, options) => { request = JSON.parse(options.body); data.edges.push({ id: "web-member", fromType: "paper", fromId: "web1", toType: "stage", toId: "s1", relation: "documents" }); return { ok: true, json: async () => ({ state: data, result: { paperId: "web1", stageId: "s1" } }) }; };
  await workspaceClick(h, { workspaceAction: "pick-paper", id: "web1" });
  assert.equal(request.action, "paper.add_to_stage"); assert.equal(request.payload.paperId, "web1"); assert.equal(data.papers.length, 4);
  assert.equal(h.app.ui.stageMethodPaperId, "web1"); assert.equal(h.node("#paper-picker-dialog").open, false);
});

test("web source details edit local fields, open a safe external link, and reuse method and stage forms without PDF sections", () => {
  const h = createApp(), data = mixedSourceFixture(h);
  data.edges.push({ id: "web-member", fromType: "paper", fromId: "web1", toType: "stage", toId: "s1", relation: "documents" });
  h.app.renderPaperInspector(data.papers[1]); const html = h.node("#inspector").innerHTML;
  assert.match(html, /网页/); assert.match(html, /data-workspace-form="source-update"/); assert.match(html, /data-workspace-draft="source:web1"/);
  assert.match(html, /href="https:\/\/example.com\/releases" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Verified capabilities/); assert.match(html, /data-workspace-form="annotate-method"/); assert.match(html, /data-workspace-action="method-stage"/);
  assert.doesNotMatch(html, /参考文献分析|引用的论文|引用它的论文|Zotero 批注|DOI/);
  data.papers[1].url = 'javascript:alert(1)'; h.app.renderPaperInspector(data.papers[1]); assert.match(h.node("#inspector").innerHTML, /href="#"/);
  h.app.renderPaperInspector(data.papers[0]); assert.match(h.node("#inspector").innerHTML, /参考文献分析/); assert.doesNotMatch(h.node("#inspector").innerHTML, /data-workspace-form="source-update"/);
});

test("source editing keeps drafts on failure and conflict, follows the latest base, and does not change the source type", async () => {
  const h = createApp(), data = mixedSourceFixture(h); h.app.ui.selectedPaperId = "web1";
  const form = { dataset: { workspaceForm: "source-update", workspaceDraft: "source:web1", id: "web1", sourceType: "webpage" }, values: { title: "Edited web", url: "https://example.com/edited", summary: "Local draft" } };
  h.app.workspaceDraft(form); assert.equal(h.app.readDraft("source:web1").baseUpdatedAt, "old-source");
  const requests = [];
  h.context.fetch = async (path, options) => {
    if (path === "/api/state") { data.papers[1].updatedAt = "new-source"; return { ok: true, json: async () => data }; }
    requests.push(JSON.parse(options.body)); return { ok: false, json: async () => ({ error: "别的页面改过" }) };
  };
  await assert.rejects(h.app.submitWorkspaceForm(form), /别的页面改过/);
  assert.equal(h.app.readDraft("source:web1").summary, "Local draft"); assert.equal(h.app.readDraft("source:web1").baseUpdatedAt, "new-source");
  assert.equal(requests[0].payload.sourceType, undefined); assert.equal(requests[0].payload.baseUpdatedAt, "old-source");
  h.context.fetch = async (path, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ state: data, result: { paperId: "web1" } }) }; };
  await h.app.submitWorkspaceForm(form); assert.equal(requests[1].payload.baseUpdatedAt, "new-source"); assert.equal(h.app.readDraft("source:web1"), null);
});

test("source edits typed during a save keep their values and advance the base for the next real submission", async () => {
  const h = createApp(), data = mixedSourceFixture(h); h.app.ui.selectedPaperId = "web1";
  const form = { dataset: { workspaceForm: "source-update", workspaceDraft: "source:web1", id: "web1", sourceType: "webpage" }, values: { title: "First title", url: "https://example.com/first", summary: "First summary" } };
  h.app.workspaceDraft(form);
  const other = { dataset: { workspaceForm: "source-update", workspaceDraft: "source:model1", id: "model1", sourceType: "model" }, values: { title: "Other draft", url: "", summary: "Keep other source" } };
  h.app.workspaceDraft(other); const otherDraft = JSON.stringify(h.app.readDraft("source:model1"));
  let release; const requests = [];
  h.context.fetch = async (path, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    if (requests.length === 1) await new Promise((resolve) => { release = resolve; });
    const source = data.papers.find((item) => item.id === request.payload.id);
    if (request.payload.baseUpdatedAt !== source.updatedAt) return { ok: false, json: async () => ({ error: "别的页面改过" }) };
    Object.assign(source, { title: request.payload.title, url: request.payload.url, summary: request.payload.summary, updatedAt: `saved-${requests.length}` });
    return { ok: true, json: async () => ({ state: data, result: { paperId: source.id } }) };
  };
  const first = h.app.submitWorkspaceForm(form);
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(requests.length, 1);
  form.values = { title: "Newer title", url: "https://example.com/newer", summary: "Newer summary" }; h.app.workspaceDraft(form);
  release(); await first;
  assert.deepEqual(JSON.parse(JSON.stringify(h.app.readDraft("source:web1"))), { ...form.values, baseUpdatedAt: "saved-1" });
  assert.equal(JSON.stringify(h.app.readDraft("source:model1")), otherDraft);
  await h.app.submitWorkspaceForm(form);
  assert.equal(requests.length, 2); assert.equal(requests[1].payload.baseUpdatedAt, "saved-1");
  assert.equal(requests[1].payload.title, "Newer title"); assert.equal(requests[1].payload.summary, "Newer summary");
  assert.equal(h.app.readDraft("source:web1"), null); assert.equal(data.papers[1].updatedAt, "saved-2");
  assert.equal(JSON.stringify(h.app.readDraft("source:model1")), otherDraft);
});

test("a successful source save does not replace a draft base that changed independently", async () => {
  const h = createApp(), data = mixedSourceFixture(h); h.app.ui.selectedPaperId = "web1";
  const form = { dataset: { workspaceForm: "source-update", workspaceDraft: "source:web1", id: "web1", sourceType: "webpage" }, values: { title: "First", url: "https://example.com/first", summary: "First" } };
  h.app.workspaceDraft(form); let release;
  h.context.fetch = async () => { await new Promise((resolve) => { release = resolve; }); data.papers[1].updatedAt = "saved"; return { ok: true, json: async () => ({ state: data, result: { paperId: "web1" } }) }; };
  const first = h.app.submitWorkspaceForm(form); await new Promise((resolve) => setImmediate(resolve));
  const newer = { ...form.values, summary: "Independent draft", baseUpdatedAt: "independent-base" };
  Object.assign(h.app.readDraft("source:web1"), newer);
  release(); await first;
  assert.deepEqual(JSON.parse(JSON.stringify(h.app.readDraft("source:web1"))), newer);
});

test("invalid web URLs are rejected before writes, model URLs may be empty, and failed source creation is retryable", async () => {
  const h = createApp(), data = mixedSourceFixture(h); h.app.openPaperPicker("stage", "s1"); await workspaceClick(h, { workspaceAction: "picker-source-type", id: "webpage" });
  const form = sourceCreateForm(); form.values.url = ""; h.app.workspaceDraft(form);
  let calls = 0; h.context.fetch = async () => { calls++; return { ok: false, json: async () => ({ error: "Network failed" }) }; };
  await assert.rejects(h.app.submitWorkspaceForm(form), /HTTP/); assert.equal(calls, 0);
  form.values.url = "https://example.com/new"; h.app.workspaceDraft(form);
  await assert.rejects(h.app.submitWorkspaceForm(form), /Network failed/); await assert.rejects(h.app.submitWorkspaceForm(form), /Network failed/);
  assert.equal(calls, 2); assert.equal(h.app.readDraft("stage-source:s1:webpage").summary, "Source draft"); assert.equal(form.dataset.saving, undefined);
});

test("mixed sources never enter citation maps, paper counts or citation recommendations but remain searchable and labeled in the library and idea graph", () => {
  const h = createApp(), data = mixedSourceFixture(h);
  data.citations = [{ fromId: "p1", toId: "p2" }, { fromId: "web1", toId: "p1" }, { fromId: "p1", toId: "model1" }];
  data.recommendations = [{ id: "r1", title: "Candidate", citingIds: ["web1", "p1", "model1"] }]; h.app.ui.recommendationAll = true;
  h.app.ui.selectedPaperId = "web1";
  assert.deepEqual(Array.from(h.app.mapPapers(), (item) => item.id), ["p1", "p2"]); assert.equal(h.app.validCitations().length, 1);
  assert.deepEqual(Array.from(h.app.paperMapLayout().nodes, (item) => item.item.id).sort(), ["p1", "p2"]);
  assert.equal(h.app.libraryCitationCounts().has("web1"), false);
  assert.equal(h.app.rankedRecommendations().length, 0);
  data.recommendations[0].citingIds.push("p2");
  assert.equal(h.app.rankedRecommendations()[0].citationCount, 2);
  h.app.renderPaperMap(); assert.match(h.node("#main-view").innerHTML, /<b>2<\/b> 篇论文/); assert.match(h.node("#main-view").innerHTML, /<b>1<\/b> 未读/); assert.match(h.node("#main-view").innerHTML, /<b>1<\/b> 已读/);
  assert.deepEqual(Array.from(h.app.searchPapers("capabilities"), (item) => item.id), ["web1"]);
  assert.deepEqual(Array.from(h.app.searchPapers("example.com/releases"), (item) => item.id), ["web1"]);
  h.app.renderPaperResults(); assert.match(h.node("#paper-search-results").innerHTML, /source-badge/);
  const graph = h.app.graphMarkup(data.ideas[0]); assert.match(graph, /项资料/); assert.match(graph, /网页/); assert.match(graph, /Release notes/);
});

test("new idea cards offer every reading line and preserve the selected model family and explicit draft choice", () => {
  const h = createApp(), data = learningFixture();
  data.lines.push({ id: "other-family", title: "Another family", kind: "model_family", ideaIds: [], stageIds: [] });
  h.app.setState(data); h.app.ui.selectedLineId = "family";
  h.app.openIdeaDialog();
  const choices = h.node("#idea-line").innerHTML;
  for (const path of data.lines) assert.match(choices, new RegExp(`value="${path.id}"`));
  assert.match(choices, /value="family" selected/);
  assert.match(choices, /value="">暂不加入阅读线/);
  h.node("#idea-title").value = "Saved question";
  h.node("#idea-line").value = "other-family";
  h.app.captureDialogDraft({ id: "idea-form" });
  h.app.openIdeaDialog();
  assert.equal(h.node("#idea-line").value, "other-family");
  assert.equal(h.node("#idea-title").value, "Saved question");
  h.node("#idea-line").value = "";
  h.app.captureDialogDraft({ id: "idea-form" });
  h.app.openIdeaDialog();
  assert.equal(h.node("#idea-line").value, "");
});

test("creating and reusing an idea send the chosen model family without creating a stage or another line", async () => {
  for (const action of ["idea.create", "idea.reuse"]) {
    const h = createApp(), data = learningFixture(); h.app.setState(data); h.app.ui.selectedLineId = "family";
    h.app.openIdeaDialog(); h.node("#idea-title").value = "GRPO"; h.node("#idea-line").value = "family";
    const requests = [];
    h.context.fetch = async (path, options) => {
      const request = JSON.parse(options.body); requests.push(request);
      return { ok: true, json: async () => ({ state: data, result: { ideaId: "i1", lineId: "family" } }) };
    };
    const before = JSON.stringify(data);
    if (action === "idea.create") await h.node("#idea-form").listeners.submit({ preventDefault() {} });
    else await actionClick(h, { action: "reuse-idea", id: "i1" });
    assert.equal(requests.length, 1); assert.equal(requests[0].action, action);
    assert.equal(requests[0].payload.lineId, "family");
    if (action === "idea.reuse") assert.equal(requests[0].payload.id, "i1");
    assert.equal(JSON.stringify(data), before);
  }
});

test("model family line cards stay visible with or without stages and never infer stage contributions", () => {
  for (const hasStages of [true, false]) {
    const h = createApp(), data = methodInspectionFixture(h), current = data.lines[1];
    data.ideas[1].entityType = "concept"; data.ideas[1].title = "Line concept";
    data.ideas.push({ ...data.ideas[1], id: "question", title: "Line question", entityType: "question" });
    data.ideas.push({ ...data.ideas[1], id: "outside", title: "Unlinked idea" });
    current.ideaIds = ["i1", "i2", "question"];
    if (!hasStages) current.stageIds = [];
    const before = JSON.stringify(data);
    h.app.renderStageLine(current);
    const html = h.node("#main-view").innerHTML, section = html.slice(html.indexOf('<section class="line-ideas">'));
    assert.match(section, /本线思想卡（未指定阶段）/);
    assert.match(section, /class="card-tabs"/); assert.doesNotMatch(section, /class="idea-catalog"/);
    assert.match(section, /data-action="new-idea"/); assert.match(section, /data-action="attach-idea"/);
    assert.match(section, /data-action="paper-view-idea" data-id="i1"/);
    assert.match(section, /data-action="select-idea" data-id="i2"/);
    assert.match(section, /data-action="select-idea" data-id="question"/);
    assert.doesNotMatch(section, /Unlinked idea|data-stage-id|timeline-method/);
    assert.ok(html.indexOf('<section class="line-ideas">') > html.indexOf(hasStages ? 'class="timeline-scroll"' : '这条阅读线还没有阶段'));
    assert.equal(JSON.stringify(data), before);
  }
});

test("line methods inspect on click and open the graph on double click while concepts and questions open their editor", async () => {
  const h = createApp(), data = methodInspectionFixture(h); data.lines[1].ideaIds = ["i1", "i2", "question"];
  data.ideas[1].entityType = "concept";
  data.ideas.push({ ...data.ideas[1], id: "question", title: "Line question", entityType: "question" });
  h.app.renderStageLine(data.lines[1]); const timeline = h.node("#main-view").innerHTML;
  await actionClick(h, { action: "paper-view-idea", id: "i1" });
  assert.equal(h.app.ui.view, "outline"); assert.equal(h.app.inspectedMethod().id, "i1");
  assert.equal(h.app.ui.methodInspect.stageId, ""); assert.equal(h.node("#main-view").innerHTML, timeline);
  const button = { dataset: { action: "paper-view-idea", id: "i1" } };
  for (const listener of h.documentListeners.get("dblclick").callbacks) listener({ preventDefault() {}, target: { closest: () => button } });
  assert.equal(h.app.ui.view, "graph"); assert.equal(h.app.ui.selectedIdeaId, "i1");
  for (const id of ["i2", "question"]) {
    h.app.ui.view = "outline"; h.app.ui.stageInspect = true;
    await actionClick(h, { action: "select-idea", id });
    assert.equal(h.app.ui.view, "graph"); assert.equal(h.app.ui.selectedIdeaId, id); assert.equal(h.app.ui.stageInspect, false);
    assert.match(h.node("#main-view").innerHTML, new RegExp(`id="idea-edit-form"[^>]*data-id="${id}"`));
    const draft = { dataset: { id }, values: { title: "Edited idea", summary: "Editable from this line" } };
    h.app.captureIdeaDraft(draft); assert.equal(h.app.readDraft(`idea:${id}`).summary, "Editable from this line");
  }
});


test("idea catalog cards safely show complete titles, metadata, previews and unique existing source counts", () => {
  const h = createApp(), data = fixture();
  Object.assign(data.ideas[0], { title: 'A very long method <title> & "quoted" '.repeat(8), entityType: "method", status: "learning", summary: '<img src=x onerror="bad"> Summary & explanation' });
  data.papers.push({ id: "web", title: "Web", sourceType: "webpage" }, { id: "model", title: "Model", sourceType: "model" });
  data.edges.push(
    { fromType: "paper", fromId: "p1", toId: "i1", relation: "proposes" },
    { fromType: "paper", fromId: "web", toType: "idea", toId: "i1", relation: "uses" },
    { fromType: "paper", fromId: "model", toType: "idea", toId: "i1", relation: "improves" },
    { fromType: "paper", fromId: "web", toType: "idea", toId: "i1", relation: "uses" },
    { fromType: "paper", fromId: "missing", toId: "i1" },
    { fromType: "paper", fromId: "p1", toType: "stage", toId: "i2" },
    { fromType: "idea", fromId: "web", toId: "i2" },
  );
  h.app.setState(data); const before = JSON.stringify(data);
  const cards = h.app.ideaCardsMarkup(data.ideas, "i1");
  assert.match(cards, /class="idea-catalog-card active" data-action="paper-view-idea" data-id="i1"/);
  assert.match(cards, /data-user-label aria-pressed="true"/);
  assert.match(cards, /idea-catalog-title" data-user-content>A very long method &lt;title&gt; &amp; &quot;quoted&quot;/);
  assert.match(cards, /<span>方法<\/span><span>正在学<\/span><span>3 项关联资料<\/span>/);
  assert.match(cards, /idea-catalog-preview" data-user-content>&lt;img src=x onerror=&quot;bad&quot;&gt; Summary &amp; explanation/);
  assert.match(cards, /<span>尚未分类<\/span><span>待学<\/span><span>0 项关联资料<\/span>/);
  assert.match(cards, /data-action="select-idea" data-id="i2"/);
  assert.doesNotMatch(cards, /<img|<title>/);
  assert.equal(JSON.stringify(data), before);
  assert.match(h.app.ideaCardMarkup({ ...data.ideas[1], summary: "  ", mechanism: "Mechanism <text>" }, 0), /data-user-content>Mechanism &lt;text&gt;/);
  assert.match(h.app.ideaCardMarkup({ ...data.ideas[1], summary: "", aliases: ["Alias & name"] }, 0), /data-user-content>Alias &amp; name/);
  assert.match(h.app.ideaCardMarkup({ ...data.ideas[1], summary: "" }, 0), /idea-catalog-preview">暂无摘要/);
});

test("method search updates shared catalog cards and keeps the input, caret, selection and graph context", () => {
  const h = createApp(), data = methodInspectionFixture(h);
  h.app.ui.view = "graph"; h.app.ui.selectedIdeaId = "i2";
  data.ideas[1].entityType = "method"; data.ideas[1].aliases = ["Find Alias"]; data.ideas[1].summary = "Search preview";
  h.app.renderMethodsWorkspace();
  const main = h.node("#main-view").innerHTML, input = h.node("#method-search");
  const context = JSON.stringify({ line: h.app.ui.selectedLineId, idea: h.app.ui.selectedIdeaId, stage: h.app.ui.selectedStageId });
  input.value = "Find Alias"; input.selectionStart = 3; input.selectionEnd = 7;
  h.node("#method-results").scrollTop = 90;
  for (const listener of h.documentListeners.get("input").callbacks) listener({ target: input });
  assert.equal(h.node("#method-search"), input); assert.equal(input.value, "Find Alias");
  assert.equal(input.selectionStart, 3); assert.equal(input.selectionEnd, 7);
  assert.equal(h.node("#main-view").innerHTML, main);
  const cards = h.node("#method-results").innerHTML;
  assert.equal(cards, h.app.ideaCardsMarkup([data.ideas[1]], "i2", "paper-view-idea"));
  assert.match(cards, /idea-catalog-card active/); assert.match(cards, /aria-pressed="true"/);
  assert.match(cards, /Search preview/); assert.doesNotMatch(cards, /data-id="i1"/);
  assert.equal(h.node("#method-results").scrollTop, 90);
  assert.equal(JSON.stringify({ line: h.app.ui.selectedLineId, idea: h.app.ui.selectedIdeaId, stage: h.app.ui.selectedStageId }), context);
});

test("selecting a method and rerendering preserves catalog scroll position", async () => {
  const h = createApp(), data = methodInspectionFixture(h); data.ideas[1].entityType = "method"; h.app.ui.view = "graph";
  h.app.renderMethodsWorkspace(); h.node("#method-results").scrollTop = 276;
  const main = h.node("#main-view"); let html = main.innerHTML;
  Object.defineProperty(main, "innerHTML", { get: () => html, set: (value) => { html = value; h.node("#method-results").scrollTop = 0; } });
  await actionClick(h, { action: "paper-view-idea", id: "i2" });
  assert.equal(h.app.ui.selectedIdeaId, "i2"); assert.equal(h.node("#method-results").scrollTop, 276);
  assert.match(html, /idea-catalog-card active" data-action="paper-view-idea" data-id="i2"/);
  h.app.renderMethodsWorkspace(); assert.equal(h.node("#method-results").scrollTop, 276);
});

test("catalog user labels stay literal while UI metadata translates between Chinese and English", () => {
  const attributes = { "aria-label": "设置", "data-user-label": "" };
  const card = { closest: () => null, hasAttribute: (name) => name in attributes, getAttribute: (name) => attributes[name], setAttribute: (name, value) => { attributes[name] = value; } };
  const nodes = [
    { nodeValue: "设置", parentElement: { closest: () => ({}) } },
    { nodeValue: "方法", parentElement: { closest: () => null } },
    { nodeValue: "暂无摘要", parentElement: { closest: () => null } },
  ];
  const context = vm.createContext({ document: { documentElement: {}, createTreeWalker() { let index = -1; return { nextNode: () => ++index < nodes.length, get currentNode() { return nodes[index]; } }; } }, NodeFilter: { SHOW_TEXT: 4 } });
  vm.runInContext(i18nSource, context);
  const root = { querySelectorAll: () => [card] };
  context.PaperLineI18n.apply(root, "en");
  assert.equal(attributes["aria-label"], "设置"); assert.deepEqual(nodes.map((node) => node.nodeValue), ["设置", "Method", "No summary yet"]);
  context.PaperLineI18n.apply(root, "zh");
  assert.equal(attributes["aria-label"], "设置"); assert.deepEqual(nodes.map((node) => node.nodeValue), ["设置", "方法", "暂无摘要"]);
});


test("method catalog restores only a previously focused catalog card after rebuilding", () => {
  const h = createApp(); methodInspectionFixture(h); h.app.ui.view = "graph";
  let focusOptions, focusCalls = 0;
  const restored = { dataset: { id: "i1" }, focus(options) { focusCalls++; focusOptions = options; } };
  h.context.document.querySelectorAll = (selector) => selector === "#method-results .idea-catalog-card" ? [restored] : [];
  h.context.document.activeElement = { closest: (selector) => selector === "#method-results .idea-catalog-card" ? restored : null };
  h.app.renderMethodsWorkspace(); assert.equal(focusCalls, 1); assert.equal(focusOptions.preventScroll, true);
  h.context.document.activeElement = { closest: () => null };
  h.app.renderMethodsWorkspace(); assert.equal(focusCalls, 1);
});


function attachPickerFixture() {
  const h = createApp(), data = fixture();
  data.ideas.push({ id: "i3", title: "Method <long> & name", aliases: ["Third alias"], entityType: "method", status: "learning", summary: "A searchable mechanism <script>" });
  data.ideas.push({ id: "i4", title: "Question card", aliases: [], entityType: "question", status: "understood", summary: "A second searchable note" });
  data.lines.push({ id: "l2", title: "Other <path>", ideaIds: [], activeIdeaId: "", stages: [] });
  h.app.setState(data);
  h.context.renderCalls = [];
  vm.runInContext("const originalAttachRender = render; render = (options) => { renderCalls.push(options); };", h.context);
  h.clickAttach = (id) => {
    const button = { dataset: { action: "attach-picker-add", id }, disabled: false, setAttribute(key, value) { this[key] = value; } };
    return { button, done: h.documentListeners.get("click").callbacks[0]({ target: { closest: () => button } }) };
  };
  h.searchAttach = (query) => {
    const input = h.node("#attach-search"); input.value = query;
    for (const listener of h.documentListeners.get("input").callbacks) listener({ target: input });
  };
  return { ...h, data };
}

test("attach picker searches titles aliases and summaries while keeping typed cards, escaped content and joined rows", () => {
  const h = attachPickerFixture(), before = JSON.stringify(h.data);
  h.app.openAttachPicker("l1");
  assert.equal(h.node("#attach-line-title").textContent, "Research");
  const html = h.node("#attach-results").innerHTML;
  assert.match(html, /data-id="i1"[^>]*disabled/);
  assert.match(html, /data-id="i2"[^>]*disabled/);
  assert.match(html, /data-user-content>Method &lt;long&gt; &amp; name/);
  assert.match(html, /data-user-content>A searchable mechanism &lt;script&gt;/);
  assert.match(html, /<span>方法<\/span><span>正在学<\/span>/);
  assert.match(html, /<span>问题<\/span><span>已理解<\/span>/);
  assert.doesNotMatch(html, /data-action="(?:select-idea|paper-view-idea)"/);
  for (const query of ["Method <long>", "third ALIAS", "searchable mechanism"]) {
    h.searchAttach(query);
    assert.match(h.node("#attach-results").innerHTML, /data-id="i3"/);
    assert.doesNotMatch(h.node("#attach-results").innerHTML, /data-id="i4"/);
    assert.equal(h.node("#attach-search").value, query);
  }
  h.searchAttach("unmatched"); assert.match(h.node("#attach-results").innerHTML, /没有找到匹配的卡片/);
  assert.equal(JSON.stringify(h.data), before);
  assert.equal(h.storage.size, 0);
  assert.equal(h.context.renderCalls.length, 0);
});

test("attach picker exposes friendly empty and all joined states without a submitting form", () => {
  const h = attachPickerFixture();
  h.data.lines[0].ideaIds = h.data.ideas.map((item) => item.id);
  h.app.openAttachPicker("l1");
  assert.match(h.node("#attach-picker-note").textContent, /所有卡片都已加入/);
  assert.equal((h.node("#attach-results").innerHTML.match(/ disabled/g) || []).length, 4);
  h.data.ideas = [];
  h.app.renderAttachPicker(); assert.match(h.node("#attach-results").innerHTML, /还没有可加入的卡片/);
  const html = readFileSync(resolve(__dirname, "../static/index.html"), "utf8").split('<dialog id="attach-dialog"')[1].split("</dialog>")[0];
  assert.doesNotMatch(html, /<form|type="submit"|<select/);
  assert.match(html, /id="attach-search" type="search"/);
  assert.match(html, /type="button"[^>]*>完成/);
  assert.doesNotMatch(appSource, /#attach-form|#attach-idea/);
});

test("real attach clicks target the captured path once, permit sequential adds and retain query and scroll", async () => {
  const h = attachPickerFixture(), original = JSON.parse(JSON.stringify(h.data));
  const writes = []; let finish;
  h.context.fetch = (url, options) => {
    writes.push({ url, ...JSON.parse(options.body) });
    return new Promise((resolve) => { finish = resolve; });
  };
  h.app.openAttachPicker("l1"); h.searchAttach("searchable");
  h.node("#attach-search").selectionStart = 4;
  h.node("#attach-results").scrollTop = 90;
  const first = h.clickAttach("i3");
  assert.equal(first.button.disabled, true);
  await Promise.resolve(); await Promise.resolve();
  await h.clickAttach("i3").done;
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { url: "/api/action", action: "line.attach", payload: { lineId: "l1", ideaId: "i3" } });
  const persisted = JSON.parse(JSON.stringify(h.data)); persisted.lines[0].ideaIds.push("i3");
  finish({ ok: true, json: async () => ({ state: persisted, result: { lineId: "WRONG", ideaId: "WRONG" } }) });
  await first.done;
  assert.equal(h.node("#attach-dialog").open, true);
  assert.equal(h.app.ui.selectedLineId, "l1"); assert.equal(h.app.ui.selectedIdeaId, "");
  assert.equal(h.node("#attach-search").value, "searchable");
  assert.equal(h.node("#attach-search").selectionStart, 4);
  assert.equal(h.node("#attach-results").scrollTop, 90);
  assert.match(h.node("#attach-results").innerHTML, /data-id="i3"[^>]*disabled/);
  h.context.fetch = async (url, options) => {
    writes.push({ url, ...JSON.parse(options.body) });
    const next = JSON.parse(JSON.stringify(persisted)); next.lines[0].ideaIds.push("i4");
    return { ok: true, json: async () => ({ state: next, result: {} }) };
  };
  await h.clickAttach("i4").done;
  assert.equal(writes.length, 2); assert.equal(h.node("#attach-dialog").open, true);
  assert.equal(h.node("#attach-search").value, "searchable");
  assert.deepEqual(h.context.renderCalls.map((value) => value.preserveSelection), [true, true]);
  assert.equal(JSON.stringify(h.data), JSON.stringify(original));
  assert.deepEqual(JSON.parse(JSON.stringify(h.app.searchIdeas("").map((item) => item))), original.ideas);
  assert.equal(h.storage.size, 0);
});

test("failed attachment retains cards and query, releases the pending guard and allows retry", async () => {
  const h = attachPickerFixture(); let writes = 0;
  h.context.fetch = async () => { writes++; return { ok: false, json: async () => ({ error: "Connection failed" }) }; };
  h.app.openAttachPicker("l1"); h.searchAttach("Third alias");
  await h.clickAttach("i3").done;
  assert.equal(h.node("#attach-feedback").textContent, "Connection failed");
  assert.match(h.node("#attach-results").innerHTML, /data-id="i3"/);
  assert.doesNotMatch(h.node("#attach-results").innerHTML, / disabled/);
  await h.clickAttach("i3").done;
  assert.equal(writes, 2); assert.equal(h.node("#attach-search").value, "Third alias");
  assert.equal(h.node("#attach-dialog").open, true);
});

test("a slow path A attachment never hijacks reopened path B or its search and focus", async () => {
  const h = attachPickerFixture(); let finish;
  h.context.fetch = () => new Promise((resolve) => { finish = resolve; });
  h.app.openAttachPicker("l1");
  const first = h.clickAttach("i3"); await Promise.resolve(); await Promise.resolve();
  h.app.closeDialog(h.node("#attach-dialog"));
  h.app.ui.selectedLineId = "l2"; h.app.ui.view = "papers"; h.app.ui.selectedPaperId = "p1";
  h.app.ui.selectedStageId = "new-stage";
  h.app.openAttachPicker("l2"); h.searchAttach("Question");
  const contextB = h.app.ui.attachPicker, htmlB = h.node("#attach-results").innerHTML;
  h.context.document.activeElement = h.node("#attach-search");
  const persisted = JSON.parse(JSON.stringify(h.data)); persisted.lines[0].ideaIds.push("i3");
  finish({ ok: true, json: async () => ({ state: persisted, result: { lineId: "l1", ideaId: "i3" } }) });
  await first.done;
  assert.equal(h.app.ui.attachPicker, contextB);
  assert.equal(h.node("#attach-dialog").open, true);
  assert.equal(h.node("#attach-line-title").textContent, "Other <path>");
  assert.equal(h.node("#attach-search").value, "Question");
  assert.equal(h.node("#attach-results").innerHTML, htmlB);
  assert.equal(h.app.ui.selectedLineId, "l2"); assert.equal(h.app.ui.view, "papers");
  assert.equal(h.app.ui.selectedStageId, "new-stage"); assert.equal(h.app.ui.selectedPaperId, "p1");
  assert.equal(h.context.document.activeElement, h.node("#attach-search"));
  assert.deepEqual(persisted.ideas, h.data.ideas); assert.deepEqual(persisted.edges, h.data.edges);
  assert.deepEqual(persisted.lines[1], h.data.lines[1]);
});


test("an attachment refresh clears deleted selections without auto selecting its original path", async () => {
  const h = attachPickerFixture(); let finish;
  vm.runInContext("render = originalAttachRender;", h.context);
  h.context.fetch = () => new Promise((resolve) => { finish = resolve; });
  h.app.openAttachPicker("l1");
  const first = h.clickAttach("i3"); await Promise.resolve(); await Promise.resolve();
  h.app.closeDialog(h.node("#attach-dialog"));
  h.app.ui.selectedLineId = "l2"; h.app.ui.selectedPaperId = "removed-paper"; h.app.ui.selectedIdeaId = "removed-idea";
  h.app.ui.view = "papers";
  const persisted = JSON.parse(JSON.stringify(h.data)); persisted.lines = [persisted.lines[0]];
  persisted.lines[0].ideaIds.push("i3");
  finish({ ok: true, json: async () => ({ state: persisted, result: { lineId: "l1", ideaId: "i3" } }) });
  await first.done;
  assert.equal(h.app.ui.selectedLineId, ""); assert.equal(h.app.ui.selectedPaperId, ""); assert.equal(h.app.ui.selectedIdeaId, "");
  assert.equal(h.app.ui.view, "papers");
  assert.equal(h.node("#attach-feedback").textContent, "");
});

test("different attachment clicks queue writes and preserve every accepted membership", async () => {
  const h = attachPickerFixture(), requests = [], resolvers = [];
  h.context.fetch = (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Promise((resolve) => resolvers.push(resolve));
  };
  h.app.openAttachPicker("l1");
  const first = h.clickAttach("i3"), second = h.clickAttach("i4");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(requests.length, 1); assert.equal(second.button.disabled, true);
  const state1 = JSON.parse(JSON.stringify(h.data)); state1.lines[0].ideaIds.push("i3");
  resolvers[0]({ ok: true, json: async () => ({ state: state1, result: {} }) });
  await first.done; await Promise.resolve(); await Promise.resolve();
  assert.equal(requests.length, 2);
  assert.match(h.node("#attach-results").innerHTML, /data-id="i4"[^>]*disabled/);
  const state2 = JSON.parse(JSON.stringify(state1)); state2.lines[0].ideaIds.push("i4");
  resolvers[1]({ ok: true, json: async () => ({ state: state2, result: {} }) });
  await second.done;
  assert.equal((h.node("#attach-results").innerHTML.match(/>已加入<\/button>/g) || []).length, 4);
  assert.equal(h.node("#attach-dialog").open, true);
});

test("attachment completion moves only its own remaining focus with preventScroll and leaves search focus alone", async () => {
  const h = attachPickerFixture(); let finish, focused = [];
  const retryButton = { dataset: { id: "i3" }, disabled: false, focus(options) { focused.push({ id: "i3", ...options }); } };
  const nextButton = { dataset: { id: "i4" }, disabled: false, focus(options) { focused.push({ id: "i4", ...options }); } };
  h.node("#attach-results").querySelectorAll = (selector) => selector === "[data-action='attach-picker-add']" ? [retryButton, nextButton] : [];
  h.context.fetch = () => new Promise((resolve) => { finish = resolve; });
  h.app.openAttachPicker("l1");
  const first = h.clickAttach("i3"); await Promise.resolve(); await Promise.resolve();
  h.context.document.activeElement = first.button;
  const persisted = JSON.parse(JSON.stringify(h.data)); persisted.lines[0].ideaIds.push("i3");
  retryButton.disabled = true;
  finish({ ok: true, json: async () => ({ state: persisted, result: {} }) });
  await first.done;
  assert.deepEqual(focused, [{ id: "i4", preventScroll: true }]);
  const second = h.clickAttach("i4"); await Promise.resolve(); await Promise.resolve();
  h.context.document.activeElement = h.node("#attach-search");
  finish({ ok: false, json: async () => ({ error: "Retry" }) });
  await second.done;
  assert.equal(focused.length, 1);
  assert.equal(h.context.document.activeElement, h.node("#attach-search"));
});
