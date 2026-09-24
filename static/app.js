const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const labels = {
  kind: { concept: "基础概念", innovation: "创新思想", question: "引申问题" },
  status: { inbox: "待学", learning: "正在学", understood: "已理解" },
  paper: { proposes: "提出", uses: "使用", improves: "改进", questions: "质疑" },
  idea: { extends: "引申", depends: "依赖", compares: "对比", improves: "改进" },
};

let state = null;
const i18n = globalThis.PaperLineI18n;
function language() { return state?.settings?.language === "en" ? "en" : "zh"; }
function tr(value) { return language() === "en" ? i18n.translate(value) : value; }
function localize(root = document.body) { i18n.apply(root, language()); }
const ui = {
  view: "graph", selectedLineId: "", selectedIdeaId: "", selectedPaperId: "",
  graphExpanded: false, annotations: null, annotationPaperId: "", pendingSource: null,
  zoteroResults: [], relationFocus: null, editingEdgeId: "", session: null, timer: null,
  ideaQuery: "", pendingParentId: "",
};
const draftCache = new Map();
function readDraft(key) {
  if (!draftCache.has(key)) {
    try { draftCache.set(key, JSON.parse(localStorage.getItem(`paperline-draft:${key}`))); }
    catch { draftCache.set(key, null); }
  }
  return draftCache.get(key);
}
function writeDraft(key, draft) {
  draftCache.set(key, draft);
  try { localStorage.setItem(`paperline-draft:${key}`, JSON.stringify(draft)); } catch { /* Keep the draft in memory if storage is unavailable. */ }
}
function forgetDraft(key) {
  draftCache.delete(key);
  try { localStorage.removeItem(`paperline-draft:${key}`); } catch { /* Storage may be unavailable. */ }
}
function captureIdeaDraft(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  writeDraft(`idea:${form.dataset.id}`, values);
  const status = $("#idea-draft-status");
  if (status) { status.hidden = false; status.textContent = "草稿已保留，点击保存卡片可写入笔记。"; localize(status); }
}

function line(id) { return state.lines.find((item) => item.id === id); }
function idea(id) { return state.ideas.find((item) => item.id === id); }
function paper(id) { return state.papers.find((item) => item.id === id); }
function edge(id) { return state.edges.find((item) => item.id === id); }
function safeUrl(url) { return /^(https?:\/\/|zotero:\/\/)/i.test(url || "") ? url : "#"; }
function safeHref(url) { return esc(safeUrl(url)); }
function truncate(value, count = 38) { const text = String(value || ""); return text.length > count ? text.slice(0, count - 1) + "…" : text; }
function countUnit(count, chinese, singular, plural) { return language() === "en" ? (count === 1 ? singular : plural) : chinese; }
function normalized(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase().trim(); }
function searchIdeas(query, excludeId = "") {
  const needle = normalized(query);
  const terms = needle.split(/\s+/).filter(Boolean);
  const rank = (item) => normalized(item.title) === needle ? 0 : (item.aliases || []).some((alias) => normalized(alias) === needle) ? 1 : normalized(item.title).startsWith(needle) ? 2 : 3;
  return state.ideas.filter((item) => item.id !== excludeId && terms.every((term) => normalized([item.title, ...(item.aliases || []), item.summary, item.mechanism, item.thoughts].join(" ")).includes(term)))
    .sort((a, b) => needle ? rank(a) - rank(b) : 0);
}
function latestSession(ideaId) {
  return state.sessions.filter((session) => session.ideaId === ideaId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
function readingRecap(ideaId, compact = false) {
  const previous = latestSession(ideaId);
  if (!previous) return "";
  return `<span class="recap-label">上次读到这里</span><p data-user-content>${esc(compact ? truncate(previous.note, 95) : previous.note)}</p>${previous.nextQuestion ? `<span class="recap-label">下次要弄清</span><p data-user-content>${esc(compact ? truncate(previous.nextQuestion, 95) : previous.nextQuestion)}</p>` : ""}`;
}
function sessionHistory(ideaId) {
  const sessions = state.sessions.filter((session) => session.ideaId === ideaId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);
  if (!sessions.length) return "";
  return `<div class="inspector-section"><h3>最近阅读</h3>${sessions.map((session) => `<div class="reading-history"><time>${esc(new Date(session.createdAt).toLocaleDateString(language() === "en" ? "en-US" : "zh-CN"))}</time><p data-user-content>${esc(session.note)}</p>${session.nextQuestion ? `<span class="recap-label">下次要弄清</span><p data-user-content>${esc(session.nextQuestion)}</p>` : ""}</div>`).join("")}</div>`;
}
function ideaSourcePayload() {
  const payload = {};
  if (ui.pendingParentId) payload.fromIdeaId = ui.pendingParentId;
  const source = ui.pendingSource;
  if (source) {
    const sourceNote = [source.text ? `${tr("摘录：")}${source.text}` : "", source.comment ? `${tr("批注：")}${source.comment}` : ""].filter(Boolean).join("\n").slice(0, 3000);
    Object.assign(payload, { paperId: source.paperId, relation: $("#idea-source-relation").value, sourceNote, sourceUrl: source.sourceUrl || "" });
  }
  return payload;
}
function selectIdea(id) {
  const current = line(ui.selectedLineId);
  if (!current?.ideaIds.includes(id)) ui.selectedLineId = state.lines.find((entry) => entry.ideaIds.includes(id))?.id || "";
  ui.selectedIdeaId = id;
  ui.selectedPaperId = "";
  ui.view = "graph";
  ui.graphExpanded = false;
  render();
}
function toast(message, bad = false) {
  const node = $("#toast");
  node.textContent = tr(message);
  node.classList.toggle("error", bad);
  node.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("visible"), 4400);
}
async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败，请重试。");
  return data;
}
async function act(action, payload) {
  const data = await api("/api/action", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  state = data.state;
  if (action === "idea.update") {
    const draft = readDraft(`idea:${payload.id}`);
    if (draft && Object.entries(draft).every(([key, value]) => payload[key] === value)) forgetDraft(`idea:${payload.id}`);
  }
  if (data.result.lineId) ui.selectedLineId = data.result.lineId;
  if (data.result.ideaId) { ui.selectedIdeaId = data.result.ideaId; ui.selectedPaperId = ""; }
  if (data.result.paperId) { ui.selectedPaperId = data.result.paperId; ui.selectedIdeaId = ""; }
  render();
  return data.result;
}
function closeDialog(dialog = document.querySelector("dialog[open]")) {
  if (dialog?.id === "session-dialog" && ui.session?.saving) return;
  if (dialog) dialog.close();
  if (dialog?.id === "session-dialog") stopTimer();
}
function openDialog(id) { const dialog = $(id); localize(dialog); if (!dialog.open) dialog.showModal(); }
function options(items, selected = "", blank = "") {
  let html = blank ? `<option value="">${esc(blank)}</option>` : "";
  return html + items.map((item) => `<option data-user-content value="${esc(item.id)}" ${item.id === selected ? "selected" : ""}>${esc(truncate(item.title, 58))}</option>`).join("");
}
function syncSelection() {
  if (ui.selectedLineId && !line(ui.selectedLineId)) ui.selectedLineId = "";
  if (!ui.selectedLineId && !ui.selectedIdeaId && !ui.selectedPaperId && state.lines.length) ui.selectedLineId = state.lines[0].id;
  const current = line(ui.selectedLineId);
  if (ui.view === "papers" && !ui.selectedPaperId && state.papers.length) {
    ui.selectedPaperId = state.papers[0].id;
    ui.selectedIdeaId = "";
  }
  if (ui.selectedIdeaId && !idea(ui.selectedIdeaId)) ui.selectedIdeaId = "";
  if (!ui.selectedIdeaId && !ui.selectedPaperId && current?.ideaIds.length) {
    ui.selectedIdeaId = current.activeIdeaId || current.ideaIds[0];
  }
  if (ui.selectedPaperId && !paper(ui.selectedPaperId)) ui.selectedPaperId = "";
}

function render() {
  syncSelection();
  renderNav();
  renderSidebar();
  renderMain();
  renderInspector();
  localize();
}
function renderNav() {
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.action === `view-${ui.view}`);
  });
}
function renderSidebar() {
  $("#line-list").innerHTML = state.lines.length ? state.lines.map((item) => {
    const selected = item.id === ui.selectedLineId;
    const active = idea(item.activeIdeaId);
    return `<button type="button" class="line-item ${selected ? "selected" : ""}" data-action="select-line" data-id="${esc(item.id)}" aria-current="${selected ? "page" : "false"}">
      <span class="line-item-title" data-user-content>${esc(item.title)}</span>
      <span class="line-item-meta">${item.ideaIds.length} 张卡${active ? ` · 下一张：${esc(truncate(active.title, 13))}` : ""}</span>
    </button>`;
  }).join("") : `<div class="side-empty">先创建一条想追的问题线。</div>`;
  const current = line(ui.selectedLineId);
  const active = idea(current?.activeIdeaId) || idea(current?.ideaIds[0]);
  $("#today-panel").innerHTML = current && active ? `<div class="today-kicker"><span class="pulse-dot"></span> 下一步</div>
    <h3 data-user-content>${esc(active.title)}</h3><p data-user-content>${esc(current.title)}</p>
    ${latestSession(active.id) ? `<div class="today-recap">${readingRecap(active.id, true)}</div>` : ""}
    <button type="button" class="button light-fill full" data-action="start-session" data-id="${esc(active.id)}">开始读 15 分钟 <span>↗</span></button>`
    : `<div class="today-kicker"><span class="pulse-dot"></span> 下一步</div><h3>从一张卡开始</h3><p>为阅读线添加思想卡，就能开始第一次阅读。</p><button type="button" class="button light-fill full" data-action="new-idea">新建思想卡 <span>＋</span></button>`;
}

