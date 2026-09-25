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
      querySelector: node,
      querySelectorAll: (selector) => selector === "dialog" ? [node("#session-dialog")] : [],
      addEventListener() {},
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
    renderIdeaInspector, renderInspector, renderIdeas, renderPaperResults, searchPapers, searchLines, searchEverything, markIdea, readDraft, act, setState(value) { state = value; } })`, context);
  app.setState(fixture());
  app.ui.selectedLineId = "l1";
  return { app, node, context, storage, clock };
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
