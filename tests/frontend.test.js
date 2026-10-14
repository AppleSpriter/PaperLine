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
function createApp(storage = new Map(), clock = { now: 0 }) {
  const nodes = new Map();
  const documentListeners = new Map();
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {
      id: selector.slice(1), value: "", innerHTML: "", textContent: "", dataset: {}, open: false,
      listeners: {}, classList: { toggle() {}, add() {}, remove() {} },
      addEventListener(type, callback) { this.listeners[type] = callback; },
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
      addEventListener(type, callback, options) { documentListeners.set(type, { callback, options }); },
    },
    window: { addEventListener() {} },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    FormData: class { constructor(form) { this.form = form; } entries() { return Object.entries(this.form.values); } },
    Date: class extends Date { static now() { return clock.now; } },
    fetch: () => new Promise(() => {}),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    PaperLineI18n: { translate: (value) => value, apply() {} },
  });
  vm.runInContext(appSource, context);
  const app = vm.runInContext(`({ ui, openSession, closeDialog, stopTimer, sessionSeconds, captureIdeaDraft, searchIdeas, selectIdea, latestSession, readingRecap,
    graphZoomHint, setPageZoom, zoomGraph, zoomGraphWheel, graphMarkup, orderedMapPapers, paperMapLayout, updatePaperSelection, syncInspectorLayout, syncSelection, graphNode, displayAuthors, paperInstitution, libraryCitationCounts, rankedRecommendations, renderRecommendations, openPaperLineDialog, paperReadStatus, mapPapers, validCitations, renderPaperMap, renderPaperMapResults, renderMapInspector, renderZoteroSync, applyZoteroSync, refreshZoteroSync, startZoteroSync, markPaper, renderIdeaInspector, renderInspector, renderIdeas, renderPaperResults, searchPapers, searchLines, searchEverything, markIdea, toast, readDraft, act, refreshState, formatDuration, readingTotal, renderOutline, setState(value) { state = value; } })`, context);
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
  reloaded.app.renderInspector();
  assert.match(reloaded.node("#inspector").innerHTML, /Unsaved &lt;insight&gt;/);
  assert.match(reloaded.node("#inspector").innerHTML, /value="learning" checked/);
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