function pageHeader(kicker, title, description, actions = "", userTitle = true, userDescription = false) {
  return `<div class="page-head"><div><span class="eyebrow">${kicker}</span><h1 ${userTitle ? "data-user-content" : ""}>${esc(title)}</h1><p ${userDescription ? "data-user-content" : ""}>${esc(description || "")}</p></div><div class="page-actions">${actions}</div></div>`;
}
function renderMain() {
  const current = line(ui.selectedLineId);
  if (ui.view === "papers") return renderPapers();
  if (ui.view === "ideas") return renderIdeas();
  if (!current) {
    const selected = idea(ui.selectedIdeaId);
    if (selected && ui.view === "graph") {
      $("#main-view").innerHTML = pageHeader("IDEA GRAPH / 思想图", selected.title, "这张思想卡还没有加入阅读线。", `<button type="button" class="button secondary" data-action="new-line">＋ 创建阅读线</button>`) + graphMarkup(selected);
      return;
    }
    $("#main-view").innerHTML = `<div class="welcome"><div class="welcome-symbol">↗</div><span class="eyebrow">START HERE</span><h1>把好奇心接成一条线。</h1><p>创建一条研究问题线。读到新思想时，把它做成卡片；之后每篇论文都能连回同一张卡。</p><button type="button" class="button primary" data-action="new-line">创建第一条阅读线</button></div>`;
    return;
  }
  if (ui.view === "outline") return renderOutline(current);
  renderGraphView(current);
}

function renderGraphView(current) {
  const selected = idea(ui.selectedIdeaId) || idea(current.activeIdeaId) || idea(current.ideaIds[0]);
  const start = selected && current.ideaIds.includes(selected.id) ? `<button type="button" class="button primary" data-action="start-session" data-id="${esc(selected.id)}">开始读 ↗</button>` : "";
  const actions = `${start}<button type="button" class="button secondary" data-action="new-idea">＋ 思想卡</button><button type="button" class="button quiet" data-action="edit-line">编辑阅读线</button>`;
  const tabs = current.ideaIds.map((id) => {
    const item = idea(id);
    if (!item) return "";
    return `<button type="button" class="card-tab ${selected?.id === id ? "active" : ""}" data-user-content data-action="select-idea" data-id="${esc(id)}">${esc(item.title)}</button>`;
  }).join("");
  $("#main-view").innerHTML = pageHeader("IDEA GRAPH / 思想图", current.title, current.question || "沿着思想卡追踪论文、方法与引申。", actions, true, Boolean(current.question))
    + `<div class="graph-intro"><strong>从思想出发</strong><span>点击节点查看论文如何使用它，或切换到关联的思想。</span></div>`
    + (current.ideaIds.length ? `<div class="card-tabs" aria-label="阅读线中的思想卡">${tabs}</div>` : "")
    + (selected ? graphMarkup(selected) : `<div class="empty-main"><div class="empty-orbit">◎</div><h2>这里会长出第一张思想图</h2><p>新建一张思想卡，再把论文与它关联起来。</p><button type="button" class="button primary" data-action="new-idea">添加思想卡</button></div>`);
}

