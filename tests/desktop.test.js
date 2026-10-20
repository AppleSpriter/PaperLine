const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const desktopSource = readFileSync(resolve(__dirname, "../static/desktop.js"), "utf8");
const appSource = readFileSync(resolve(__dirname, "../static/app.js"), "utf8");
const data = () => ({ settings: { vaultPath: "/previous-device" }, ideas: [{ id: "i1" }], lines: [{ id: "l1", ideaIds: ["i1"] }], papers: [], edges: [], sessions: [] });
const json = (value) => JSON.parse(JSON.stringify(value));
function harness(invoke) {
  const stored = new Map(), nodes = new Map(), clicks = [];
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { open: false, value: "", listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, close() {}, classList: { toggle() {}, add() {}, remove() {} } });
    return nodes.get(id);
  };
  const storage = { get length() { return stored.size; }, key: (index) => [...stored.keys()][index], getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key) };
  const context = vm.createContext({
    ...(invoke ? { __TAURI__: { core: { invoke: (command, args) => command === "api_request" && args.path === "/api/state" ? new Promise(() => {}) : invoke(command, args) } } } : {}),
    document: { addEventListener(type, fn, capture) { if (type === "click" && capture) clicks.push(fn); }, querySelector: node, querySelectorAll: () => [] },
    window: { addEventListener() {}, confirm: () => true }, localStorage: storage,
    fetch: () => new Promise(() => {}), setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    PaperLineI18n: { translate: (value) => value, apply() {} }, alert() {},
  });
  vm.runInContext(desktopSource, context);
  return { context, stored, nodes, node, bridge: context.PaperLineDesktop, click: clicks[0] };
}
function loadApp(h) {
  vm.runInContext(appSource, h.context);
  vm.runInContext('render = () => {}; noteLocalChange = () => {}; toast = () => {};', h.context);
  h.api = vm.runInContext('api', h.context);
}
test("browser bridge leaves requests and navigation on their existing paths", async () => {
  const h = harness(); loadApp(h);
  assert.equal(h.bridge.enabled, false); assert.equal(h.bridge.request, undefined); assert.equal(h.click, undefined);
  h.context.fetch = async (path) => ({ ok: true, json: async () => ({ path }) });
  assert.deepEqual(json(await h.api('/api/state')), { path: '/api/state' });
});
test("desktop API forwards JSON and preserves backend status and conflict errors", async () => {
  const calls = [];
  const h = harness(async (command, args) => { calls.push({ command, args }); return { status: 409, data: { error: 'stale', conflict: true } }; }); loadApp(h);
  await assert.rejects(h.api('/api/action', { method: 'POST', body: '{"action":"idea.update"}' }), (error) => error.message === 'stale' && error.status === 409 && error.conflict);
  assert.deepEqual(json(calls), [{ command: 'api_request', args: { method: 'POST', path: '/api/action', body: { action: 'idea.update' } } }]);
  await assert.rejects(h.bridge.request('/elsewhere'));
  await assert.rejects(h.bridge.request('/api/state', { method: 'DELETE' }));
});
test("desktop links open externally and backup uses native save without WebView navigation", async () => {
  const calls = [];
  const h = harness(async (command, args) => { calls.push({ command, args }); return command === 'api_request' ? { status: 200, data: data() } : '/chosen/file.json'; });
  for (const href of ['https://example.com/paper', 'http://example.com', 'zotero://open-pdf/library/items/ABCD?page=2', '/api/backup']) {
    let prevented = false, stopped = false;
    h.click({ target: { closest: () => ({ getAttribute: () => href }) }, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
    assert.equal(prevented && stopped, true);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.slice(0, 3).map((item) => item.command), ['open_external', 'open_external', 'open_external']);
  assert.equal(calls[3].command, 'api_request'); assert.equal(calls[4].command, 'save_backup');
  assert.deepEqual(JSON.parse(calls[4].args.contents), data());
  let prevented = false;
  h.click({ target: { closest: () => ({ getAttribute: () => '#section' }) }, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});
test("migration collects only bounded known drafts attached to existing cards and reading lines", () => {
  const h = harness();
  const drafts = {
    'paperline-draft:idea:i1': { title: 'Unsaved', summary: 'draft', kind: 'concept', status: 'learning', baseUpdatedAt: 'old' },
    'paperline-draft:session:l1:i1': { elapsed: 55, note: 'Read this', nextQuestion: 'Why?' },
    'paperline-draft:idea:missing': { title: 'Orphan' },
    'paperline-draft:session:missing:i1': { elapsed: 2, note: '', nextQuestion: '' },
    'paperline-draft:unknown:i1': {},
    'paperline-draft:idea:i2': { title: 'no card' },
    'paperline-reminded-day': 'private', 'another-app-token': 'secret',
  };
  for (const [key, value] of Object.entries(drafts)) h.stored.set(key, JSON.stringify(value));
  const migration = h.bridge.migration(data());
  assert.deepEqual(Object.keys(migration.drafts), ['paperline-draft:idea:i1', 'paperline-draft:session:l1:i1']);
  assert.equal(migration.format, 'paperline-desktop-migration'); assert.equal(migration.backup.drafts, undefined);
  migration.drafts['paperline-draft:idea:i1'].thoughts = 'x'.repeat(6001);
  migration.drafts['paperline-draft:session:l1:i1'].elapsed = -1;
  assert.equal(Object.keys(h.bridge.unpack(migration).drafts).length, 0);
  assert.throws(() => h.bridge.unpack({ ...migration, version: 2 }));
  assert.equal(h.bridge.unpack(data()).drafts, null);
});
test("migration restore changes drafts only after accepted restore and uses returned device settings", async () => {
  const h = harness(); loadApp(h);
  const key = 'paperline-draft:idea:i1'; h.stored.set(key, '{"title":"Current"}');
  h.stored.set('other-preference', 'keep');
  const packageData = { format: 'paperline-desktop-migration', version: 1, backup: data(), drafts: { [key]: { title: 'Migrated' } } };
  const restore = h.node('#restore-file').listeners.change;
  const event = { target: { files: [{ size: 100, text: async () => JSON.stringify(packageData) }] } };
  let payload;
  h.context.fetch = async (path, options) => { payload = JSON.parse(options.body); return { ok: false, status: 400, json: async () => ({ error: 'bad backup' }) }; };
  await restore(event);
  assert.equal(JSON.parse(h.stored.get(key)).title, 'Current');
  assert.equal(payload.backup.drafts, undefined);
  const returned = { ...data(), settings: { vaultPath: '/this-device' } };
  h.context.fetch = async () => ({ ok: true, json: async () => ({ state: returned, result: { kept: '/kept' } }) });
  await restore(event);
  assert.equal(JSON.parse(h.stored.get(key)).title, 'Migrated');
  assert.equal(h.stored.get('other-preference'), 'keep');
  assert.equal(vm.runInContext('state.settings.vaultPath', h.context), '/this-device');
});
test("native confirmation and folder picker do not depend on browser dialogs", async () => {
  const calls = []; const h = harness(async (name, args) => { calls.push({ name, args }); return name === 'confirm_action' ? false : '/selected-vault'; }); loadApp(h);
  h.context.window.confirm = () => { throw new Error('browser confirm used'); };
  assert.equal(await vm.runInContext('confirmAction("Replace?")', h.context), false);
  assert.equal(await h.bridge.chooseDirectory(), '/selected-vault');
  assert.deepEqual(json(calls), [{ name: 'confirm_action', args: { message: 'Replace?' } }, { name: 'choose_directory' }]);
});

test("native transport failures become readable application errors", async () => {
  const h = harness(async () => { throw "Backend unavailable"; }); loadApp(h);
  await assert.rejects(h.api('/api/backup'), (error) => error.message === 'Backend unavailable');
});

test("native backup save failures retain the filesystem error for application feedback", async () => {
  let call;
  const h = harness(async (command, args) => { call = { command, args }; throw 'Permission denied saving backup'; });
  await assert.rejects(h.bridge.saveJson(data(), 'paperline-backup.json'), (error) => error.message === 'Permission denied saving backup');
  assert.equal(call.command, 'save_backup');
  assert.deepEqual(JSON.parse(call.args.contents), data());
});

test("schema2 migration keeps stage, annotation, and creation drafts alongside legacy drafts", () => {
  const h = harness();
  const backup = { ...data(), version: 2, stages: [{ id: 's1' }], papers: [{ id: 'p1' }], edges: [{ id: 'e1' }], lines: [{ id: 'l1', kind: 'model_family', stageIds: ['s1'], ideaIds: ['i1'] }] };
  const drafts = {
    'paperline-draft:idea:i1': { title: 'Legacy card', entityType: 'method' },
    'paperline-draft:session:l1:i1': { elapsed: 12, note: '', nextQuestion: '' },
    'paperline-draft:stage:s1': { title: 'Stage', date: '2026-10-16', summary: 'Draft' },
    'paperline-draft:session:stage:s1:l1': { elapsed: 18, note: 'Read', nextQuestion: '' },
    'paperline-draft:session:stage:s1:': { elapsed: 9, note: '', nextQuestion: '' },
    'paperline-draft:paper-method:p1': { title: 'Method', note: 'Annotation', sourceUrl: '' },
    'paperline-draft:paper-stage:p1': { lineId: '', lineTitle: 'New family', stageId: '', stageTitle: 'First', date: '', summary: '' },
    'paperline-draft:stage-new:l1': { title: 'Next', date: '', summary: '' },
    'paperline-draft:line:l1': { title: 'Edited', kind: 'model_family', question: '' },
    'paperline-draft:edge:e1': { note: 'New annotation', sourceUrl: '' },
    'paperline-draft:line-new': { title: 'New line', kind: 'topic', question: '' },
    'paperline-draft:idea-new': { title: 'New method', entityType: 'method', summary: '', lineId: '', relation: '' },
  };
  for (const [key, value] of Object.entries(drafts)) h.stored.set(key, JSON.stringify(value));
  const transferred = h.bridge.unpack(h.bridge.migration(backup));
  assert.deepEqual(json(transferred.drafts), drafts);
  h.bridge.installDrafts(transferred.drafts, backup);
  assert.deepEqual(Object.keys(h.bridge.migration(backup).drafts).sort(), Object.keys(drafts).sort());
});

test("schema2 draft migration discards orphan references and clears invalid dates without losing valid drafts", () => {
  const h = harness();
  const backup = { ...data(), version: 2, stages: [{ id: 's1' }], papers: [{ id: 'p1' }] };
  const drafts = {
    'paperline-draft:stage:s1': { title: 'Valid', date: '' },
    'paperline-draft:stage:missing': { title: 'Orphan' },
    'paperline-draft:session:stage:s1:l1': { elapsed: 1, note: '', nextQuestion: '' },
    'paperline-draft:paper-stage:p1': { date: '2026-13-01', stageId: '', lineId: '' },
    'paperline-draft:paper-method:p1': { title: 'Too long', note: 'x'.repeat(3001) },
    'paperline-draft:edge:missing': { note: 'Orphan' },
  };
  const result = h.bridge.unpack({ format: 'paperline-desktop-migration', version: 1, backup, drafts });
  assert.deepEqual(Object.keys(result.drafts), ['paperline-draft:stage:s1', 'paperline-draft:paper-stage:p1']);
  assert.equal(result.drafts['paperline-draft:paper-stage:p1'].date, '');
});

test("timeline method drafts keep global and stage contexts separate and require membership", () => {
  const h = harness();
  const backup = { ...data(), version: 2, papers: [{ id: 'p1' }, { id: 'p2' }], stages: [{ id: 's1' }, { id: 's2' }], edges: [{ id: 'membership', fromType: 'paper', fromId: 'p1', toType: 'stage', toId: 's1', relation: 'documents' }] };
  const drafts = {
    'paperline-draft:paper-method:p1': { title: 'Global unsaved title', ideaId: '', note: '', sourceUrl: '' },
    'paperline-draft:paper-method:p1:s1': { title: '', ideaId: 'i1', note: 'Stage contribution', sourceUrl: '' },
    'paperline-draft:paper-method:p2:s1': { title: 'Not a stage member' },
    'paperline-draft:paper-method:p1:s2': { title: 'Different stage' },
    'paperline-draft:paper-method:p1:missing': { title: 'Missing stage' },
    'paperline-draft:paper-method:p2': { title: '', ideaId: 'missing' },
  };
  for (const [key, value] of Object.entries(drafts)) h.stored.set(key, JSON.stringify(value));
  const result = h.bridge.unpack(h.bridge.migration(backup));
  assert.deepEqual(Object.keys(result.drafts), ['paperline-draft:paper-method:p1', 'paperline-draft:paper-method:p1:s1']);
  assert.equal(result.drafts['paperline-draft:paper-method:p1'].title, 'Global unsaved title');
  assert.equal(result.drafts['paperline-draft:paper-method:p1:s1'].note, 'Stage contribution');
});

test("method draft migration preserves explicit legacy edges and rejects inconsistent endpoints", () => {
  const h = harness();
  const backup = { ...data(), version: 2, ideas: [{ id: 'i1' }, { id: 'i2' }], papers: [{ id: 'p1' }, { id: 'p2' }], stages: [{ id: 's1' }], edges: [
    { id: 'legacy', fromType: 'paper', fromId: 'p1', toId: 'i1' },
    { id: 'other-paper', fromType: 'paper', fromId: 'p2', toType: 'idea', toId: 'i1' },
    { id: 'missing-idea', fromType: 'paper', fromId: 'p1', toType: 'idea', toId: 'missing' },
    { id: 'membership', fromType: 'paper', fromId: 'p1', toType: 'stage', toId: 's1', relation: 'documents' },
  ] };
  const unpackDraft = (draft, key = 'paperline-draft:paper-method:p1') => h.bridge.unpack({ format: 'paperline-desktop-migration', version: 1, backup, drafts: { [key]: draft } }).drafts;
  for (const edgeId of ['', 'legacy']) {
    const draft = { title: '', ideaId: 'i1', edgeId, note: 'Unsaved relation', sourceUrl: '' };
    assert.deepEqual(json(unpackDraft(draft)), { 'paperline-draft:paper-method:p1': draft });
    assert.deepEqual(json(unpackDraft(draft, 'paperline-draft:paper-method:p1:s1')), { 'paperline-draft:paper-method:p1:s1': draft });
  }
  assert.equal(Object.keys(unpackDraft({ title: '', edgeId: 'legacy' })).length, 1);
  for (const draft of [
    { title: '', edgeId: 'missing' }, { title: '', edgeId: 'other-paper' },
    { title: '', edgeId: 'membership' }, { title: '', edgeId: 'missing-idea' },
    { title: '', edgeId: 'legacy', ideaId: 'i2' }, { title: '', edgeId: 'x'.repeat(41) },
  ]) assert.equal(Object.keys(unpackDraft(draft)).length, 0);
});


test("migration preserves scoped creation drafts only while their source still exists", () => {
  const h = harness(), backup = data();
  backup.papers = [{ id: "p1" }];
  const draft = { title: "Annotation draft", kind: "concept", entityType: "concept", lineId: "", relation: "uses" };
  const paperKey = 'paperline-draft:idea-new-paper:p1:' + encodeURIComponent(JSON.stringify(["zotero://open-pdf/library/items/A", "1", "excerpt", ""]));
  h.stored.set(paperKey, JSON.stringify(draft));
  h.stored.set('paperline-draft:idea-new-parent:i1', JSON.stringify(draft));
  h.stored.set('paperline-draft:idea-new', JSON.stringify({ ...draft, title: "Ordinary" }));
  h.stored.set('paperline-draft:idea-new-paper:missing:context', JSON.stringify(draft));
  const migration = h.bridge.migration(backup);
  assert.equal(Object.keys(migration.drafts).length, 3);
  assert.equal(migration.drafts[paperKey].title, "Annotation draft");
  h.bridge.installDrafts(h.bridge.unpack(migration).drafts, backup);
  assert.equal(JSON.parse(h.stored.get(paperKey)).title, "Annotation draft");
});


test("stage draft migration preserves titles and summaries when partially typed dates are invalid", () => {
  const h = harness(), backup = { ...data(), stages: [{ id: 's1' }], papers: [{ id: 'p1' }] };
  backup.lines[0].kind = 'model_family'; backup.lines[0].stageIds = ['s1'];
  for (const date of ['2026-', '2025-02-29', '0000-01-01']) {
    const drafts = {
      'paperline-draft:stage:s1': { title: 'Existing title', summary: 'Existing summary', date },
      'paperline-draft:stage-new:l1': { title: 'New title', summary: 'New summary', date },
      'paperline-draft:paper-stage:p1': { lineId: 'l1', stageId: '', stageTitle: 'Paper title', summary: 'Paper summary', date },
    };
    const result = h.bridge.unpack({ format: 'paperline-desktop-migration', version: 1, backup, drafts });
    for (const [key, draft] of Object.entries(drafts)) assert.deepEqual(json(result.drafts[key]), { ...draft, date: '' });
  }
  const rejected = h.bridge.unpack({ format: 'paperline-desktop-migration', version: 1, backup, drafts: {
    'paperline-draft:stage:s1': { title: 'Invalid field', date: '2026-', injected: 'no' },
    'paperline-draft:stage-new:l1': { title: 'Invalid length', date: 'x'.repeat(11) },
    'paperline-draft:paper-stage:p1': { stageTitle: 'Invalid reference', stageId: 'missing', date: '2026-' },
  } });
  assert.deepEqual(Object.keys(rejected.drafts), []);
});

test("migration retains typed source and stage picker drafts while rejecting orphan and forged fields", () => {
  const h = harness();
  const backup = { ...data(), version: 2, stages: [{ id: 's1' }], papers: [{ id: 'p1' }, { id: 'web1', sourceType: 'webpage' }, { id: 'model1', sourceType: 'model' }], lines: [{ id: 'l1', kind: 'model_family', stageIds: ['s1'], ideaIds: ['i1'] }] };
  const drafts = {
    'paperline-draft:source:web1': { title: 'Edited page', url: 'https://example.com', summary: 'Draft', baseUpdatedAt: 'old' },
    'paperline-draft:source:model1': { title: 'Model', url: '', summary: 'Model draft' },
    'paperline-draft:stage-source:s1:paper': { query: 'Paper query' },
    'paperline-draft:stage-source:s1:webpage': { title: 'Page', url: 'https://example.com', summary: 'New page', query: 'Search' },
    'paperline-draft:stage-source:s1:model': { title: 'Model', url: '', summary: 'New model', query: '' },
    'paperline-draft:source:p1': { title: 'Do not turn papers into local sources' },
    'paperline-draft:source:missing': { title: 'Orphan' },
    'paperline-draft:stage-source:missing:model': { title: 'Orphan stage' },
    'paperline-draft:stage-source:s1:forged': { title: 'Unknown type' },
    'paperline-draft:stage-source:s1:webpage:extra': { title: 'Invalid key' },
  };
  const result = h.bridge.unpack({ format: 'paperline-desktop-migration', version: 1, backup, drafts });
  assert.deepEqual(Object.keys(result.drafts), Object.keys(drafts).slice(0, 5));
  assert.deepEqual(json(result.drafts['paperline-draft:source:web1']), drafts['paperline-draft:source:web1']);
  const forged = h.bridge.unpack({ format: 'paperline-desktop-migration', version: 1, backup, drafts: { 'paperline-draft:source:web1': { title: 'X', sourceType: 'model' }, 'paperline-draft:stage-source:s1:model': { title: 'x'.repeat(301) } } });
  assert.deepEqual(json(forged.drafts), {});
});