function graphMarkup(focus) {
  const paperEdges = state.edges.filter((item) => item.fromType === "paper" && item.toId === focus.id);
  const ideaEdges = state.edges.filter((item) => item.fromType === "idea" && (item.fromId === focus.id || item.toId === focus.id));
  const left = (ui.graphExpanded ? paperEdges : paperEdges.slice(0, 7)).map((item) => ({ edge: item, node: paper(item.fromId) })).filter((item) => item.node);
  const right = (ui.graphExpanded ? ideaEdges : ideaEdges.slice(0, 7)).map((item) => ({ edge: item, node: idea(item.fromId === focus.id ? item.toId : item.fromId) })).filter((item) => item.node);
  const rows = Math.max(left.length, right.length, 3);
  const height = Math.max(390, rows * 86 + 80);
  const centerY = height / 2;
  const yAt = (index, count) => centerY + (index - (count - 1) / 2) * 86;
  let paths = "";
  let nodes = "";
  left.forEach(({ edge: connection, node }, index) => {
    const y = yAt(index, left.length);
    paths += `<path class="graph-link paper-link" d="M 290 ${y} C 350 ${y}, 350 ${centerY}, 410 ${centerY}"/><text class="graph-edge-label" x="350" y="${(y + centerY) / 2 - 9}" text-anchor="middle">${labels.paper[connection.relation]}</text>`;
    nodes += graphNode("paper", node, 35, y - 31, 255, connection.relation);
  });
  right.forEach(({ edge: connection, node }, index) => {
    const y = yAt(index, right.length);
    paths += `<path class="graph-link idea-link" d="M 650 ${centerY} C 705 ${centerY}, 705 ${y}, 760 ${y}"/><text class="graph-edge-label" x="705" y="${(y + centerY) / 2 - 9}" text-anchor="middle">${connection.fromId === focus.id ? "→" : "←"} ${labels.idea[connection.relation]}</text>`;
    nodes += graphNode("idea", node, 760, y - 31, 205, connection.relation);
  });
  const center = `<g class="graph-focus" role="group" aria-label="当前思想 ${esc(focus.title)}"><rect x="410" y="${centerY - 48}" width="240" height="96" rx="16"/><text x="430" y="${centerY - 10}" class="focus-title" data-user-content>${esc(truncate(focus.title, 22))}</text><text x="430" y="${centerY + 19}" class="focus-sub">${labels.kind[focus.kind]} · ${labels.status[focus.status]}</text></g>`;
  const more = paperEdges.length > 7 || ideaEdges.length > 7;
  const paperCount = new Set(paperEdges.map((item) => item.fromId)).size;
  const parent = ideaEdges.find((connection) => connection.toId === focus.id && connection.relation === "extends");
  return `${parent ? `<button type="button" class="button quiet parent-return" data-action="select-idea" data-id="${esc(parent.fromId)}"><span>↖ 返回来源</span> <span data-user-content>${esc(idea(parent.fromId)?.title)}</span></button>` : ""}<section class="graph-panel"><div class="graph-toolbar"><div class="graph-stats"><span><b>${paperCount}</b> ${countUnit(paperCount, "篇论文", "paper", "papers")}</span><span><b>${ideaEdges.length}</b> ${countUnit(ideaEdges.length, "条思想关联", "idea connection", "idea connections")}</span></div><div class="graph-legend"><span><i class="legend-paper"></i>论文</span><span><i class="legend-idea"></i>思想</span></div></div>
    <div class="graph-scroll"><svg class="idea-graph" viewBox="0 0 1000 ${height}" role="group" aria-label="${esc(focus.title)} 与 ${paperCount} 篇论文及 ${ideaEdges.length} 条思想关系的图谱"><defs><pattern id="dot-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--graph-dot)"/></pattern></defs><rect width="1000" height="${height}" fill="url(#dot-grid)"/>${paths}${nodes}${center}</svg></div>
    ${more ? `<button type="button" class="graph-more" data-action="expand-graph">${ui.graphExpanded ? "收起部分节点" : `展开全部关联（${paperEdges.length + ideaEdges.length}）`}</button>` : ""}
    <div class="graph-bottom"><p>${paperCount ? "同一个思想卡可以汇集多篇论文；每条连线记录具体用法。" : "从论文库导入来源，再建立“论文 → 思想”的关联。"}</p><div><button type="button" class="button quiet" data-action="link-paper">＋ 关联论文</button><button type="button" class="button quiet" data-action="derive-idea">＋ 引申新卡</button><button type="button" class="button quiet" data-action="link-idea">关联已有思想</button></div></div></section>`;
}
function graphNode(kind, item, x, y, width) {
  const secondary = kind === "paper" ? [item.authors, item.year].filter(Boolean).join(" · ") || "来源论文" : `${labels.kind[item.kind]} · ${labels.status[item.status]}`;
  return `<g class="graph-node ${kind}-node" data-action="select-${kind}" data-id="${esc(item.id)}" role="button" tabindex="0" aria-label="查看${kind === "paper" ? "论文" : "思想"} ${esc(item.title)}"><rect x="${x}" y="${y}" width="${width}" height="62" rx="12"/><text x="${x + 16}" y="${y + 26}" class="node-title" data-user-content>${esc(truncate(item.title, kind === "paper" ? 25 : 20))}</text><text x="${x + 16}" y="${y + 47}" class="node-sub" ${kind === "paper" && (item.authors || item.year) ? "data-user-content" : ""}>${esc(truncate(secondary, 30))}</text></g>`;
}

function renderOutline(current) {
  const actions = `${current.ideaIds.length ? `<button type="button" class="button primary" data-action="start-session">开始读 ↗</button>` : ""}<button type="button" class="button secondary" data-action="new-idea">＋ 思想卡</button><button type="button" class="button quiet" data-action="attach-idea">关联已有卡片</button><button type="button" class="button quiet" data-action="edit-line">编辑</button>`;
  let rows = current.ideaIds.map((id, index) => {
    const item = idea(id);
    if (!item) return "";
    const paperCount = state.edges.filter((connection) => connection.fromType === "paper" && connection.toId === id).length;
    return `<div class="outline-row ${current.activeIdeaId === id ? "is-next" : ""}"><span class="step-num">${String(index + 1).padStart(2, "0")}</span><button type="button" class="outline-body" data-action="select-idea" data-id="${esc(id)}"><strong data-user-content>${esc(item.title)}</strong><small><span ${item.summary ? "data-user-content" : ""}>${esc(item.summary || "等待写下一句话理解")}</span> · <span>${paperCount} 篇论文</span></small></button><span class="status-pill ${item.status}">${labels.status[item.status]}</span><button type="button" class="mini-action" data-action="set-next" data-id="${esc(id)}">${current.activeIdeaId === id ? "下一张" : "设为下一张"}</button><button type="button" class="mini-action remove-action" data-action="detach-idea" data-id="${esc(id)}" aria-label="从阅读线移出 ${esc(item.title)}">×</button></div>`;
  }).join("");
  $("#main-view").innerHTML = pageHeader("READING PATH / 阅读线", current.title, current.question || "这条线要回答的问题可以在“编辑”中补充。", actions, true, Boolean(current.question))
    + `<div class="section-title"><div><span class="eyebrow">YOUR ROUTE</span><h2>按顺序学习</h2></div><span>${current.ideaIds.length} 张卡</span></div>`
    + (rows ? `<div class="outline-list">${rows}</div>` : `<div class="empty-main compact"><h2>还没有思想卡</h2><p>记录阅读时遇到的第一个概念、创新或问题。</p><button type="button" class="button primary" data-action="new-idea">添加第一张卡</button></div>`)
    + `<div class="outline-tip"><strong>阅读线是学习顺序。</strong><span>同一张思想卡可以加入多条阅读线，论文关系会共用。</span></div>`;
}

function renderIdeas() {
  $("#main-view").innerHTML = pageHeader("IDEA LIBRARY", "思想库", "搜索已有思想，把不同论文连到同一张卡。", `<button type="button" class="button secondary" data-action="new-idea">＋ 思想卡</button>`, false)
    + `<label class="idea-search-label">搜索思想<input id="idea-search" type="search" placeholder="搜索名称、别名或笔记内容" value="${esc(ui.ideaQuery)}"></label><div id="idea-search-results" aria-live="polite"></div>`;
  renderIdeaResults();
}
function renderIdeaResults() {
  const results = searchIdeas(ui.ideaQuery);
  $("#idea-search-results").innerHTML = `<p class="field-help result-count">${results.length} 张思想卡</p>` + (results.length ? `<div class="idea-library">${results.map((item) => {
    const count = new Set(state.edges.filter((connection) => connection.fromType === "paper" && connection.toId === item.id).map((connection) => connection.fromId)).size;
    return `<button type="button" class="idea-result" data-action="select-idea" data-id="${esc(item.id)}"><div class="idea-result-top"><strong data-user-content>${esc(item.title)}</strong><span class="status-pill ${item.status}">${labels.status[item.status]}</span></div>${item.aliases?.length ? `<small data-user-content>${esc(item.aliases.join(" · "))}</small>` : ""}<p ${item.summary ? "data-user-content" : ""}>${esc(truncate(item.summary || "等待写下一句话理解", 150))}</p><span>${count} 篇论文</span></button>`;
  }).join("")}</div>` : `<div class="empty-main compact"><h2>没有找到思想卡</h2><p>换个关键词，或创建一张新卡。</p><button type="button" class="button primary" data-action="new-idea">新建思想卡</button></div>`);
  localize($("#idea-search-results"));
}
function renderIdeaMatches() {
  const queries = [$("#idea-title").value, ...$("#idea-aliases").value.split(/[,，;；\n]/)].map((value) => value.trim()).filter(Boolean);
  const results = [...new Map(queries.flatMap((query) => searchIdeas(query, ui.pendingParentId)).map((item) => [item.id, item])).values()].slice(0, 5);
  const target = $("#idea-matches");
  target.hidden = !results.length;
  target.innerHTML = results.length ? `<strong>已有相近思想</strong><p class="field-help">使用已有卡片，可以汇集多篇论文的关系。</p>${results.map((item) => `<div class="idea-match"><span data-user-content>${esc(item.title)}</span><button type="button" class="button quiet" data-action="reuse-idea" data-id="${esc(item.id)}">使用此卡</button></div>`).join("")}` : "";
  localize(target);
}
async function reuseIdea(id) {
  await act("idea.reuse", { id, lineId: $("#idea-line").value, ...ideaSourcePayload() });
  closeDialog($("#idea-dialog"));
  selectIdea(id);
  toast("已使用已有思想卡。");
}

function renderPapers() {
  $("#main-view").innerHTML = pageHeader("SOURCE LIBRARY / 论文库", "让论文回到思想上", "从 Zotero 导入论文，记录它提出、使用或改进了哪些思想。", `<button type="button" class="button secondary" data-action="new-paper">＋ 添加论文</button>`, false)
    + (state.papers.length ? `<div class="paper-list">${state.papers.map((item) => {
      const count = new Set(state.edges.filter((connection) => connection.fromType === "paper" && connection.fromId === item.id).map((connection) => connection.toId)).size;
      return `<button type="button" class="paper-list-item ${ui.selectedPaperId === item.id ? "selected" : ""}" data-action="select-paper" data-id="${esc(item.id)}"><span class="paper-icon">▤</span><span><strong data-user-content>${esc(item.title)}</strong><small ${item.authors || item.year ? "data-user-content" : ""}>${esc([item.authors, item.year].filter(Boolean).join(" · ") || "手动添加")}</small></span><em>${count} 个思想</em></button>`;
    }).join("")}</div>` : `<div class="empty-main"><div class="empty-orbit">▤</div><h2>先接入第一篇论文</h2><p>可以搜索本机 Zotero，也可以手动添加来源。</p><button type="button" class="button primary" data-action="new-paper">添加论文</button></div>`);
}

function renderInspector() {
  if (ui.selectedPaperId) return renderPaperInspector(paper(ui.selectedPaperId));
  if (ui.selectedIdeaId) return renderIdeaInspector(idea(ui.selectedIdeaId));
  $("#inspector").innerHTML = `<div class="inspector-empty"><span class="eyebrow">DETAILS</span><h2>选中一张卡</h2><p>卡片的理解、来源和引申会出现在这里。</p></div>`;
}
function renderIdeaInspector(item) {
  if (!item) return;
  const draft = readDraft(`idea:${item.id}`);
  const edit = { ...item, aliases: (item.aliases || []).join(", ") };
  for (const key of ["title", "aliases", "kind", "status", "summary", "mechanism", "thoughts"]) {
    if (typeof draft?.[key] === "string") edit[key] = draft[key];
  }
  const papers = state.edges.filter((connection) => connection.fromType === "paper" && connection.toId === item.id);
  const related = state.edges.filter((connection) => connection.fromType === "idea" && (connection.fromId === item.id || connection.toId === item.id));
  const lineNames = state.lines.filter((entry) => entry.ideaIds.includes(item.id)).map((entry) => entry.title);
  $("#inspector").innerHTML = `<div class="inspector-top"><span class="eyebrow">IDEA CARD</span><span class="status-pill ${item.status}">${labels.status[item.status]}</span></div><h2 class="inspector-title" data-user-content>${esc(item.title)}</h2><p class="inspector-sub">${labels.kind[item.kind]} · 出现在 ${lineNames.length} 条阅读线</p>
    <form id="idea-edit-form" class="detail-form" data-id="${esc(item.id)}"><label>名称<input name="title" maxlength="120" value="${esc(edit.title)}" required></label><label>别名<input name="aliases" maxlength="1500" value="${esc(edit.aliases)}" placeholder="缩写、全称或其他写法，用逗号分隔"></label><div class="form-grid"><label>类型<select name="kind">${Object.entries(labels.kind).map(([key, value]) => `<option value="${key}" ${edit.kind === key ? "selected" : ""}>${value}</option>`).join("")}</select></label><label>状态<select name="status">${Object.entries(labels.status).map(([key, value]) => `<option value="${key}" ${edit.status === key ? "selected" : ""}>${value}</option>`).join("")}</select></label></div>
    <label>一句话理解<textarea name="summary" rows="3" maxlength="4000" placeholder="用自己的话说清这张卡。">${esc(edit.summary)}</textarea></label><label>核心机制<textarea name="mechanism" rows="4" maxlength="6000" placeholder="关键步骤、公式或假设。">${esc(edit.mechanism)}</textarea></label><label>我的思考<textarea name="thoughts" rows="4" maxlength="6000" placeholder="质疑、联系、引申。">${esc(edit.thoughts)}</textarea></label><p id="idea-draft-status" class="field-help" ${draft ? "" : "hidden"}>草稿已保留，点击保存卡片可写入笔记。</p><button type="submit" class="button primary full">保存卡片</button></form>
    <div class="inspector-section"><div class="inspector-section-head"><h3>论文来源 <span>${papers.length}</span></h3><button type="button" data-action="link-paper">＋</button></div>${papers.length ? papers.map((connection) => relationRow(connection, "paper", paper(connection.fromId))).join("") : `<p class="empty-small">关联论文后，这里会显示每篇论文如何使用这个思想。</p>`}</div>
    <div class="inspector-section"><div class="inspector-section-head"><h3>思想关联 <span>${related.length}</span></h3><div><button type="button" class="text-action" data-action="derive-idea">引申新卡</button><button type="button" data-action="link-idea" aria-label="关联已有思想">＋</button></div></div>${related.length ? related.map((connection) => relationRow(connection, "idea", idea(connection.fromId === item.id ? connection.toId : connection.fromId))).join("") : `<p class="empty-small">继续追问时，可以把新的思想连进来。</p>`}</div>
    ${sessionHistory(item.id)}
    <div class="inspector-section last"><h3>所在阅读线</h3><p class="tiny-list" ${lineNames.length ? "data-user-content" : ""}>${esc(lineNames.join(" · ") || "尚未加入阅读线")}</p></div>`;
}
function relationRow(connection, kind, node) {
  if (!node) return "";
  const label = labels[connection.fromType][connection.relation] || connection.relation;
  return `<div class="relation-row"><button type="button" class="relation-main" data-action="select-${kind}" data-id="${esc(node.id)}"><span class="relation-type">${label}</span><strong data-user-content>${esc(truncate(node.title, 46))}</strong>${connection.note ? `<small data-user-content>${esc(truncate(connection.note, 90))}</small>` : ""}</button>${connection.sourceUrl ? `<a class="relation-source" href="${safeHref(connection.sourceUrl)}" aria-label="打开原文位置">↗</a>` : ""}<button type="button" class="relation-edit" data-action="edit-edge" data-id="${esc(connection.id)}" aria-label="编辑关系">···</button></div>`;
}
function renderPaperInspector(item) {
  if (!item) return;
  const related = state.edges.filter((connection) => connection.fromType === "paper" && connection.fromId === item.id);
  const annotations = ui.annotationPaperId === item.id ? ui.annotations : null;
  $("#inspector").innerHTML = `<div class="inspector-top"><span class="eyebrow">PAPER SOURCE</span><span class="paper-tag">论文</span></div><h2 class="inspector-title" data-user-content>${esc(item.title)}</h2><p class="inspector-sub" ${item.authors || item.year ? "data-user-content" : ""}>${esc([item.authors, item.year].filter(Boolean).join(" · ") || "手动添加")}</p>
    <div class="paper-meta">${item.doi ? `<div><span>DOI</span><strong data-user-content>${esc(item.doi)}</strong></div>` : ""}${item.zoteroKey ? `<div><span>ZOTERO KEY</span><strong data-user-content>${esc(item.zoteroKey)}</strong></div>` : ""}</div>
    ${item.zoteroUrl ? `<a class="button primary full" href="${safeHref(item.zoteroUrl)}">在 Zotero 打开 ↗</a>` : ""}
    <div class="inspector-section"><div class="inspector-section-head"><h3>蕴含的思想 <span>${related.length}</span></h3><div><button type="button" data-action="new-idea-from-paper" aria-label="从论文创建思想卡">新建</button><button type="button" data-action="link-paper-to-idea" aria-label="关联已有思想卡">＋</button></div></div>${related.length ? related.map((connection) => relationRow(connection, "idea", idea(connection.toId))).join("") : `<p class="empty-small">把这篇论文连到已有思想，或从批注建一张新卡。</p>`}</div>
    ${item.zoteroKey ? `<div class="inspector-section last"><div class="inspector-section-head"><h3>Zotero 批注</h3><button type="button" data-action="load-annotations">读取</button></div>${annotations === null ? `<p class="empty-small">读取划线与批注，再从原文建卡。</p>` : annotations.length ? annotations.map((annotation, index) => `<div class="annotation"><span>第 ${esc(annotation.page || "?")} 页</span><p data-user-content>${esc(truncate(annotation.text || annotation.comment, 200))}</p>${annotation.comment && annotation.text ? `<small data-user-content>${esc(truncate(annotation.comment, 120))}</small>` : ""}<div class="annotation-actions"><button type="button" data-action="annotation-link" data-index="${index}">关联已有卡</button><button type="button" data-action="annotation-create" data-index="${index}">建新卡 ↗</button></div></div>`).join("") : `<p class="empty-small">没有找到文字批注。</p>`}</div>` : ""}`;
}

function openLineDialog(edit = false) {
  const current = edit ? line(ui.selectedLineId) : null;
  $("#line-dialog-title").textContent = edit ? "编辑阅读线" : "新建阅读线";
  $("#line-id").value = current?.id || "";
  $("#line-title").value = current?.title || "";
  $("#line-question").value = current?.question || "";
  openDialog("#line-dialog");
  $("#line-title").focus();
}
function openIdeaDialog(source = null, parentId = "") {
  ui.pendingSource = source;
  ui.pendingParentId = parentId;
  $("#idea-title").value = "";
  $("#idea-aliases").value = "";
  $("#idea-kind").value = "concept";
  $("#idea-summary").value = "";
  $("#idea-line").innerHTML = options(state.lines, ui.selectedLineId, "暂不加入阅读线");
  $("#idea-source-context").hidden = !source;
  $("#idea-source-relation-wrap").hidden = !source;
  $("#idea-parent-context").hidden = !parentId;
  if (parentId) $("#idea-parent-context").innerHTML = `<span>引申自</span> <strong data-user-content>${esc(idea(parentId)?.title)}</strong><p>创建后会自动连线，也可以选择下方已有的思想卡。</p>`;
  if (source) {
    const target = paper(source.paperId);
    $("#idea-source-context").textContent = `来源：${target?.title || "论文"}${source.page ? ` · 第 ${source.page} 页` : ""}${source.text ? ` · ${truncate(source.text, 110)}` : ""}`;
    $("#idea-source-relation").value = "uses";
  }
  renderIdeaMatches();
  openDialog("#idea-dialog");
  $("#idea-title").focus();
}
function openPaperDialog() {
  $("#paper-form").reset();
  $("#zotero-query").value = "";
  $("#zotero-results").innerHTML = "";
  ui.zoteroResults = [];
  openDialog("#paper-dialog");
}
function relationOptions(mode) {
  const list = mode === "paper" ? labels.paper : labels.idea;
  $("#relation-type").innerHTML = Object.entries(list).map(([key, value]) => `<option value="${key}">${value}</option>`).join("");
}
function relationTargets() {
  const mode = $("#relation-mode").value;
  const focus = ui.relationFocus;
  let items;
  let label;
  if (mode === "paper" && focus.kind === "idea") {
    items = state.papers; label = "选择论文";
  } else if (mode === "paper") {
    items = state.ideas; label = "选择思想";
  } else {
    items = state.ideas.filter((item) => item.id !== focus.id); label = "选择另一张思想卡";
  }
  $("#relation-target-label").firstChild.replaceWith(document.createTextNode(label));
  $("#relation-target").innerHTML = options(items, "", "请选择");
  relationOptions(mode);
  localize($("#relation-dialog"));
}
function openRelation(mode, focusKind = "idea", focusId = "") {
  if (mode === "paper" && !state.papers.length && focusKind === "idea") { openPaperDialog(); toast("先添加一篇论文，再建立关联。"); return; }
  if (mode === "idea" && state.ideas.length < 2) { openIdeaDialog(null, focusId || ui.selectedIdeaId); return; }
  if (focusKind === "paper" && !state.ideas.length) { openIdeaDialog({ paperId: focusId || ui.selectedPaperId }); return; }
  ui.editingEdgeId = "";
  ui.relationFocus = { kind: focusKind, id: focusId || (focusKind === "idea" ? ui.selectedIdeaId : ui.selectedPaperId) };
  $("#relation-dialog-title").textContent = "建立关联";
  $("#delete-edge-button").hidden = true;
  $("#relation-create-fields").hidden = false;
  $("#relation-mode-wrap").hidden = focusKind === "paper";
  $("#relation-mode").value = mode;
  $("#relation-context").textContent = `${focusKind === "paper" ? "论文" : "思想"}：${focusKind === "paper" ? paper(ui.relationFocus.id)?.title : idea(ui.relationFocus.id)?.title}`;
  $("#relation-note").value = "";
  $("#relation-source-url").value = "";
  relationTargets();
  openDialog("#relation-dialog");
}
function editRelation(id) {
  const item = edge(id);
  if (!item) return;
  ui.editingEdgeId = id;
  $("#relation-dialog-title").textContent = "编辑关联说明";
  $("#delete-edge-button").hidden = false;
  $("#relation-create-fields").hidden = true;
  const source = item.fromType === "paper" ? paper(item.fromId) : idea(item.fromId);
  const target = idea(item.toId);
  $("#relation-context").textContent = `${source?.title || ""} → ${target?.title || ""}`;
  $("#relation-note").value = item.note || "";
  $("#relation-source-url").value = item.sourceUrl || "";
  openDialog("#relation-dialog");
}
function openSettings() {
  $("#vault-path").value = state.settings.vaultPath || "";
  $("#language").value = language();
  $("#reminder-time").value = state.settings.reminderTime || "";
  openDialog("#settings-dialog");
}
function checkReminder() {
  if (!state?.settings?.reminderTime) return;
  const now = new Date();
  const due = state.settings.reminderTime.split(":").map(Number);
  const dueMinutes = due[0] * 60 + due[1];
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  if (currentMinutes < dueMinutes || currentMinutes >= dueMinutes + 30) return;
  const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const key = `paperline-reminded-${today}`;
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch { if (ui.lastReminder === today) return; ui.lastReminder = today; }
  const current = line(ui.selectedLineId) || state.lines[0];
  const next = idea(current?.activeIdeaId) || idea(current?.ideaIds[0]);
  const message = next ? `今天从「${next.title}」开始，读 15 分钟。` : "今天从一个小问题开始读论文。";
  toast(message);
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(tr("读线 · 阅读时间到了"), { body: tr(message) }); } catch { /* 站内提醒仍然可用 */ }
  }
}
function sessionSeconds(session = ui.session) {
  if (!session) return 0;
  return Math.min(86400, session.elapsed + (session.running ? Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000)) : 0));
}
function checkpointSession() {
  if (!ui.session) return;
  writeDraft(`session:${ui.session.lineId}:${ui.session.ideaId}`, {
    elapsed: sessionSeconds(), note: $("#session-note").value, nextQuestion: $("#session-next-question").value,
  });
}
function stopTimer(discard = false) {
  if (ui.session) {
    if (discard) forgetDraft(`session:${ui.session.lineId}:${ui.session.ideaId}`);
    else checkpointSession();
  }
  if (ui.timer) clearInterval(ui.timer);
  ui.timer = null;
  ui.session = null;
}
function updateClock() {
  if (!ui.session) return;
  const elapsed = sessionSeconds();
  $("#session-time").textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  $("#pause-button").textContent = ui.session.running ? "暂停计时" : "继续计时";
  localize($("#pause-button"));
  if (elapsed % 5 === 0) checkpointSession();
}
function openSession(ideaId) {
  if (ui.session?.saving) return;
  const currentLine = line(ui.selectedLineId);
  const target = idea(ideaId || currentLine?.activeIdeaId || currentLine?.ideaIds[0]);
  if (!currentLine || !target || !currentLine.ideaIds.includes(target.id)) { toast("先为阅读线添加一张思想卡。", true); return; }
  stopTimer();
  const draft = readDraft(`session:${currentLine.id}:${target.id}`);
  const elapsed = Number.isFinite(draft?.elapsed) ? Math.max(0, Math.min(86400, Math.floor(draft.elapsed))) : 0;
  ui.selectedIdeaId = target.id; ui.selectedPaperId = "";
  ui.session = { lineId: currentLine.id, ideaId: target.id, elapsed, startedAt: Date.now(), running: true };
  $("#session-title").textContent = target.title;
  $("#session-line").textContent = `阅读线：${currentLine.title}`;
  $("#session-note").value = typeof draft?.note === "string" ? draft.note.slice(0, 4000) : "";
  $("#session-next-question").value = typeof draft?.nextQuestion === "string" ? draft.nextQuestion.slice(0, 1000) : "";
  const recap = readingRecap(target.id);
  $("#session-recap").hidden = !recap;
  $("#session-recap").innerHTML = recap;
  const source = state.edges.find((item) => item.fromType === "paper" && item.toId === target.id);
  const url = source?.sourceUrl || paper(source?.fromId)?.zoteroUrl || "";
  const link = $("#session-zotero");
  link.hidden = !url;
  link.href = safeUrl(url);
  updateClock();
  ui.timer = setInterval(updateClock, 1000);
  openDialog("#session-dialog");
  render();
}

async function searchZotero() {
  const query = $("#zotero-query").value.trim();
  $("#zotero-results").innerHTML = `<p class="field-help">正在读取 Zotero…</p>`;
  localize($("#zotero-results"));
  try {
    const result = await api(`/api/zotero/search?q=${encodeURIComponent(query)}`);
    ui.zoteroResults = result.items;
    $("#zotero-results").innerHTML = result.items.length ? result.items.map((item, index) => `<div class="zotero-result"><div><strong data-user-content>${esc(item.title)}</strong><small ${item.authors || item.year ? "data-user-content" : ""}>${esc([item.authors, item.year].filter(Boolean).join(" · ") || "Zotero 条目")}</small></div><button type="button" class="button quiet" data-action="import-zotero" data-index="${index}">导入</button></div>`).join("") : `<p class="field-help">没有找到符合条件的条目。</p>`;
    localize($("#zotero-results"));
  } catch (error) { $("#zotero-results").innerHTML = `<p class="field-error">${esc(tr(error.message))}</p>`; }
}
async function loadAnnotations() {
  const target = paper(ui.selectedPaperId);
  if (!target?.zoteroKey) return;
  try {
    toast("正在读取 Zotero 批注…");
    const result = await api(`/api/zotero/annotations?key=${encodeURIComponent(target.zoteroKey)}`);
    ui.annotationPaperId = target.id;
    ui.annotations = result.annotations;
    renderInspector();
    localize($("#inspector"));
    toast(`找到 ${result.annotations.length} 条文字批注。`);
  } catch (error) { toast(error.message, true); }
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  try {
    if (action.startsWith("view-")) { ui.view = action.slice(5); ui.selectedPaperId = ""; render(); }
    else if (action === "select-line") { ui.selectedLineId = id; ui.selectedIdeaId = line(id)?.activeIdeaId || line(id)?.ideaIds[0] || ""; ui.selectedPaperId = ""; render(); }
    else if (action === "select-idea") selectIdea(id);
    else if (action === "select-paper") { ui.selectedPaperId = id; if (ui.view === "papers") ui.selectedIdeaId = ""; render(); }
    else if (action === "new-line") openLineDialog();
    else if (action === "edit-line") openLineDialog(true);
    else if (action === "new-idea") openIdeaDialog();
    else if (action === "derive-idea") openIdeaDialog(null, ui.selectedIdeaId);
    else if (action === "reuse-idea") await reuseIdea(id);
    else if (action === "new-idea-from-paper") openIdeaDialog({ paperId: ui.selectedPaperId });
    else if (action === "new-paper") openPaperDialog();
    else if (action === "link-paper") openRelation("paper", "idea");
    else if (action === "link-idea") openRelation("idea", "idea");
    else if (action === "link-paper-to-idea") openRelation("paper", "paper");
    else if (action === "edit-edge") editRelation(id);
    else if (action === "delete-edge") {
      if (!ui.editingEdgeId || !window.confirm(tr("删除这条关系？思想卡和论文会保留。"))) return;
      await act("edge.delete", { id: ui.editingEdgeId });
      closeDialog($("#relation-dialog"));
      toast("关系已删除。");
    }
    else if (action === "search-zotero") await searchZotero();
    else if (action === "import-zotero") {
      const item = ui.zoteroResults[Number(button.dataset.index)];
      if (!item) return;
      const result = await act("paper.create", item);
      closeDialog($("#paper-dialog"));
      ui.selectedPaperId = result.paperId; ui.selectedIdeaId = ""; ui.view = "papers"; render();
      toast("论文已加入论文库。");
    }
    else if (action === "load-annotations") await loadAnnotations();
    else if (action === "annotation-create") {
      const item = ui.annotations?.[Number(button.dataset.index)];
      if (item) openIdeaDialog({ ...item, paperId: ui.selectedPaperId });
    }
    else if (action === "annotation-link") {
      const item = ui.annotations?.[Number(button.dataset.index)];
      if (!item) return;
      if (!state.ideas.length) { openIdeaDialog({ ...item, paperId: ui.selectedPaperId }); return; }
      openRelation("paper", "paper", ui.selectedPaperId);
      $("#relation-source-url").value = item.sourceUrl;
      $("#relation-note").value = [item.text ? `摘录：${item.text}` : "", item.comment ? `批注：${item.comment}` : ""].filter(Boolean).join("\n").slice(0, 3000);
    }
    else if (action === "start-session") openSession(id);
    else if (action === "pause-session" && ui.session) {
      if (ui.session.running) { ui.session.elapsed = sessionSeconds(); ui.session.running = false; }
      else { ui.session.startedAt = Date.now(); ui.session.running = true; }
      updateClock();
      checkpointSession();
    }
    else if (action === "set-next") {
      const current = line(ui.selectedLineId);
      await act("line.update", { id: current.id, title: current.title, question: current.question, activeIdeaId: id });
      toast("已设为下一张卡。");
    }
    else if (action === "detach-idea") {
      const current = line(ui.selectedLineId);
      if (!window.confirm(tr("将这张卡从当前阅读线移出？卡片及论文关联会保留。"))) return;
      await act("line.detach", { lineId: current.id, ideaId: id });
      if (ui.selectedIdeaId === id) ui.selectedIdeaId = line(ui.selectedLineId)?.activeIdeaId || "";
      render();
      toast("卡片已移出阅读线。");
    }
    else if (action === "attach-idea") {
      const current = line(ui.selectedLineId);
      const choices = state.ideas.filter((item) => !current.ideaIds.includes(item.id));
      if (!choices.length) { toast("没有可加入的已有卡片。", true); return; }
      $("#attach-idea").innerHTML = options(choices, "", "请选择");
      openDialog("#attach-dialog");
    }
    else if (action === "expand-graph") { ui.graphExpanded = !ui.graphExpanded; renderMain(); localize($("#main-view")); }
    else if (action === "open-settings") openSettings();
    else if (action === "request-notification") {
      if (!("Notification" in window)) { toast("当前浏览器不支持桌面通知；站内提醒仍可使用。", true); return; }
      const permission = await Notification.requestPermission();
      toast(permission === "granted" ? "浏览器通知已开启。" : "浏览器通知未开启；站内提醒仍可使用。", permission !== "granted");
    }
    else if (action === "export") {
      if (!state.settings.vaultPath) { openSettings(); toast("先设置 Obsidian 库路径。"); return; }
      const result = await api("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      toast(`已导出 ${result.count} 篇笔记到 Obsidian。`);
    }
    else if (action === "close-dialog") closeDialog(button.closest("dialog"));
  } catch (error) { toast(error.message, true); }
});

document.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches(".graph-node")) {
    event.preventDefault(); event.target.click();
  }
});
document.addEventListener("input", (event) => {
  if (event.target.form?.id === "idea-edit-form") captureIdeaDraft(event.target.form);
  if (["session-note", "session-next-question"].includes(event.target.id)) checkpointSession();
  if (event.target.id === "idea-search") { ui.ideaQuery = event.target.value; renderIdeaResults(); }
  if (["idea-title", "idea-aliases"].includes(event.target.id)) renderIdeaMatches();
});
document.addEventListener("change", (event) => {
  if (event.target.form?.id === "idea-edit-form") captureIdeaDraft(event.target.form);
});
window.addEventListener("pagehide", () => stopTimer());
$("#zotero-query").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchZotero(); } });
$("#relation-mode").addEventListener("change", relationTargets);
document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("close", () => { if (dialog.id === "session-dialog" && !dialog.open) stopTimer(); }));
$("#session-dialog").addEventListener("cancel", (event) => { if (ui.session?.saving) event.preventDefault(); });

$("#line-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const id = $("#line-id").value;
    const payload = { title: $("#line-title").value, question: $("#line-question").value };
    if (id) { payload.id = id; payload.activeIdeaId = line(id)?.activeIdeaId || ""; }
    await act(id ? "line.update" : "line.create", payload);
    closeDialog($("#line-dialog"));
    toast(id ? "阅读线已更新。" : "阅读线已创建。");
  } catch (error) { toast(error.message, true); }
});
$("#idea-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = {
      title: $("#idea-title").value, kind: $("#idea-kind").value,
      summary: $("#idea-summary").value, lineId: $("#idea-line").value,
      aliases: $("#idea-aliases").value, ...ideaSourcePayload(),
    };
    await act("idea.create", payload);
    ui.view = "graph";
    closeDialog($("#idea-dialog"));
    render();
    toast("思想卡已创建。");
  } catch (error) { toast(error.message, true); }
});
$("#paper-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await act("paper.create", { title: $("#paper-title").value, authors: $("#paper-authors").value, year: $("#paper-year").value, doi: $("#paper-doi").value });
    ui.view = "papers";
    closeDialog($("#paper-dialog"));
    render();
    toast("论文已加入论文库。");
  } catch (error) { toast(error.message, true); }
});
$("#attach-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const ideaId = $("#attach-idea").value;
    if (!ideaId) { toast("请选择一张思想卡。", true); return; }
    await act("line.attach", { lineId: ui.selectedLineId, ideaId });
    closeDialog($("#attach-dialog"));
    toast("卡片已加入阅读线。");
  } catch (error) { toast(error.message, true); }
});
$("#relation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (ui.editingEdgeId) {
      await act("edge.update", { id: ui.editingEdgeId, note: $("#relation-note").value, sourceUrl: $("#relation-source-url").value });
    } else {
      const mode = $("#relation-mode").value;
      const targetId = $("#relation-target").value;
      if (!targetId) { toast("请选择要关联的内容。", true); return; }
      let payload;
      if (mode === "paper" && ui.relationFocus.kind === "paper") payload = { fromType: "paper", fromId: ui.relationFocus.id, toId: targetId };
      else if (mode === "paper") payload = { fromType: "paper", fromId: targetId, toId: ui.relationFocus.id };
      else payload = { fromType: "idea", fromId: ui.relationFocus.id, toId: targetId };
      payload.relation = $("#relation-type").value;
      payload.note = $("#relation-note").value;
      payload.sourceUrl = $("#relation-source-url").value;
      await act("edge.create", payload);
    }
    closeDialog($("#relation-dialog"));
    toast("关系已保存。");
  } catch (error) { toast(error.message, true); }
});
$("#session-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const session = ui.session;
  if (!session || session.saving) return;
  session.saving = true;
  $("#session-note").disabled = true;
  $("#session-next-question").disabled = true;
  $("#session-save").disabled = true;
  try {
    const elapsed = sessionSeconds(session);
    await act("session.create", { lineId: session.lineId, ideaId: session.ideaId, note: $("#session-note").value, nextQuestion: $("#session-next-question").value, durationSeconds: elapsed });
    stopTimer(true);
    closeDialog($("#session-dialog"));
    toast("本次阅读已记录。下次可以从这张卡继续。");
  } catch (error) { toast(error.message, true); }
  finally {
    session.saving = false;
    $("#session-note").disabled = false;
    $("#session-next-question").disabled = false;
    $("#session-save").disabled = false;
  }
});
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await act("settings.update", { vaultPath: $("#vault-path").value, reminderTime: $("#reminder-time").value, language: $("#language").value });
    closeDialog($("#settings-dialog"));
    toast("设置已保存。");
    checkReminder();
  } catch (error) { toast(error.message, true); }
});
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "idea-edit-form") return;
  event.preventDefault();
  try {
    const form = new FormData(event.target);
    await act("idea.update", { id: event.target.dataset.id, ...Object.fromEntries(form.entries()) });
    toast("卡片已保存。");
  } catch (error) { toast(error.message, true); }
});

api("/api/state").then((data) => { state = data; render(); checkReminder(); setInterval(checkReminder, 30_000); }).catch((error) => {
  $("#main-view").innerHTML = `<div class="welcome"><h1>无法读取应用数据</h1><p>${esc(error.message)}</p></div>`;
  localize($("#main-view"));
});
