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
function localize(root = document.body) { i18n.apply(root, language()); updateHeaderLayout(); }
const ui = {
  view: "graph", selectedLineId: "", selectedIdeaId: "", selectedPaperId: "",
  graphExpanded: false, annotations: null, annotationPaperId: "", pendingSource: null,
  zoteroResults: [], relationFocus: null, editingEdgeId: "", session: null, timer: null,
  ideaQuery: "", ideaStatus: "", paperQuery: "", pendingParentId: "", methodQuery: "", selectedStageId: "", stageInspect: false, newStage: false, timelineZoom: 1, timelineViews: {},
  mapQuery: "", mapStatus: "", mapSort: "citations", inspectorOpen: false, mapAllConnections: false, mapTimelineConnections: true, recommendationAll: false, mapZoom: 1, mapOverviewZoom: 1, ideaGraphZoom: 1, pageZoom: 1, zoteroSync: null, zoteroSyncTimer: null, zoteroSyncError: "",
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
  // 记住开始编辑时这张卡的版本，保存时用来发现别的页面是否已经改过。
  const previous = readDraft(`idea:${form.dataset.id}`);
  values.baseUpdatedAt = previous?.baseUpdatedAt ?? idea(form.dataset.id)?.updatedAt ?? "";
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
function paperInstitution(item) { return String(item.institution || item.extra || "").trim(); }
function displayAuthors(item) {
  const authors = Array.isArray(item.authorNames) && item.authorNames.length ? item.authorNames : Array.isArray(item.authors) ? item.authors : String(item.authors || "").split(/\s*;\s*|\s*；\s*|\s*,\s*|\s*，\s*|\s+and\s+|、/).filter(Boolean);
  return authors.slice(0, 3).join("; ") + ((item.authorCount || authors.length) > 3 ? (language() === "en" ? "; et al." : " 等") : "");
}
function fullAuthorsDetail(item) {
  const full = Array.isArray(item.authorNames) && item.authorNames.length ? item.authorNames.join("; ") : String(item.authors || "");
  return displayAuthors(item) && full !== displayAuthors(item) ? `<details class="full-authors"><summary>查看完整作者</summary><p data-user-content>${esc(full)}</p></details>` : "";
}
function libraryCitationCounts() {
  const citing = new Map();
  for (const connection of validCitations()) {
    if (!citing.has(connection.fromId)) citing.set(connection.fromId, new Set());
    citing.get(connection.fromId).add(connection.toId);
  }
  return new Map([...citing].map(([id, ids]) => [id, ids.size]));
}
function rankedRecommendations() {
  const libraryIds = new Set(state.papers.map((item) => item.id));
  return (state.recommendations || []).map((item) => {
    const citingIds = [...new Set((item.citingIds || []).filter((id) => libraryIds.has(id)))];
    return { ...item, citingIds, citationCount: citingIds.length };
  }).filter((item) => { return item.citationCount >= 2; }).sort((a, b) => b.citationCount - a.citationCount || String(a.title).localeCompare(String(b.title)));
}
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
function sessionHistory(ideaId, targetType = "idea") {
  const sessions = state.sessions.filter((session) => targetType === "idea" ? (session.ideaId === ideaId || (session.targetType === "idea" && session.targetId === ideaId)) : session.targetType === targetType && session.targetId === ideaId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);
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
  if (idea(id)?.entityType !== "method" && !current?.ideaIds.includes(id)) ui.selectedLineId = state.lines.find((entry) => entry.ideaIds.includes(id))?.id || "";
  ui.selectedIdeaId = id;
  ui.view = "graph";
  ui.graphExpanded = false;
  render();
}
function toast(message, bad = false) {
  const node = $("#toast");
  // 弹窗在浏览器顶层，普通 fixed 提示会被它和背景盖住：
  // 把提示挪进当前弹窗，再作为 popover 重新推到顶层最上面。
  const host = document.querySelector("dialog[open]") || document.body;
  if (host?.appendChild && node.parentElement !== host) host.appendChild(node);
  node.textContent = tr(message);
  node.classList.toggle("error", bad);
  node.classList.remove("visible");
  if (typeof node.showPopover === "function") {
    if (node.matches(":popover-open")) node.hidePopover();
    node.showPopover();
    void node.offsetWidth;  // 先让透明状态生效，淡入动画才会播放
  }
  node.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.classList.remove("visible");
    toast.timer = setTimeout(() => { if (node.matches?.(":popover-open")) node.hidePopover(); }, 300);
  }, 4400);
}
async function api(path, options = {}) {
  const response = await (globalThis.PaperLineDesktop?.request ? globalThis.PaperLineDesktop.request(path, options) : fetch(path, options));
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || "请求失败，请重试。");
    error.status = response.status;
    error.conflict = Boolean(data.conflict);
    throw error;
  }
  return data;
}
function confirmAction(message) {
  return globalThis.PaperLineDesktop?.confirm ? globalThis.PaperLineDesktop.confirm(message) : window.confirm(message);
}
function postJson(path, body) {
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function webdavPayload() {
  return {
    enabled: $("#webdav-enabled").checked, url: $("#webdav-url").value.trim(),
    username: $("#webdav-username").value.trim(), password: $("#webdav-password").value,
    folder: $("#webdav-folder").value.trim(),
  };
}
function webdavStatusText(info) {
  if (!info?.url) return tr("尚未设置 WebDAV。");
  const parts = [];
  if (info.status.conflict) parts.push(tr(info.status.lastError));
  else if (info.status.lastError) parts.push(`${tr("上次同步失败：")}${tr(info.status.lastError)}`);
  else if (info.status.lastSuccessAt) parts.push(`${tr("上次同步：")}${new Date(info.status.lastSuccessAt).toLocaleString(language() === "en" ? "en-US" : "zh-CN")}`);
  else parts.push(tr("还没有同步过。"));
  const waitSeconds = info.status.nextUploadIn;
  if (info.status.pending) parts.push(waitSeconds > 60 ? tr(`约 ${Math.ceil(waitSeconds / 60)} 分钟后自动上传。`) : tr("有改动等待上传。"));
  if (!info.enabled) parts.push(tr("自动上传已关闭。"));
  if (info.insecure) parts.push(tr("当前是 http 地址，密码会明文传输，建议改用 https。"));
  return parts.join(" ");
}
function renderSyncBadge(info) {
  const badge = $("#sync-badge");
  if (!badge) return;
  if (!info?.enabled || !info.url) { badge.hidden = true; return; }
  const status = info.status;
  const [kind, text] = status.conflict ? ["conflict", "云端更新"] : status.lastError ? ["error", "同步失败"] : status.pending || status.running ? ["pending", "待同步"] : ["ok", "已同步"];
  badge.hidden = false;
  badge.className = `sync-badge ${kind}`;
  badge.textContent = tr(text);
}
function showWebdav(info) {
  ui.webdav = info;
  renderSyncBadge(info);
  const status = $("#webdav-status");
  if (status) status.textContent = webdavStatusText(info);
}
const newerLabels = { local: "本机的数据更新", cloud: "云端的数据更新", same: "两边一致", unknown: "无法判断哪边更新" };
function stampText(value) {
  return value ? new Date(value).toLocaleString(language() === "en" ? "en-US" : "zh-CN") : tr("时间未知");
}
function countsText(counts) {
  return tr(`${counts.lines} 条阅读线、${counts.ideas} 张思想卡、${counts.papers} 篇论文`);
}
function cloudCompareText(info) {
  const local = `${tr("本机：")}${stampText(info.local?.savedAt)}`;
  const cloud = `${tr("云端：")}${info.cloud ? stampText(info.cloud.savedAt) : tr("还没有备份")}`;
  return [local, cloud, tr(newerLabels[info.newer] || newerLabels.unknown)].join(" · ");
}
function showCloudCompare(info) {
  const target = $("#webdav-compare");
  if (!target) return;
  target.hidden = !info;
  target.textContent = info ? cloudCompareText(info) : "";
}
async function refreshWebdav() {
  try { showWebdav(await api("/api/webdav")); } catch { /* 拿不到同步状态时不打扰阅读 */ }
}
function noteLocalChange() {
  if (ui.webdav?.enabled) refreshWebdav();  // 取回服务端排好的下次上传时间
}
async function refreshState() {
  if (!state || document.querySelector("dialog[open]") || ui.session) return false;
  const next = await api("/api/state");
  if (JSON.stringify(next) === JSON.stringify(state)) return false;
  state = next;
  render();
  return true;
}
async function acceptNewerCard(id) {
  // 载入别处的新版本；草稿保留，并跟上新版本，确认后再保存就会覆盖。
  try { state = await api("/api/state"); } catch { return; }
  const draft = readDraft(`idea:${id}`);
  if (draft) writeDraft(`idea:${id}`, { ...draft, baseUpdatedAt: idea(id)?.updatedAt || "" });
  render();
}
function formatDuration(seconds) {
  const minutes = Math.round((seconds || 0) / 60);
  if (minutes < 1) return "不到 1 分钟";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} 分钟`;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}
function readingTotal(ideaIds) {
  const wanted = new Set(ideaIds);
  const sessions = state.sessions.filter((session) => wanted.has(session.ideaId));
  return { seconds: sessions.reduce((sum, session) => sum + (session.durationSeconds || 0), 0), count: sessions.length };
}
async function act(action, payload) {
  const data = await api("/api/action", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  state = data.state;
  if (action === "idea.update") {
    const draft = readDraft(`idea:${payload.id}`);
    if (draft && Object.entries(draft).every(([key, value]) => key === "baseUpdatedAt" || payload[key] === value)) forgetDraft(`idea:${payload.id}`);
  }
  if (data.result.lineId) ui.selectedLineId = data.result.lineId;
  if (data.result.ideaId) ui.selectedIdeaId = data.result.ideaId;
  if (data.result.paperId) { ui.selectedPaperId = data.result.paperId; ui.inspectorOpen = true; }
  if (data.result.stageId) ui.selectedStageId = data.result.stageId;
  render();
  noteLocalChange();
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
  if (ui.view !== "graph" && !ui.selectedIdeaId && !ui.selectedPaperId && current?.kind !== "model_family" && current?.ideaIds.length) {
    ui.selectedIdeaId = current.activeIdeaId || current.ideaIds[0];
  }
  if (ui.selectedPaperId && !paper(ui.selectedPaperId)) ui.selectedPaperId = "";
}

let animatedView = "";
function markMainAnimation(animate) {
  const main = $("#main-view");
  if (main?.dataset) main.dataset.animate = animate ? "1" : "0";
}
function render() {
  rememberTimelineViewport();
  const mapScroll = ui.view === "map" ? $(".paper-map-scroll") : null;
  const mapPosition = mapScroll ? { left: mapScroll.scrollLeft, top: mapScroll.scrollTop } : ui.view === "map" ? ui.mapViewport : null;
  syncSelection();
  $(".workspace").dataset.view = ui.view;
  renderNav();
  renderSidebar();
  const viewKey = `${ui.view}:${ui.selectedLineId}`;
  markMainAnimation(viewKey !== animatedView);
  animatedView = viewKey;
  renderMain();
  renderInspector();
  localize();
  centerGraph();
  restoreTimelineViewport();
  if (mapPosition) { const next = $(".paper-map-scroll"); if (next) { next.scrollLeft = mapPosition.left; next.scrollTop = mapPosition.top; } }
}
function centerGraph() {
  const scroller = $(".graph-scroll");
  if (scroller && scroller.scrollWidth > scroller.clientWidth) {
    scroller.scrollLeft = (scroller.scrollWidth - scroller.clientWidth) / 2;
  }
}
window.addEventListener("resize", centerGraph);
function updateHeaderLayout() {
  const bar = $(".topbar"), nav = $(".top-nav"), actions = $(".top-actions"), brand = $(".brand");
  if (!bar?.clientWidth || !nav?.children || !actions?.children || typeof getComputedStyle !== "function") return;
  const rowWidth = (element) => {
    const style = getComputedStyle(element), widths = [...element.children].map((child) => child.offsetWidth).filter(Boolean);
    return widths.reduce((sum, width) => sum + width, 0) + (parseFloat(style.columnGap) || 0) * Math.max(0, widths.length - 1) + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0) + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
  };
  const style = getComputedStyle(bar);
  const available = bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  bar.classList.toggle("header-wrap", brand.offsetWidth + rowWidth(nav) + rowWidth(actions) + (parseFloat(style.columnGap) || 0) * 2 > available);
}
window.addEventListener("resize", updateHeaderLayout);
function setPageZoom(value, persist = true) {
  if (!Number.isFinite(value)) value = 1;
  ui.pageZoom = Math.round(Math.max(.7, Math.min(1.5, value)) * 10) / 10;
  if (document.documentElement?.style) {
    document.documentElement.style.zoom = String(ui.pageZoom);
    document.documentElement.style.setProperty?.("--page-scale", String(ui.pageZoom));
  }
  const control = $("[data-page-zoom-percent]");
  if (control) control.textContent = `${Math.round(ui.pageZoom * 100)}%`;
  if (persist) { try { localStorage.setItem("paperline-page-zoom", String(ui.pageZoom)); } catch { /* Zoom still works without local storage. */ } }
  updateHeaderLayout();
  syncInspectorLayout();
}
try { setPageZoom(Number(localStorage.getItem("paperline-page-zoom") || 1), false); }
catch { setPageZoom(1, false); }
function zoomGraph(scroller, requested, anchor = null) {
  const svg = scroller?.querySelector("svg");
  if (!svg || !Number.isFinite(requested)) return false;
  const map = scroller.classList.contains("paper-map-scroll"), timeline = scroller.classList.contains("timeline-scroll");
  const previous = timeline ? ui.timelineZoom : map ? ui.mapZoom : ui.ideaGraphZoom;
  const zoom = Math.max(.15, Math.min(2, requested));
  if (zoom === previous) return true;
  const x = anchor?.x ?? scroller.clientWidth / 2;
  const y = anchor?.y ?? scroller.clientHeight / 2;
  const left = (scroller.scrollLeft + x) * zoom / previous - x;
  const top = (scroller.scrollTop + y) * zoom / previous - y;
  const box = svg.viewBox.baseVal;
  svg.setAttribute("width", box.width * zoom);
  svg.setAttribute("height", box.height * zoom);
  scroller.scrollLeft = Math.max(0, left);
  scroller.scrollTop = Math.max(0, top);
  if (map) { ui.mapZoom = zoom; if (!ui.selectedPaperId) ui.mapOverviewZoom = zoom; }
  else if (timeline) { ui.timelineZoom = zoom; rememberTimelineViewport(); }
  else ui.ideaGraphZoom = zoom;
  const control = $(timeline ? "#timeline-zoom-percent" : map ? "[data-action='map-zoom'][data-step='0']" : "[data-action='idea-zoom'][data-step='0']");
  if (control) control.textContent = `${Math.round(zoom * 100)}%`;
  return true;
}
function graphZoomModifier() {
  const platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "";
  return /Windows|Win32|Win64/i.test(platform) ? "ctrlKey" : "metaKey";
}
function graphZoomHint() { return graphZoomModifier() === "ctrlKey" ? "按住 Ctrl + 滚轮缩放" : "按住 Command + 滚轮缩放"; }
function zoomGraphWheel(event) {
  if (!event[graphZoomModifier()] || !event.cancelable || !Number.isFinite(event.deltaY) || !event.deltaY) return;
  const scroller = event.target.closest?.(".paper-map-scroll, .graph-scroll, .timeline-scroll");
  if (!scroller) return;
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1);
  const previous = scroller.classList.contains("timeline-scroll") ? ui.timelineZoom : scroller.classList.contains("paper-map-scroll") ? ui.mapZoom : ui.ideaGraphZoom;
  const rect = scroller.getBoundingClientRect();
  const scaleX = scroller.offsetWidth ? rect.width / scroller.offsetWidth : ui.pageZoom;
  const scaleY = scroller.offsetHeight ? rect.height / scroller.offsetHeight : ui.pageZoom;
  const anchor = { x: (event.clientX - rect.left) / scaleX - scroller.clientLeft, y: (event.clientY - rect.top) / scaleY - scroller.clientTop };
  if (zoomGraph(scroller, previous * Math.exp(-Math.max(-400, Math.min(400, delta)) * .002), anchor)) event.preventDefault();
}
document.addEventListener("wheel", zoomGraphWheel, { passive: false });

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
      <span class="line-item-meta">${item.kind === "model_family" ? `${(item.stageIds || []).length} ${tr("个阶段")}` : `${item.ideaIds.length} ${tr("张卡")}`}${active ? ` · 下一张：${esc(truncate(active.title, 13))}` : ""}</span>
    </button>`;
  }).join("") : `<div class="side-empty">先创建一条想追的问题线。</div>`;
  const current = line(ui.selectedLineId);
  const active = idea(current?.activeIdeaId) || idea(current?.ideaIds[0]);
  $("#today-panel").innerHTML = current && active ? `<div class="today-kicker"><span class="pulse-dot"></span> 下一步</div>
    <h3 data-user-content>${esc(active.title)}</h3><p data-user-content>${esc(current.title)}</p>
    ${latestSession(active.id) ? `<div class="today-recap">${readingRecap(active.id, true)}</div>` : ""}
    <button type="button" class="button light-fill full" data-action="start-session" data-id="${esc(active.id)}">开始读 15 分钟 <span>↗</span></button>`
    : `<div class="today-kicker"><span class="pulse-dot"></span> 下一步</div><h3>从一张卡开始</h3><p>为阅读线添加思想卡，就能开始第一次阅读。</p><button type="button" class="button light-fill full" data-action="new-idea">新建思想卡 <span>＋</span></button>`;
  if (current?.kind === "model_family") {
    const target = stage(current.activeStageId) || stage(current.stageIds?.[0]);
    $("#today-panel").innerHTML = `<div class="today-kicker">${tr("模型演进线")}</div><h3 data-user-content>${esc(target?.title || current.title)}</h3><p>${tr("独立记录阶段贡献与论文，方法关联可选。")}</p>${target ? `<button type="button" class="button light-fill full" data-workspace-action="read-stage" data-id="${esc(target.id)}">开始阶段阅读</button>` : `<button type="button" class="button light-fill full" data-action="select-line" data-id="${esc(current.id)}">添加阶段</button>`}`;
  }
}

function pageHeader(kicker, title, description, actions = "", userTitle = true, userDescription = false) {
  return `<div class="page-head"><div><span class="eyebrow">${kicker}</span><h1 ${userTitle ? "data-user-content" : ""}>${esc(title)}</h1><p ${userDescription ? "data-user-content" : ""}>${esc(description || "")}</p></div><div class="page-actions">${actions}</div></div>`;
}
function renderMain() {
  const current = line(ui.selectedLineId);
  if (ui.view === "recommendations") return renderRecommendations();
  if (ui.view === "map") return renderPaperMap();
  if (ui.view === "papers") return renderPapers();
  if (ui.view === "ideas") return renderIdeas();
  if (ui.view === "graph") return renderMethodsWorkspace();
  if (ui.view === "outline" && current?.kind === "model_family") return renderStageLine(current);
  if (!current) {
    const selected = idea(ui.selectedIdeaId);
    if (selected && ui.view === "graph") {
      $("#main-view").innerHTML = pageHeader("IDEA GRAPH / 思想图", selected.title, "这张思想卡还没有加入阅读线。", `<button type="button" class="button secondary" data-action="new-line">＋ 创建阅读线</button>`) + graphMarkup(selected);
      return;
    }
    $("#main-view").innerHTML = `<div class="welcome"><div class="welcome-symbol">↗</div><span class="eyebrow">START HERE</span><h1>把好奇心接成一条线。</h1><p>创建一条研究问题线。读到新思想时，把它做成卡片；之后每篇论文都能连回同一张卡。</p><button type="button" class="button primary" data-action="new-line">创建第一条阅读线</button>${globalThis.PaperLineDesktop?.enabled ? `<p>已有浏览器版数据？导入原来的备份或包含草稿的迁移包。</p><button type="button" class="button secondary" data-action="restore-backup">导入备份或迁移包</button>` : ""}</div>`;
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
  const paperEdges = state.edges.filter((item) => item.fromType === "paper" && item.toType !== "stage" && item.toId === focus.id).sort(comparePaperRelations);
  const ideaEdges = state.edges.filter((item) => item.fromType === "idea" && (item.fromId === focus.id || item.toId === focus.id));
  const graphWidth = focus.entityType === "method" && !ideaEdges.length ? 700 : 1000;
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
  const center = `<g class="graph-focus" role="group" aria-label="当前思想 ${esc(focus.title)}"><title data-user-content>${esc(focus.title)}</title><rect x="410" y="${centerY - 48}" width="240" height="96" rx="22"/><text x="430" y="${centerY - 10}" class="focus-title" data-user-content>${esc(truncate(focus.title, 22))}</text><text x="430" y="${centerY + 19}" class="focus-sub">${labels.kind[focus.kind]} · ${labels.status[focus.status]}</text></g>`;
  const more = paperEdges.length > 7 || ideaEdges.length > 7;
  const paperCount = new Set(paperEdges.map((item) => item.fromId)).size;
  const parent = ideaEdges.find((connection) => connection.toId === focus.id && connection.relation === "extends");
  return `${parent ? `<button type="button" class="button quiet parent-return" data-action="select-idea" data-id="${esc(parent.fromId)}"><span>↖ 返回来源</span> <span data-user-content>${esc(idea(parent.fromId)?.title)}</span></button>` : ""}<section class="graph-panel"><div class="graph-toolbar"><div class="graph-stats"><span><b>${paperCount}</b> ${countUnit(paperCount, "篇论文", "paper", "papers")}</span><span><b>${ideaEdges.length}</b> ${countUnit(ideaEdges.length, "条思想关联", "idea connection", "idea connections")}</span></div><div class="graph-legend"><span><i class="legend-paper"></i>论文</span><span><i class="legend-idea"></i>思想</span></div>${paperRelationLegend()}</div>
    <div class="graph-zoom"><span>${esc(tr(graphZoomHint()))}</span>${focus.entityType === "method" ? `<button type="button" class="button quiet" data-workspace-action="fit-method">全图</button>` : ""}<button type="button" class="button quiet" data-action="idea-zoom" data-step="-0.2" aria-label="缩小思想图">−</button><button type="button" class="button quiet" data-action="idea-zoom" data-step="0" aria-label="重置思想图缩放">${Math.round(ui.ideaGraphZoom * 100)}%</button><button type="button" class="button quiet" data-action="idea-zoom" data-step="0.2" aria-label="放大思想图">＋</button></div>
    <div class="graph-scroll" tabindex="0"><svg class="idea-graph" width="${graphWidth * ui.ideaGraphZoom}" height="${height * ui.ideaGraphZoom}" viewBox="0 0 ${graphWidth} ${height}" role="group" aria-label="${esc(focus.title)} 与 ${paperCount} 篇论文及 ${ideaEdges.length} 条思想关系的图谱"><defs><pattern id="dot-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--graph-dot)"/></pattern></defs><rect width="1000" height="${height}" fill="url(#dot-grid)"/>${paths}${nodes}${center}</svg></div>
    ${more ? `<button type="button" class="graph-more" data-action="expand-graph">${ui.graphExpanded ? "收起部分节点" : `展开全部关联（${paperEdges.length + ideaEdges.length}）`}</button>` : ""}
    <div class="graph-bottom"><p>${paperCount ? "同一个思想卡可以汇集多篇论文；每条连线记录具体用法。" : "从论文库导入来源，再建立“论文 → 思想”的关联。"}</p><div><button type="button" class="button quiet" data-action="link-paper">＋ 关联论文</button><button type="button" class="button quiet" data-action="derive-idea">＋ 引申新卡</button><button type="button" class="button quiet" data-action="link-idea">关联已有思想</button></div></div></section>`;
}
function graphNode(kind, item, x, y, width, relation = "") {
  const secondary = kind === "paper" ? [displayAuthors(item), item.year].filter(Boolean).join(" · ") || "来源论文" : `${labels.kind[item.kind]} · ${labels.status[item.status]}`;
  const institution = kind === "paper" ? paperInstitution(item) : "";
  const titleY = institution ? y + 33 : y + 26;
  return `<g class="graph-node ${kind}-node ${kind === "paper" ? paperRoleClass(relation) : ""}" data-action="select-${kind}" data-id="${esc(item.id)}" role="button" tabindex="0" aria-label="查看${kind === "paper" ? "论文" : "思想"} ${esc(item.title)}"><title data-user-content>${esc([item.title, institution, kind === "paper" ? item.authors : ""].filter(Boolean).join(" · "))}</title><rect x="${x}" y="${y}" width="${width}" height="62" rx="17"/>${institution ? `<text x="${x + width - 14}" y="${y + 15}" text-anchor="end" class="graph-node-institution" data-user-content>${esc(truncate(institution.replace(/\s+/g, " "), 26))}</text>` : ""}<text x="${x + 16}" y="${titleY}" class="node-title" data-user-content>${esc(truncate(item.title, kind === "paper" ? 25 : 20))}</text><text x="${x + 16}" y="${institution ? y + 50 : y + 47}" class="node-sub" ${kind === "paper" && (item.authors || item.year) ? "data-user-content" : ""}>${esc(truncate(secondary, 30))}</text></g>`;
}

function renderOutline(current) {
  const actions = `${current.ideaIds.length ? `<button type="button" class="button primary" data-action="start-session">开始读 ↗</button>` : ""}<button type="button" class="button secondary" data-action="new-idea">＋ 思想卡</button><button type="button" class="button quiet" data-action="attach-idea">关联已有卡片</button><button type="button" class="button quiet" data-action="edit-line">编辑</button>`;
  const last = current.ideaIds.length - 1;
  let rows = current.ideaIds.map((id, index) => {
    const item = idea(id);
    if (!item) return "";
    const paperCount = state.edges.filter((connection) => connection.fromType === "paper" && connection.toType !== "stage" && connection.toId === id).length;
    const read = readingTotal([id]).seconds;
    const moves = `<span class="move-group"><button type="button" class="mini-action move-action" data-action="move-idea" data-id="${esc(id)}" data-offset="-1" aria-label="上移 ${esc(item.title)}" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" class="mini-action move-action" data-action="move-idea" data-id="${esc(id)}" data-offset="1" aria-label="下移 ${esc(item.title)}" ${index === last ? "disabled" : ""}>↓</button></span>`;
    return `<div class="outline-row ${current.activeIdeaId === id ? "is-next" : ""}"><span class="step-num">${String(index + 1).padStart(2, "0")}</span><button type="button" class="outline-body" data-action="select-idea" data-id="${esc(id)}"><strong data-user-content>${esc(item.title)}</strong><small><span ${item.summary ? "data-user-content" : ""}>${esc(item.summary || "等待写下一句话理解")}</span> · <span>${paperCount} 篇论文</span>${read ? ` · <span>已读 ${formatDuration(read)}</span>` : ""}</small></button><span class="status-pill ${item.status}">${labels.status[item.status]}</span>${moves}<button type="button" class="mini-action" data-action="set-next" data-id="${esc(id)}">${current.activeIdeaId === id ? "下一张" : "设为下一张"}</button><button type="button" class="mini-action remove-action" data-action="detach-idea" data-id="${esc(id)}" aria-label="从阅读线移出 ${esc(item.title)}">×</button></div>`;
  }).join("");
  $("#main-view").innerHTML = pageHeader("READING PATH / 阅读线", current.title, current.question || "这条线要回答的问题可以在“编辑”中补充。", actions, true, Boolean(current.question))
    + `<div class="section-title"><div><span class="eyebrow">YOUR ROUTE</span><h2>按顺序学习</h2></div><span><span>${current.ideaIds.length} 张卡</span>${readingTotal(current.ideaIds).seconds ? ` · <span>累计阅读 ${formatDuration(readingTotal(current.ideaIds).seconds)}</span>` : ""}</span></div>`
    + (rows ? `<div class="outline-list">${rows}</div>` : `<div class="empty-main compact"><h2>还没有思想卡</h2><p>记录阅读时遇到的第一个概念、创新或问题。</p><button type="button" class="button primary" data-action="new-idea">添加第一张卡</button></div>`)
    + `<div class="outline-tip"><strong>阅读线是学习顺序。</strong><span>同一张思想卡可以加入多条阅读线，论文关系会共用。</span></div>`;
}

function statusFilterButtons() {
  const options = [["", "全部"], ["inbox", "待学"], ["learning", "正在学"], ["understood", "已理解"]];
  return options.map(([value, label]) => `<button type="button" class="filter-button ${ui.ideaStatus === value ? "active" : ""}" data-action="filter-status" data-status="${value}" aria-pressed="${ui.ideaStatus === value ? "true" : "false"}">${label}</button>`).join("");
}
function searchLines(query) {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  return state.lines.filter((item) => terms.every((term) => normalized([item.title, item.question].join(" ")).includes(term)));
}
function searchEverything(query) {
  // 选了状态就只看思想卡：阅读线和论文没有状态可比。
  if (ui.ideaStatus) return searchIdeas(query).filter((item) => item.status === ui.ideaStatus).map((item) => ({ kind: "idea", item }));
  return [
    ...searchLines(query).map((item) => ({ kind: "line", item })),
    ...searchIdeas(query).map((item) => ({ kind: "idea", item })),
    ...searchPapers(query).map((item) => ({ kind: "paper", item })),
  ];
}
function paperCountFor(ideaId) {
  return new Set(state.edges.filter((connection) => connection.fromType === "paper" && connection.toType !== "stage" && connection.toId === ideaId).map((connection) => connection.fromId)).size;
}
function searchResult({ kind, item }) {
  const open = `data-action="search-open" data-kind="${kind}" data-id="${esc(item.id)}"`;
  if (kind === "line") {
    const next = idea(item.activeIdeaId) || idea(item.ideaIds[0]);
    return `<button type="button" class="search-result line" ${open}><div class="search-result-top"><strong data-user-content>${esc(item.title)}</strong><span class="type-tag line">阅读线</span></div><p ${item.question ? "data-user-content" : ""}>${esc(truncate(item.question || "还没写下这条线要回答的问题", 150))}</p><span>${item.ideaIds.length} 张卡${next ? ` · 下一张：${esc(truncate(next.title, 13))}` : ""}</span></button>`;
  }
  if (kind === "paper") {
    const ideaCount = new Set(state.edges.filter((connection) => connection.fromType === "paper" && connection.toType !== "stage" && connection.fromId === item.id).map((connection) => connection.toId)).size;
    return `<button type="button" class="search-result paper" ${open}><div class="search-result-top"><strong data-user-content>${esc(item.title)}</strong><span class="type-tag paper">论文</span></div><small ${item.authors || item.year ? "data-user-content" : ""}>${esc([displayAuthors(item), item.year].filter(Boolean).join(" · ") || "手动添加")}</small><span>${ideaCount} 个思想</span></button>`;
  }
  return `<button type="button" class="search-result idea" ${open}><div class="search-result-top"><strong data-user-content>${esc(item.title)}</strong><span class="tag-row"><span class="type-tag idea">思想卡</span><span class="status-pill ${item.status}">${labels.status[item.status]}</span></span></div>${item.aliases?.length ? `<small data-user-content>${esc(item.aliases.join(" · "))}</small>` : ""}<p ${item.summary ? "data-user-content" : ""}>${esc(truncate(item.summary || "等待写下一句话理解", 150))}</p><span>${paperCountFor(item.id)} 篇论文</span></button>`;
}
function renderIdeas() {
  $("#main-view").innerHTML = pageHeader("SEARCH / 搜索", "搜索", "一个框同时搜阅读线、思想卡和论文，左侧色条和标签区分类型。", `<button type="button" class="button secondary" data-action="new-idea">＋ 思想卡</button>`, false)
    + `<div class="filter-bar" role="group" aria-label="按状态筛选">${statusFilterButtons()}</div>`
    + `<label class="idea-search-label">搜索全部内容<input id="idea-search" type="search" placeholder="搜索标题、别名、研究问题、作者或笔记内容" value="${esc(ui.ideaQuery)}"></label><div id="idea-search-results" aria-live="polite"></div>`;
  renderSearchResults();
}
function renderSearchResults() {
  const results = searchEverything(ui.ideaQuery);
  $("#idea-search-results").innerHTML = `<p class="field-help result-count">${results.length} 条结果</p>` + (results.length
    ? `<div class="search-list">${results.map(searchResult).join("")}</div>`
    : `<div class="empty-main compact"><h2>没有找到相关内容</h2><p>换个关键词，或者新建一张思想卡。</p><button type="button" class="button primary" data-action="new-idea">新建思想卡</button></div>`);
  localize($("#idea-search-results"));
}
let ideaMatchTimer = null;
function scheduleIdeaMatches() {
  clearTimeout(ideaMatchTimer);
  ideaMatchTimer = setTimeout(renderIdeaMatches, 140);
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

function searchPapers(query) {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  return state.papers.filter((item) => terms.every((term) => normalized([item.title, item.authors, item.year, item.doi, paperInstitution(item)].join(" ")).includes(term)));
}
function paperReadStatus(item) { return item.readStatus === "read" ? "read" : "unread"; }
function paperReadLabel(item) { return paperReadStatus(item) === "read" ? "已读" : "未读"; }
function mapPapers() { return searchPapers(ui.mapQuery).filter((item) => !ui.mapStatus || paperReadStatus(item) === ui.mapStatus); }
function validCitations() {
  const ids = new Set(state.papers.map((item) => item.id));
  return (state.citations || []).filter((item) => item.fromId !== item.toId && ids.has(item.fromId) && ids.has(item.toId));
}
function referenceStatus(item) {
  const names = { complete: "已分析参考文献", partial: "参考文献分析不完整", analyzed: "已分析参考文献", no_pdf: "没有 PDF", missing_pdf: "PDF 尚未下载", unavailable: "PDF 暂不可用", no_text: "PDF 无可提取文字", no_references: "未识别参考文献", error: "参考文献分析失败", pending: "尚未分析参考文献", skipped: "尚未分析参考文献" };
  return names[item.referenceAnalysis?.status] || "尚未分析参考文献";
}
function orderedMapPapers() {
  const counts = libraryCitationCounts();
  return mapPapers().sort((a, b) => (ui.mapSort === "year"
    ? (Number(a.year) || Infinity) - (Number(b.year) || Infinity)
    : (counts.get(b.id) || 0) - (counts.get(a.id) || 0))
    || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id)));
}
function paperMapLayout() {
  const counts = libraryCitationCounts();
  const nodes = [], headings = [];
  const cellWidth = 330, cellHeight = 148;
  const add = (item, x, row, side = "overview") => {
    const node = { item, x, y: 64 + row * cellHeight, width: 276 + Math.min(24, (counts.get(item.id) || 0) * 4), key: `${side}:${item.id}`, side };
    nodes.push(node);
    return node;
  };
  const selected = paper(ui.selectedPaperId);
  let width, rows;
  const connections = validCitations();
  if (selected) {
    const citedIds = new Set(), citingIds = new Set();
    for (const connection of connections) {
      if (connection.toId === selected.id) citedIds.add(connection.fromId);
      if (connection.fromId === selected.id) citingIds.add(connection.toId);
    }
    const byYear = (a, b) => (Number(a.year) || Infinity) - (Number(b.year) || Infinity)
      || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id));
    const cited = state.papers.filter((item) => citedIds.has(item.id)).sort(byYear);
    const citing = state.papers.filter((item) => citingIds.has(item.id)).sort(byYear);
    cited.forEach((item, row) => add(item, 30, row, "cited"));
    add(selected, 30 + cellWidth, 0, "current");
    citing.forEach((item, row) => add(item, 30 + 2 * cellWidth, row, "citing"));
    headings.push({ x: 30, label: "它引用的论文" }, { x: 30 + cellWidth, label: "当前论文" }, { x: 30 + 2 * cellWidth, label: "引用它的论文" });
    width = 3 * cellWidth + 30;
    rows = Math.max(1, cited.length, citing.length);
  } else if (ui.mapSort === "year") {
    const groups = new Map();
    for (const item of orderedMapPapers()) {
      const year = Number(item.year) > 0 ? String(item.year) : "年份未知";
      if (!groups.has(year)) groups.set(year, []);
      groups.get(year).push(item);
    }
    let column = 0;
    rows = 1;
    for (const [year, items] of groups) {
      for (let part = 0; part < Math.ceil(items.length / 6); part += 1) headings.push({ x: 30 + (column + part) * cellWidth, label: year });
      // Crowded years wrap after six papers while keeping a single clear year band.
      items.forEach((item, index) => add(item, 30 + (column + Math.floor(index / 6)) * cellWidth, index % 6));
      rows = Math.max(rows, Math.min(6, items.length));
      column += Math.ceil(items.length / 6);
    }
    width = Math.max(660, column * cellWidth + 30);
  } else {
    const results = orderedMapPapers();
    results.forEach((item, index) => add(item, 30 + (index % 4) * cellWidth, Math.floor(index / 4)));
    headings.push({ x: 30, label: "库内被引较多的论文排在上方" });
    width = Math.max(660, Math.min(4, results.length) * cellWidth + 30);
    rows = Math.ceil(results.length / 4);
  }
  const positions = new Map(nodes.map((node) => [node.key, node]));
  const showOverviewLines = ui.mapSort === "year" ? ui.mapTimelineConnections : ui.mapAllConnections;
  const links = connections.flatMap((connection) => {
    const fromKey = selected ? connection.toId === selected.id ? `cited:${connection.fromId}` : `current:${connection.fromId}` : `overview:${connection.fromId}`;
    const toKey = selected ? connection.fromId === selected.id ? `citing:${connection.toId}` : `current:${connection.toId}` : `overview:${connection.toId}`;
    const from = positions.get(fromKey), to = positions.get(toKey);
    return from && to && (selected || showOverviewLines) ? [{ connection, from, to }] : [];
  });
  return { nodes, links, headings, width, height: Math.max(420, rows * cellHeight + 80), focused: Boolean(selected) };
}
function syncMapConnectionsButton() {
  const button = $("[data-action='map-connections']");
  if (!button) return;
  const focused = Boolean(paper(ui.selectedPaperId));
  const shown = ui.mapSort === "year" ? ui.mapTimelineConnections : ui.mapAllConnections;
  button.disabled = focused;
  button.textContent = tr(focused ? "局部引用连线" : shown ? "隐藏全部连线" : "显示全部连线");
  button.setAttribute?.("aria-pressed", String(focused || shown));
}
function updatePaperSelection(id) {
  ui.stageInspect = false; ui.newStage = false;
  if (!["map", "recommendations"].includes(ui.view)) {
    ui.selectedPaperId = id;
    ui.inspectorOpen = Boolean(id);
    if (ui.view === "papers") ui.selectedIdeaId = "";
    render();
    return;
  }
  // Keep the page and its controls in place; replacing main would invalidate focus
  // and let the browser anchor the document to a displaced SVG node or inspector.
  const left = window.scrollX || 0, top = window.scrollY || 0;
  const changed = ui.selectedPaperId !== id;
  const restoreFocus = document.activeElement?.matches?.(".map-node, .citation-row [data-action='select-paper']");
  if (ui.view === "map") {
    if (id && !ui.selectedPaperId) {
      ui.mapOverviewZoom = ui.mapZoom;
      const available = $(".paper-map-scroll")?.clientWidth;
      if (available) ui.mapZoom = Math.max(.15, Math.min(1, available / 1020));
    } else if (!id && ui.selectedPaperId) ui.mapZoom = ui.mapOverviewZoom;
  }
  ui.selectedPaperId = id;
  ui.selectedIdeaId = "";
  ui.inspectorOpen = Boolean(id);
  if (ui.view === "map") renderPaperMapResults();
  renderInspector();
  if (changed) $("#inspector").scrollTop = 0;
  localize($("#inspector"));
  if (restoreFocus) {
    const target = [...document.querySelectorAll(".map-node")].find((node) => node.dataset.id === id);
    (target || $("#main-view"))?.focus({ preventScroll: true });
  }
  const scroller = $(".paper-map-scroll");
  if (ui.view === "map" && scroller) { scroller.scrollLeft = 0; scroller.scrollTop = 0; }
  window.scrollTo?.({ left, top, behavior: "instant" });
}
function syncInspectorLayout() {
  const inspector = $("#inspector");
  const mapView = ["map", "recommendations", "graph", "outline", "papers"].includes(ui.view) && (Boolean(ui.selectedPaperId) || ui.stageInspect);
  inspector.classList.toggle("paper-inspector", mapView);
  inspector.classList.toggle("is-open", mapView && (Boolean(ui.selectedPaperId) || ui.stageInspect) && ui.inspectorOpen);
}
function renderPaperMap() {
  const header = pageHeader("PAPER MAP / 论文地图", "沿着引用，看见阅读全貌", "如果 A 引用了 B，箭头从 B 指向 A。阅读标注独立保存，重新同步后仍然保留。", `<button type="button" class="button secondary" data-action="new-paper">＋ 添加论文</button>`, false);
  const read = state.papers.filter((item) => paperReadStatus(item) === "read").length;
  $("#main-view").innerHTML = header + `<section id="paper-map-sync" class="paper-map-sync" aria-live="polite"></section>
    <div class="map-summary"><span><b>${state.papers.length}</b> 篇论文</span><span><i class="read-dot unread"></i><b>${state.papers.length - read}</b> 未读</span><span><i class="read-dot read"></i><b>${read}</b> 已读</span><span><b>${validCitations().length}</b> 条库内引用</span></div>
    <label class="idea-search-label">搜索地图中的论文<input id="map-search" type="search" placeholder="搜索标题、作者、年份或 DOI" value="${esc(ui.mapQuery)}"></label>
    <div class="map-controls"><div class="filter-bar">${[["", "全部论文"], ["unread", "未读"], ["read", "已读"]].map(([status, label]) => `<button type="button" class="filter-button ${ui.mapStatus === status ? "active" : ""}" data-action="filter-paper-read" data-status="${status}" aria-pressed="${ui.mapStatus === status}">${label}</button>`).join("")}</div><div class="map-zoom"><label class="map-sort">排序<select id="map-sort"><option value="citations" ${ui.mapSort === "citations" ? "selected" : ""}>库内被引（多到少）</option><option value="year" ${ui.mapSort === "year" ? "selected" : ""}>年份（早到晚）</option></select></label><button type="button" class="button quiet" data-action="map-connections" aria-pressed="${ui.mapAllConnections}">${ui.mapAllConnections ? "隐藏全部连线" : "显示全部连线"}</button><button type="button" class="button quiet" data-action="map-fit">全图</button><button type="button" class="button quiet" data-action="map-zoom" data-step="-0.2" aria-label="缩小地图">−</button><button type="button" class="button quiet" data-action="map-zoom" data-step="0" aria-label="重置地图缩放">${Math.round(ui.mapZoom * 100)}%</button><button type="button" class="button quiet" data-action="map-zoom" data-step="0.2" aria-label="放大地图">＋</button></div></div>
    <div id="paper-map-results"></div>`;
  renderZoteroSync();
  renderPaperMapResults();
}
function renderPaperMapResults() {
  const layout = paperMapLayout();
  const { nodes: mapNodes, links, width, height, focused } = layout;
  syncMapConnectionsButton();
  const zoomButton = $("[data-action='map-zoom'][data-step='0']");
  if (zoomButton) zoomButton.textContent = `${Math.round(ui.mapZoom * 100)}%`;
  if (!mapNodes.length) {
    $("#paper-map-results").innerHTML = `<div class="empty-main"><div class="empty-orbit">↗</div><h2>${state.papers.length ? "没有符合筛选条件的论文" : "把 Zotero 文献库变成论文地图"}</h2><p>${state.papers.length ? "试试其他关键词或阅读状态。" : "点击上方同步按钮，导入论文并分析本机 PDF 的参考文献。"}</p></div>`;
    localize($("#paper-map-results"));
    return;
  }
  const counts = libraryCitationCounts();
  const selected = focused ? ui.selectedPaperId : "";
  const orderingLabel = focused ? "局部引用图" : ui.mapSort === "year" ? "按年份从早到晚排序" : "库内被引较多的论文排在上方";
  const headings = layout.headings.map((heading) => `<text x="${heading.x}" y="34" class="map-year">${esc(tr(heading.label))}</text>`).join("");
  const paths = links.map(({ connection: item, from, to }) => {
    const forward = from.x < to.x;
    const x1 = from.x + (forward ? from.width : 0), x2 = to.x + (forward ? 0 : to.width);
    const y1 = from.y + 47, y2 = to.y + 47;
    const bend = from.x === to.x ? 66 : Math.max(focused ? 12 : 40, Math.abs(x2 - x1) * .35);
    const path = from.x === to.x ? `M ${from.x + from.width} ${y1} C ${from.x + from.width + bend} ${y1}, ${to.x + to.width + bend} ${y2}, ${to.x + to.width + 2} ${y2}` : `M ${x1} ${y1} C ${x1 + (forward ? bend : -bend)} ${y1}, ${x2 + (forward ? -bend : bend)} ${y2}, ${x2 + (forward ? -2 : 2)} ${y2}`;
    return `<path class="citation-link ${selected && item.fromId !== selected && item.toId !== selected ? "muted" : ""}" data-from-id="${esc(item.fromId)}" data-to-id="${esc(item.toId)}" d="${path}" marker-end="url(#citation-arrow)"><title data-user-content>${esc(paper(item.fromId).title)} → ${esc(paper(item.toId).title)}</title></path>`;
  }).join("");
  const nodes = mapNodes.map(({ item, x, y, width: nodeWidth, key, side }) => {
    const title = String(item.title || "");
    const status = paperReadStatus(item), count = counts.get(item.id) || 0;
    const institution = paperInstitution(item);
    return `<g class="map-node ${status} ${count > 2 ? "highly-cited" : count ? "cited" : "uncited"} ${selected === item.id ? "selected" : ""}" data-map-key="${esc(key)}" data-map-side="${side}" data-citation-count="${count}" data-action="select-paper" data-id="${esc(item.id)}" role="button" tabindex="0" aria-label="${esc(`${tr(paperReadLabel(item))}: ${title}`)}"><title data-user-content>${esc([title, institution, item.authors].filter(Boolean).join(" · "))}</title><rect x="${x}" y="${y}" width="${nodeWidth}" height="116" rx="14"/><circle cx="${x + 17}" cy="${y + 18}" r="4"/><text x="${x + 28}" y="${y + 22}" class="map-node-status">${paperReadLabel(item)}</text>${institution ? `<text x="${x + nodeWidth - 12}" y="${y + 22}" text-anchor="end" class="map-node-institution" data-user-content>${esc(truncate(institution.replace(/\s+/g, " "), 16))}</text>` : ""}<text x="${x + 14}" y="${y + 46}" class="node-title" data-user-content>${esc(truncate(title, 33))}</text><text x="${x + 14}" y="${y + 65}" class="node-sub" data-user-content>${esc(truncate([displayAuthors(item), item.year].filter(Boolean).join(" · "), 42))}</text><text x="${x + 14}" y="${y + 86}" class="map-node-count">${tr("库内被引")} ${count}</text><text x="${x + 14}" y="${y + 103}" class="map-node-analysis">${item.zoteroMissing ? "Zotero 中已移除" : referenceStatus(item)}</text></g>`;
  }).join("");
  $("#paper-map-results").innerHTML = `<section class="graph-panel"><div class="map-caption"><span>${new Set(mapNodes.map((node) => node.item.id)).size} 篇可见论文 · ${links.length} 条可见引用</span><span>${tr(orderingLabel)} · ${tr(graphZoomHint())}</span>${focused ? `<button type="button" class="button quiet" data-action="map-overview">返回全库排序</button>` : ""}</div><div class="paper-map-scroll" tabindex="0" aria-label="论文引用地图"><svg class="paper-map" width="${width * ui.mapZoom}" height="${height * ui.mapZoom}" viewBox="0 0 ${width} ${height}" role="group" aria-label="被引用论文指向引用它的论文"><defs><marker id="citation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#658e77"/></marker><pattern id="map-dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--graph-dot)"/></pattern></defs><rect width="${width}" height="${height}" fill="url(#map-dots)"/>${headings}${paths}${nodes}</svg></div>${focused ? `<p class="map-footnote">局部图展示当前论文与全部直接邻居；搜索和阅读筛选仅作用于全库视图。</p>` : ""}<p class="map-footnote">仅连接库内已识别的引用；没有连线不代表没有引用。选中论文显示相关连线；可查看引用依据与分析状态。</p></section>`;
  localize($("#paper-map-results"));
}
function renderZoteroSync() {
  const target = $("#paper-map-sync");
  if (!target || ui.view !== "map") return;
  const job = ui.zoteroSync;
  const running = job?.status === "running";
  const last = state.zoteroSync?.syncedAt;
  const message = ui.zoteroSyncError || job?.error || job?.message || (last ? `${tr("上次同步：")}${stampText(last)}` : tr("保持 Zotero 开启；同步当前个人文献库，新增论文后可再次同步。"));
  const stats = job?.result?.stats || state.zoteroSync?.stats;
  const coverage = stats ? `<p class="sync-coverage">${tr("完整分析")} ${Number(stats.complete || 0)} · ${tr("部分分析")} ${Number(stats.partial || 0)} · ${tr("没有 PDF")} ${Number(stats.no_pdf || 0)} · ${tr("PDF 无可提取文字")} ${Number(stats.no_text || 0)} · ${tr("未识别参考文献")} ${Number(stats.no_references || 0)}</p><p class="field-help">仅连接库内已识别的引用；没有连线不代表没有引用。</p>` : "";
  target.innerHTML = `<div><strong>${running ? "正在同步 Zotero" : "Zotero 文献库"}</strong><p class="${ui.zoteroSyncError || job?.status === "error" ? "field-error" : "field-help"}" data-user-content>${esc(message)}</p>${running && job.total ? `<progress max="${Number(job.total)}" value="${Number(job.processed || 0)}" aria-label="Zotero 同步进度"></progress><small>${Number(job.processed || 0)} / ${Number(job.total)}</small>` : ""}${running && job.title ? `<p class="sync-current" data-user-content>${esc(job.title)}</p>` : ""}${coverage}</div><button type="button" class="button primary" data-action="sync-zotero-library" ${running ? "disabled" : ""}>${running ? "同步中…" : "一键同步 Zotero"}</button>`;
  localize(target);
}
async function applyZoteroSync(job) {
  ui.zoteroSync = job;
  ui.zoteroSyncError = "";
  clearTimeout(ui.zoteroSyncTimer);
  if (job.status === "complete") {
    state = await api("/api/state");
    render();
  } else renderZoteroSync();
  if (job.status === "running") ui.zoteroSyncTimer = setTimeout(refreshZoteroSync, 1200);
}
async function refreshZoteroSync() {
  try { await applyZoteroSync(await api("/api/zotero/sync")); }
  catch (error) {
    ui.zoteroSyncError = `${tr("无法更新同步状态：")}${error.message}`;
    renderZoteroSync();
    clearTimeout(ui.zoteroSyncTimer);
    if (["running", "complete"].includes(ui.zoteroSync?.status)) ui.zoteroSyncTimer = setTimeout(refreshZoteroSync, 3000);
  }
}
async function startZoteroSync() {
  if (ui.zoteroSync?.status === "running") return;
  ui.zoteroSync = { status: "running", message: tr("正在连接 Zotero…") };
  ui.zoteroSyncError = "";
  renderZoteroSync();
  try { await applyZoteroSync(await postJson("/api/zotero/sync", {})); }
  catch (error) {
    ui.zoteroSync = { status: "error", error: error.message };
    renderZoteroSync();
    toast(error.message, true);
  }
}
async function markPaper(id, readStatus) {
  await act("paper.mark", { id, readStatus });
  toast("阅读状态已保存。");
}
function renderRecommendations() {
  const items = rankedRecommendations().filter((item) => { return ui.recommendationAll || !paper(item.matchedPaperId) || paperReadStatus(paper(item.matchedPaperId)) !== "read"; });
  $("#main-view").innerHTML = pageHeader("RECOMMENDATIONS / 推荐论文", "从共同引用中发现下一篇", "按不同库内论文的引用数排序。库内被引是阅读线索，不等同于论文质量。", "", false) + `<div class="filter-bar"><button type="button" class="filter-button ${!ui.recommendationAll ? "active" : ""}" data-action="recommendation-filter" data-all="false" aria-pressed="${!ui.recommendationAll}">未读与尚未入库</button><button type="button" class="filter-button ${ui.recommendationAll ? "active" : ""}" data-action="recommendation-filter" data-all="true" aria-pressed="${ui.recommendationAll}">所有候选</button></div><p class="field-help">基于当前库已解析参考文献，非全网引用量。</p>` + (items.length ? `<div class="recommendation-list">${items.map((item) => {
    const matched = paper(item.matchedPaperId);
    const pendingTitle = item.verification === "identifier_only";
    const displayTitle = pendingTitle ? truncate(item.referenceText || item.evidence?.[0]?.text || item.doi || item.arxivId, 180) : item.title || truncate(item.referenceText, 180);
    const url = item.url || (item.doi ? `https://doi.org/${encodeURIComponent(item.doi)}` : item.arxivId ? `https://arxiv.org/abs/${encodeURIComponent(item.arxivId)}` : "");
    return `<article class="recommendation-card"><div class="recommendation-top"><h2 data-user-content>${esc(displayTitle)}</h2><span class="paper-read-badge ${matched ? paperReadStatus(matched) : "unread"}">${matched ? paperReadLabel(matched) : "尚未入库"}</span></div>${pendingTitle ? `<p class="field-help">已识别论文编号，标题尚未核实；以下保留引用原文。</p>` : ""}<p class="recommendation-reason">${tr("被")} ${item.citationCount} ${tr("篇库内论文共同引用")}</p>${matched ? `<button type="button" class="button secondary" data-action="select-paper" data-id="${esc(matched.id)}">查看库内论文</button>` : url && safeUrl(url) !== "#" ? `<a class="button secondary" href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">打开论文来源 ↗</a>` : `<p class="field-help">暂无可验证的论文链接，请查看引用原文。</p>`}<details><summary>查看引用来源与依据</summary>${item.citingIds.map((id) => `<div class="citation-row"><button type="button" class="relation-main" data-action="select-paper" data-id="${esc(id)}"><strong data-user-content>${esc(paper(id).title)}</strong></button>${(item.evidence || []).filter((evidence) => evidence.citingId === id).map((evidence) => `<p class="citation-evidence" data-user-content>${esc(evidence.text)}</p>${evidence.attachmentKey ? `<a href="zotero://open-pdf/library/items/${encodeURIComponent(evidence.attachmentKey)}">打开引用论文 PDF ↗</a>` : ""}`).join("")}</div>`).join("")}</details></article>`;
  }).join("")}</div>` : `<div class="empty-main compact"><h2>还没有可推荐的论文</h2><p>同步并分析 PDF 参考文献后，这里会展示可核查的共同引用。</p></div>`);
  localize($("#main-view"));
}
function openPaperLineDialog(id) {
  $("#paper-line-paper").value = id;
  $("#paper-line-choice").innerHTML = state.lines.map((item) => `<option value="${esc(item.id)}" data-user-content>${esc(item.title)}</option>`).join("");
  $("#paper-line-choice").value = state.lines.some((item) => item.id === ui.selectedLineId) ? ui.selectedLineId : state.lines[0]?.id || "";
  const related = new Set(state.edges.filter((connection) => connection.fromType === "paper" && connection.toType !== "stage" && connection.fromId === id).map((connection) => connection.toId));
  $("#paper-line-idea").innerHTML = `<option value="">从论文创建思想卡</option>` + state.ideas.filter((item) => related.has(item.id)).map((item) => `<option value="${esc(item.id)}" data-user-content>${esc(item.title)}</option>`).join("");
  $("#paper-line-submit").disabled = !state.lines.length;
  $("#paper-line-empty").hidden = Boolean(state.lines.length);
  openDialog("#paper-line-dialog");
}
function renderPapers() {
  const header = pageHeader("SOURCE LIBRARY / 论文库", "让论文回到思想上", "从 Zotero 导入论文，记录它提出、使用或改进了哪些思想。", `<button type="button" class="button secondary" data-action="new-paper">＋ 添加论文</button>`, false);
  if (!state.papers.length) {
    $("#main-view").innerHTML = header + `<div class="empty-main"><div class="empty-orbit">▤</div><h2>先接入第一篇论文</h2><p>可以搜索本机 Zotero，也可以手动添加来源。</p><button type="button" class="button primary" data-action="new-paper">添加论文</button></div>`;
    return;
  }
  $("#main-view").innerHTML = header
    + `<label class="idea-search-label">搜索论文<input id="paper-search" type="search" placeholder="搜索标题、作者、年份或 DOI" value="${esc(ui.paperQuery)}"></label><div id="paper-search-results" aria-live="polite"></div>`;
  renderPaperResults();
}
function renderPaperResults() {
  const results = searchPapers(ui.paperQuery);
  $("#paper-search-results").innerHTML = `<p class="field-help result-count">${results.length} 篇论文</p>` + (results.length ? `<div class="paper-list">${results.map((item) => {
    const count = new Set(state.edges.filter((connection) => connection.fromType === "paper" && connection.toType !== "stage" && connection.fromId === item.id).map((connection) => connection.toId)).size;
    return `<button type="button" class="paper-list-item ${ui.selectedPaperId === item.id ? "selected" : ""}" data-action="select-paper" data-id="${esc(item.id)}"><span class="paper-icon">▤</span><span><strong data-user-content>${esc(item.title)}</strong><small ${item.authors || item.year ? "data-user-content" : ""}>${esc([displayAuthors(item), item.year].filter(Boolean).join(" · ") || "手动添加")}</small></span><span class="paper-list-meta">${paperInstitution(item) ? `<strong class="paper-institution" data-user-content>${esc(paperInstitution(item))}</strong>` : ""}<em>${count} 个思想</em></span></button>`;
  }).join("")}</div>` : `<div class="empty-main compact"><h2>没有找到论文</h2><p>换个关键词，或添加新的论文来源。</p><button type="button" class="button primary" data-action="new-paper">添加论文</button></div>`);
  localize($("#paper-search-results"));
}

function renderInspector() {
  syncInspectorLayout();
  if (ui.view === "outline" && line(ui.selectedLineId)?.kind === "model_family" && ui.stageInspect) return renderStageInspector();
  if (ui.selectedPaperId) return renderPaperInspector(paper(ui.selectedPaperId));
  if (["map", "recommendations", "graph"].includes(ui.view)) { $("#inspector").innerHTML = `<div class="inspector-empty"><span class="eyebrow">PAPER MAP</span><h2>选中一篇论文</h2><p>在这里标记阅读状态，查看引用依据与 PDF 分析结果。</p></div>`; return; }
  if (ui.selectedIdeaId) return renderIdeaInspector(idea(ui.selectedIdeaId));
  $("#inspector").innerHTML = `<div class="inspector-empty"><span class="eyebrow">DETAILS</span><h2>选中一张卡</h2><p>卡片的理解、来源和引申会出现在这里。</p></div>`;
}
function choiceButtons(name, choices, selected, scope) {
  return Object.entries(choices).map(([key, label]) => {
    const id = `choice-${esc(scope)}-${name}-${key}`;
    return `<input type="radio" class="choice-input" id="${id}" name="${name}" value="${key}" ${selected === key ? "checked" : ""}><label class="choice-button" for="${id}">${label}</label>`;
  }).join("");
}
async function markIdea(id, name, value) {
  const draft = readDraft(`idea:${id}`);
  if (draft) writeDraft(`idea:${id}`, { ...draft, [name]: value });
  try {
    await act("idea.mark", { id, [name]: value });
    // 这次改动是自己点的，不算冲突：把草稿的版本跟上。
    const kept = readDraft(`idea:${id}`);
    if (kept) writeDraft(`idea:${id}`, { ...kept, baseUpdatedAt: idea(id)?.updatedAt || "" });
    toast(name === "status" ? "状态已更新。" : "类型已更新。");
  } catch (error) { toast(error.message, true); render(); }
}
function choiceField(name, title, choices, selected, scope) {
  const labelId = `choice-${esc(scope)}-${name}-label`;
  return `<div class="choice-field" role="group" aria-labelledby="${labelId}"><span class="choice-label" id="${labelId}">${title}</span><div class="choice-row">${choiceButtons(name, choices, selected, scope)}</div></div>`;
}
function renderIdeaInspector(item) {
  if (!item) return;
  const draft = readDraft(`idea:${item.id}`);
  const edit = { ...item, aliases: (item.aliases || []).join(", ") };
  for (const key of ["title", "aliases", "kind", "status", "entityType", "summary", "mechanism", "thoughts"]) {
    if (typeof draft?.[key] === "string") edit[key] = draft[key];
  }
  const papers = state.edges.filter((connection) => connection.fromType === "paper" && connection.toType !== "stage" && connection.toId === item.id).sort(comparePaperRelations);
  const related = state.edges.filter((connection) => connection.fromType === "idea" && (connection.fromId === item.id || connection.toId === item.id));
  const lineNames = state.lines.filter((entry) => entry.ideaIds.includes(item.id)).map((entry) => entry.title);
  $("#inspector").innerHTML = `<div class="inspector-top"><span class="eyebrow">IDEA CARD</span><span class="status-pill ${item.status}">${labels.status[item.status]}</span></div><h2 class="inspector-title" data-user-content>${esc(item.title)}</h2><p class="inspector-sub">${labels.kind[item.kind]} · 出现在 ${lineNames.length} 条阅读线</p>
    ${(() => { const total = readingTotal([item.id]); return total.count ? `<p class="reading-total">累计阅读 ${formatDuration(total.seconds)} · ${total.count} 次</p>` : ""; })()}
    <form id="idea-edit-form" class="detail-form" data-id="${esc(item.id)}"><label>名称<input name="title" maxlength="120" value="${esc(edit.title)}" required></label><label>内容分类<select name="entityType">${[["method","方法"],["concept","概念"],["question","问题"],["unclassified","尚未分类"]].map(([value,label]) => `<option value="${value}" ${(edit.entityType || "unclassified") === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label>别名<input name="aliases" maxlength="1500" value="${esc(edit.aliases)}" placeholder="缩写、全称或其他写法，用逗号分隔"></label><div class="choice-grid">${choiceField("kind", "类型", labels.kind, edit.kind, item.id)}${choiceField("status", "状态", labels.status, edit.status, item.id)}</div>
    <label>一句话理解<textarea name="summary" rows="3" maxlength="4000" placeholder="用自己的话说清这张卡。">${esc(edit.summary)}</textarea></label><label>核心机制<textarea name="mechanism" rows="4" maxlength="6000" placeholder="关键步骤、公式或假设。">${esc(edit.mechanism)}</textarea></label><label>我的思考<textarea name="thoughts" rows="4" maxlength="6000" placeholder="质疑、联系、引申。">${esc(edit.thoughts)}</textarea></label><p id="idea-draft-status" class="field-help" ${draft ? "" : "hidden"}>草稿已保留，点击保存卡片可写入笔记。</p><button type="submit" class="button primary full">保存卡片</button></form>
    <div class="inspector-section"><div class="inspector-section-head"><h3>论文来源 <span>${papers.length}</span></h3><button type="button" data-action="link-paper">＋</button></div>${papers.length ? papers.map((connection) => relationRow(connection, "paper", paper(connection.fromId))).join("") : `<p class="empty-small">关联论文后，这里会显示每篇论文如何使用这个思想。</p>`}</div>
    <div class="inspector-section"><div class="inspector-section-head"><h3>思想关联 <span>${related.length}</span></h3><div><button type="button" class="text-action" data-action="derive-idea">引申新卡</button><button type="button" data-action="link-idea" aria-label="关联已有思想">＋</button></div></div>${related.length ? related.map((connection) => relationRow(connection, "idea", idea(connection.fromId === item.id ? connection.toId : connection.fromId))).join("") : `<p class="empty-small">继续追问时，可以把新的思想连进来。</p>`}</div>
    ${sessionHistory(item.id)}
    <div class="inspector-section last"><h3>所在阅读线</h3><p class="tiny-list" ${lineNames.length ? "data-user-content" : ""}>${esc(lineNames.join(" · ") || "尚未加入阅读线")}</p></div>
    <button type="button" class="button danger full inspector-delete" data-action="delete-idea" data-id="${esc(item.id)}">删除这张思想卡</button>`;
}
function relationRow(connection, kind, node) {
  if (!node) return "";
  const label = labels[connection.fromType][connection.relation] || connection.relation;
  return `<div class="relation-row"><button type="button" class="relation-main" data-action="select-${kind}" data-id="${esc(node.id)}"><span class="relation-type">${label}</span><strong data-user-content>${esc(truncate(node.title, 46))}</strong>${connection.note ? `<small data-user-content>${esc(truncate(connection.note, 90))}</small>` : ""}</button>${connection.sourceUrl ? `<a class="relation-source" href="${safeHref(connection.sourceUrl)}" aria-label="打开原文位置">↗</a>` : ""}<button type="button" class="relation-edit" data-action="edit-edge" data-id="${esc(connection.id)}" aria-label="编辑关系">···</button></div>`;
}
function citationRows(connections, nodeKey) {
  return connections.map((connection) => {
    const other = paper(connection[nodeKey]);
    const pdfUrl = connection.attachmentKey ? `zotero://open-pdf/library/items/${encodeURIComponent(connection.attachmentKey)}` : "";
    return `<div class="citation-row"><button type="button" class="relation-main" data-action="select-paper" data-id="${esc(other.id)}"><strong data-user-content>${esc(other.title)}</strong><small data-user-content>${esc([other.year, displayAuthors(other)].filter(Boolean).join(" · "))}</small></button><details><summary>查看引用依据</summary><p class="citation-evidence" data-user-content>${esc(connection.evidence || "")}</p>${pdfUrl ? `<a href="${safeHref(pdfUrl)}">打开引用论文 PDF ↗</a>` : ""}</details></div>`;
  }).join("");
}
function renderMapInspector(item) {
  const connections = validCitations();
  const references = connections.filter((connection) => connection.toId === item.id);
  const citing = connections.filter((connection) => connection.fromId === item.id);
  const status = paperReadStatus(item);
  const analysis = item.referenceAnalysis;
  const related = state.edges.filter((connection) => connection.fromType === "paper" && connection.toType !== "stage" && connection.fromId === item.id && idea(connection.toId));
  $("#inspector").innerHTML = `<button type="button" class="button quiet paper-inspector-close" data-action="close-paper-inspector" aria-label="关闭论文详情">关闭详情 ×</button><div class="inspector-top"><span class="eyebrow">PAPER MAP</span><span class="paper-read-badge ${status}">${paperReadLabel(item)}</span></div><h2 class="inspector-title" data-user-content>${esc(item.title)}</h2><p class="inspector-sub" data-user-content>${esc([displayAuthors(item), item.year].filter(Boolean).join(" · "))}</p>${fullAuthorsDetail(item)}<button type="button" class="button primary full" data-action="mark-paper" data-id="${esc(item.id)}" data-status="${status === "read" ? "unread" : "read"}">${status === "read" ? "标记为未读" : "标记为已读"}</button>${paperInstitution(item) ? `<p class="paper-institution" data-user-content>${esc(paperInstitution(item))}</p>` : ""}<div class="paper-bridge"><button type="button" class="button secondary full" data-action="paper-add-line" data-id="${esc(item.id)}">加入阅读线</button><button type="button" class="button quiet full" data-action="link-paper-to-idea">关联思想卡</button>${related.length ? related.map((connection) => `<button type="button" class="button quiet full" data-action="paper-view-idea" data-id="${esc(connection.toId)}">查看思想图 · <span data-user-content>${esc(idea(connection.toId).title)}</span></button>`).join("") : ""}</div>${item.zoteroUrl ? `<a class="button quiet full" href="${safeHref(item.zoteroUrl)}">在 Zotero 打开 ↗</a>` : ""}<div class="inspector-section"><h3>参考文献分析</h3><p class="analysis-status">${referenceStatus(item)}</p>${analysis?.message ? `<p class="field-help" data-user-content>${esc(analysis.message)}</p>` : ""}${item.zoteroMissing ? `<p class="field-help">Zotero 中已移除；保留阅读标注。</p>` : ""}<p class="field-help">仅连接库内已识别的引用；没有连线不代表没有引用。</p></div><div class="inspector-section"><h3>引用的论文 <span>${references.length}</span></h3><p class="field-help">这些论文 → 当前论文</p>${references.length ? citationRows(references, "fromId") : `<p class="empty-small">尚未识别库内引用。</p>`}</div><div class="inspector-section"><h3>引用它的论文 <span>${citing.length}</span></h3><p class="field-help">当前论文 → 这些论文</p>${citing.length ? citationRows(citing, "toId") : `<p class="empty-small">尚未识别库内被引。</p>`}</div>`;
}
function renderLegacyPaperInspector(item) {
  if (!item) return;
  if (["map", "recommendations"].includes(ui.view)) return renderMapInspector(item);
  const related = state.edges.filter((connection) => connection.fromType === "paper" && connection.toType !== "stage" && connection.fromId === item.id);
  const annotations = ui.annotationPaperId === item.id ? ui.annotations : null;
  $("#inspector").innerHTML = `<div class="inspector-top"><span class="eyebrow">PAPER SOURCE</span><span class="paper-tag">论文</span></div><h2 class="inspector-title" data-user-content>${esc(item.title)}</h2><p class="inspector-sub" ${item.authors || item.year ? "data-user-content" : ""}>${esc([displayAuthors(item), item.year].filter(Boolean).join(" · ") || "手动添加")}</p>
    ${fullAuthorsDetail(item)}${paperInstitution(item) ? `<p class="paper-institution" data-user-content>${esc(paperInstitution(item))}</p>` : ""}<div class="paper-meta">${item.doi ? `<div><span>DOI</span><strong data-user-content>${esc(item.doi)}</strong></div>` : ""}${item.zoteroKey ? `<div><span>ZOTERO KEY</span><strong data-user-content>${esc(item.zoteroKey)}</strong></div>` : ""}</div>
    ${item.zoteroUrl ? `<a class="button primary full" href="${safeHref(item.zoteroUrl)}">在 Zotero 打开 ↗</a>` : ""}
    <div class="inspector-section"><div class="inspector-section-head"><h3>蕴含的思想 <span>${related.length}</span></h3><div><button type="button" data-action="new-idea-from-paper" aria-label="从论文创建思想卡">新建</button><button type="button" data-action="link-paper-to-idea" aria-label="关联已有思想卡">＋</button></div></div>${related.length ? related.map((connection) => relationRow(connection, "idea", idea(connection.toId))).join("") : `<p class="empty-small">把这篇论文连到已有思想，或从批注建一张新卡。</p>`}</div>
    <button type="button" class="button danger full inspector-delete" data-action="delete-paper" data-id="${esc(item.id)}">删除这篇论文</button>
    ${item.zoteroKey ? `<div class="inspector-section last"><div class="inspector-section-head"><h3>Zotero 批注</h3><button type="button" data-action="load-annotations">读取</button></div>${annotations === null ? `<p class="empty-small">读取划线与批注，再从原文建卡。</p>` : annotations.length ? annotations.map((annotation, index) => `<div class="annotation"><span>第 ${esc(annotation.page || "?")} 页</span><p data-user-content>${esc(truncate(annotation.text || annotation.comment, 200))}</p>${annotation.comment && annotation.text ? `<small data-user-content>${esc(truncate(annotation.comment, 120))}</small>` : ""}<div class="annotation-actions"><button type="button" data-action="annotation-link" data-index="${index}">关联已有卡</button><button type="button" data-action="annotation-create" data-index="${index}">建新卡 ↗</button></div></div>`).join("") : `<p class="empty-small">没有找到文字批注。</p>`}</div>` : ""}`;
}

function openLineDialog(edit = false) {
  const current = edit ? line(ui.selectedLineId) : null;
  $("#line-dialog-title").textContent = edit ? "编辑阅读线" : "新建阅读线";
  $("#delete-line-button").hidden = !current;
  $("#line-id").value = current?.id || "";
  $("#line-title").value = current?.title || "";
  $("#line-question").value = current?.question || "";
  $("#line-kind").value = current?.kind || "model_family";
  $("#line-kind").disabled = Boolean(current);
  const saved = readDraft(current ? `line:${current.id}` : "line-new");
  if (saved) { $("#line-title").value = saved.title || ""; $("#line-question").value = saved.question || ""; if (!current) $("#line-kind").value = saved.kind || "model_family"; }
  openDialog("#line-dialog");
  $("#line-title").focus();
}
function ideaKind() {
  return document.querySelector('input[name="idea-kind"]:checked')?.value || "concept";
}
function setIdeaKind(value) {
  document.querySelectorAll('input[name="idea-kind"]').forEach((input) => { input.checked = input.value === value; });
}
function openIdeaDialog(source = null, parentId = "") {
  ui.pendingSource = source;
  ui.pendingParentId = parentId;
  $("#idea-title").value = "";
  $("#idea-aliases").value = "";
  setIdeaKind("concept");
  $("#idea-summary").value = "";
  $("#idea-entity-type").value = "concept";
  $("#idea-line").innerHTML = options(state.lines.filter((item) => { return item.kind !== "model_family"; }), ui.selectedLineId, "暂不加入阅读线");
  $("#idea-source-context").hidden = !source;
  $("#idea-source-relation-wrap").hidden = !source;
  $("#idea-parent-context").hidden = !parentId;
  if (parentId) $("#idea-parent-context").innerHTML = `<span>引申自</span> <strong data-user-content>${esc(idea(parentId)?.title)}</strong><p>创建后会自动连线，也可以选择下方已有的思想卡。</p>`;
  if (source) {
    const target = paper(source.paperId);
    $("#idea-source-context").textContent = `来源：${target?.title || "论文"}${source.page ? ` · 第 ${source.page} 页` : ""}${source.text ? ` · ${truncate(source.text, 110)}` : ""}`;
    $("#idea-source-relation").value = "uses";
  }
  if (!source && !parentId) {
    const saved = readDraft("idea-new");
    if (saved) { $("#idea-title").value = saved.title || ""; $("#idea-aliases").value = saved.aliases || ""; $("#idea-summary").value = saved.summary || ""; $("#idea-entity-type").value = saved.entityType || "concept"; $("#idea-line").value = saved.lineId || ""; setIdeaKind(saved.kind || "concept"); }
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
  $("#relation-target-label").hidden = false;
  $("#relation-target").required = true;
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
  $("#relation-create-fields").hidden = false;
  $("#relation-mode-wrap").hidden = true;
  $("#relation-target-label").hidden = true;
  $("#relation-target").required = false;
  relationOptions(item.fromType === "paper" ? "paper" : "idea");
  $("#relation-type").value = item.relation;
  const source = item.fromType === "paper" ? paper(item.fromId) : idea(item.fromId);
  const target = idea(item.toId);
  $("#relation-context").textContent = `${source?.title || ""} → ${target?.title || ""}`;
  $("#relation-note").value = item.note || "";
  $("#relation-source-url").value = item.sourceUrl || "";
  openDialog("#relation-dialog");
}
function fillWebdavFields(info) {
  $("#webdav-enabled").checked = Boolean(info?.enabled);
  $("#webdav-url").value = info?.url || "";
  $("#webdav-username").value = info?.username || "";
  $("#webdav-password").value = "";
  $("#webdav-folder").value = info?.folder || "PaperLine";
}
async function openSettings() {
  $("#vault-path").value = state.settings.vaultPath || "";
  $("#language").value = language();
  $("#reminder-time").value = state.settings.reminderTime || "";
  fillWebdavFields(ui.webdav);
  showWebdav(ui.webdav);
  openDialog("#settings-dialog");
  showCloudCompare(null);
  await refreshWebdav();
  if (!$("#webdav-url").value) fillWebdavFields(ui.webdav);
  if (ui.webdav?.url) api("/api/webdav/cloud").then(showCloudCompare).catch(() => {});
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
  writeDraft(sessionDraftKey(ui.session), {
    elapsed: sessionSeconds(), note: $("#session-note").value, nextQuestion: $("#session-next-question").value,
  });
}
function stopTimer(discard = false) {
  if (ui.session) {
    if (discard) forgetDraft(sessionDraftKey(ui.session));
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
  const source = state.edges.find((item) => item.fromType === "paper" && item.toType !== "stage" && item.toId === target.id);
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
    $("#zotero-results").innerHTML = result.items.length ? result.items.map((item, index) => `<div class="zotero-result"><div><strong data-user-content>${esc(item.title)}</strong><small ${item.authors || item.year ? "data-user-content" : ""}>${esc([displayAuthors(item), item.year].filter(Boolean).join(" · ") || "Zotero 条目")}</small></div><button type="button" class="button quiet" data-action="import-zotero" data-index="${index}">导入</button></div>`).join("") : `<p class="field-help">没有找到符合条件的条目。</p>`;
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
    if (action === "page-zoom") setPageZoom(Number(button.dataset.step) ? ui.pageZoom + Number(button.dataset.step) : 1);
    else if (action.startsWith("view-")) { switchWorkspaceView(action.slice(5)); }
    else if (action === "sync-zotero-library") await startZoteroSync();
    else if (action === "mark-paper") await markPaper(id, button.dataset.status);
    else if (action === "recommendation-filter") { ui.recommendationAll = button.dataset.all === "true"; renderRecommendations(); }
    else if (action === "map-connections") { if (ui.mapSort === "year") ui.mapTimelineConnections = !ui.mapTimelineConnections; else ui.mapAllConnections = !ui.mapAllConnections; renderPaperMapResults(); }
    else if (action === "paper-add-line") openPaperLineDialog(id);
    else if (action === "paper-view-idea") { ui.view = "graph"; selectIdea(id); }
    else if (action === "filter-paper-read") { ui.mapStatus = button.dataset.status; renderPaperMap(); localize($("#main-view")); }
    else if (action === "map-fit") {
      const scroller = $(".paper-map-scroll"), svg = scroller?.querySelector("svg");
      if (svg) { const box = svg.viewBox.baseVal; zoomGraph(scroller, Math.min(1, scroller.clientWidth / box.width, scroller.clientHeight / box.height)); }
    }
    else if (action === "map-zoom" || action === "idea-zoom") {
      const map = action === "map-zoom", previous = map ? ui.mapZoom : ui.ideaGraphZoom;
      zoomGraph($(map ? ".paper-map-scroll" : ".graph-scroll"), Number(button.dataset.step) ? previous + Number(button.dataset.step) : 1);
    }
    else if (action === "select-line") { ui.selectedLineId = id; ui.view = "outline"; render(); }
    else if (action === "select-idea") selectIdea(id);
    else if (action === "select-paper") updatePaperSelection(id);
    else if (action === "map-overview") updatePaperSelection("");
    else if (action === "close-paper-inspector") { ui.inspectorOpen = false; syncInspectorLayout(); }
    else if (action === "search-open") {
      const kind = button.dataset.kind;
      if (kind === "idea") selectIdea(id);
      else if (kind === "line") {
        ui.selectedLineId = id;
        ui.selectedIdeaId = line(id)?.activeIdeaId || line(id)?.ideaIds[0] || "";
        ui.selectedPaperId = "";
        ui.view = "graph";
        render();
      } else {
        ui.selectedPaperId = id;
        ui.selectedIdeaId = "";
        ui.view = "papers";
        render();
      }
    }
    else if (action === "filter-status") { ui.ideaStatus = button.dataset.status || ""; markMainAnimation(false); renderIdeas(); localize($("#main-view")); }
    else if (action === "delete-idea") {
      if (!await confirmAction(tr("删除这张思想卡？它的关系会移除，阅读记录保留为历史；下次导出时，关联笔记将移至 Obsidian 库的 .trash/PaperLine，可恢复。"))) return;
      ui.selectedIdeaId = "";
      await act("idea.delete", { id });
      toast("思想卡已删除。");
    }
    else if (action === "delete-paper") {
      if (!await confirmAction(tr("删除这篇论文？它与思想卡的关系会一并删除，思想卡本身保留。"))) return;
      ui.selectedPaperId = "";
      await act("paper.delete", { id });
      toast("论文已删除。");
    }
    else if (action === "delete-line") {
      const current = line(ui.selectedLineId);
      if (!current || !await confirmAction(tr("删除这条阅读线？思想卡、论文和阅读记录都会保留。"))) return;
      ui.selectedLineId = "";
      await act("line.delete", { id: current.id });
      closeDialog($("#line-dialog"));
      toast("阅读线已删除。");
    }
    else if (action === "new-line") openLineDialog();
    else if (action === "edit-line") openLineDialog(true);
    else if (action === "new-idea") openIdeaDialog();
    else if (action === "derive-idea") openIdeaDialog(null, ui.selectedIdeaId);
    else if (action === "reuse-idea") await reuseIdea(id);
    else if (action === "new-idea-from-paper") openIdeaDialog({ paperId: ui.selectedPaperId });
    else if (action === "new-paper") openPaperDialog();
    else if (action === "link-paper") { if (idea(ui.selectedIdeaId)?.entityType === "method") openPaperPicker("method", ui.selectedIdeaId); else openRelation("paper", "idea"); }
    else if (action === "link-idea") openRelation("idea", "idea");
    else if (action === "link-paper-to-idea") openRelation("paper", "paper");
    else if (action === "edit-edge") editRelation(id);
    else if (action === "delete-edge") {
      if (!ui.editingEdgeId || !await confirmAction(tr("删除这条关系？思想卡和论文会保留。"))) return;
      await act("edge.delete", { id: ui.editingEdgeId });
      closeDialog($("#relation-dialog"));
      toast("关系已删除。");
    }
    else if (action === "search-zotero") await searchZotero();
    else if (action === "import-zotero") {
      const item = ui.zoteroResults[Number(button.dataset.index)];
      if (!item) return;
      ui.view = "papers";
      await act("paper.create", item);
      closeDialog($("#paper-dialog"));
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
    else if (action === "move-idea") {
      const current = line(ui.selectedLineId);
      if (!current) return;
      await act("line.move", { lineId: current.id, ideaId: id, offset: Number(button.dataset.offset) });
    }
    else if (action === "set-next") {
      const current = line(ui.selectedLineId);
      await act("line.update", { id: current.id, title: current.title, question: current.question, activeIdeaId: id });
      toast("已设为下一张卡。");
    }
    else if (action === "detach-idea") {
      const current = line(ui.selectedLineId);
      if (!await confirmAction(tr("将这张卡从当前阅读线移出？卡片及论文关联会保留。"))) return;
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
    else if (action === "expand-graph") { ui.graphExpanded = !ui.graphExpanded; markMainAnimation(false); renderMain(); localize($("#main-view")); centerGraph(); }
    else if (action === "open-settings") openSettings();
    else if (action === "open-help") openDialog("#help-dialog");
    else if (action === "webdav-restore") {
      toast("正在读取云端数据…");
      showWebdav(await postJson("/api/webdav/config", webdavPayload()));
      $("#webdav-password").value = "";
      const info = await api("/api/webdav/cloud");
      showCloudCompare(info);
      if (!info.cloud) { toast("云端还没有 PaperLine 备份。", true); return; }
      if (info.newer === "same") { toast("本机和云端的数据一致，无需恢复。"); return; }
      const question = [
        tr("用云端数据替换本机当前的数据？"),
        `${tr("云端：")}${stampText(info.cloud.savedAt)} · ${countsText(info.cloud.counts)}`,
        `${tr("本机：")}${stampText(info.local.savedAt)} · ${countsText(info.local.counts)}`,
        info.newer === "local" ? tr("本机的数据比云端新，恢复会用较旧的云端数据替换它。") : "",
        tr("当前数据会先另存一份。"),
      ].filter(Boolean).join("\n");
      if (!await confirmAction(question)) return;
      const data = await postJson("/api/webdav/restore", { expectSavedAt: info.cloud.savedAt || "" });
      state = data.state;
      Object.assign(ui, { selectedLineId: "", selectedIdeaId: "", selectedPaperId: "", view: "graph" });
      closeDialog($("#settings-dialog"));
      render();
      await refreshWebdav();
      toast(`已从云端恢复。原来的数据另存为 ${data.result.kept}。`);
    }
    else if (action === "choose-vault") {
      const path = await globalThis.PaperLineDesktop?.chooseDirectory?.();
      if (path) $("#vault-path").value = path;
    }
    else if (action === "export-migration") {
      if (ui.session) checkpointSession();
      const backup = await api("/api/backup");
      const saved = await globalThis.PaperLineDesktop.saveJson(globalThis.PaperLineDesktop.migration(backup), "paperline-desktop-migration.json");
      if (saved) toast("迁移包已导出，包含数据和有效草稿。");
    }
    else if (action === "restore-backup") { $("#restore-file").value = ""; $("#restore-file").click(); }
    else if (action === "webdav-test") {
      toast("正在测试 WebDAV 连接…");
      const result = await postJson("/api/webdav/test", webdavPayload());
      toast(result.insecure ? "WebDAV 连接正常，但 http 地址会明文传输密码。" : "WebDAV 连接正常。");
    }
    else if (action === "webdav-sync") {
      toast("正在上传到 WebDAV…");
      showWebdav(await postJson("/api/webdav/config", webdavPayload()));
      $("#webdav-password").value = "";
      try {
        showWebdav(await postJson("/api/webdav/sync", {}));
      } catch (error) {
        if (!error.conflict) throw error;
        await refreshWebdav();
        if (!await confirmAction(tr("云端的数据比本机新。仍然用本机数据覆盖云端吗？云端那份会先存进 history 文件夹。"))) { toast(error.message, true); return; }
        showWebdav(await postJson("/api/webdav/sync", { force: true }));
      }
      api("/api/webdav/cloud").then(showCloudCompare).catch(() => {});
      toast("已上传到 WebDAV。");
    }
    else if (action === "request-notification") {
      if (!("Notification" in window)) { toast("当前浏览器不支持桌面通知；站内提醒仍可使用。", true); return; }
      const permission = await Notification.requestPermission();
      toast(permission === "granted" ? "浏览器通知已开启。" : "浏览器通知未开启；站内提醒仍可使用。", permission !== "granted");
    }
    else if (action === "export") {
      if (!state.settings.vaultPath) { openSettings(); toast("先设置 Obsidian 库路径。"); return; }
      const result = await api("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      toast(`已导出 ${result.count} 篇笔记到 Obsidian，${result.skipped || 0} 篇无变化，${result.removed || 0} 篇已移至 .trash/PaperLine。`);
    }
    else if (action === "close-dialog") closeDialog(button.closest("dialog"));
  } catch (error) { toast(error.message, true); }
});

document.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches(".timeline-node")) { event.preventDefault(); event.target.dispatchEvent(new Event("click", { bubbles: true })); return; }
  if ((event.key === "Enter" || event.key === " ") && event.target.matches(".graph-node, .map-node")) {
    event.preventDefault(); event.target.click();
  }
});
const viewKeys = { 1: "graph", 2: "outline", 3: "ideas", 4: "papers", 5: "map" };
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || !state) return;
  if (document.querySelector("dialog[open]")) return;
  if (event.target?.matches?.("input, textarea, select, [contenteditable='true']")) return;
  const view = viewKeys[event.key];
  if (view) { event.preventDefault(); switchWorkspaceView(view); return; }
  if (event.key === "n") { event.preventDefault(); openIdeaDialog(); }
  else if (event.key === "p") { event.preventDefault(); openPaperDialog(); }
  else if (event.key === "l") { event.preventDefault(); openLineDialog(); }
  else if (event.key === "s") { event.preventDefault(); const current = line(ui.selectedLineId); if (current?.kind === "model_family") openStageSession(current.stageIds?.includes(ui.selectedStageId) ? ui.selectedStageId : current.activeStageId || current.stageIds?.[0]); else openSession(ui.selectedIdeaId); }
  else if (event.key === "/") { event.preventDefault(); ui.view = "ideas"; render(); $("#idea-search")?.focus(); }
  else if (event.key === "?" || event.key === "h") { event.preventDefault(); openDialog("#help-dialog"); }
});
document.addEventListener("input", (event) => {
  if (event.target.form?.id === "idea-edit-form" && !["kind", "status"].includes(event.target.name)) captureIdeaDraft(event.target.form);
  if (["session-note", "session-next-question"].includes(event.target.id)) checkpointSession();
  if (event.target.id === "idea-search") { ui.ideaQuery = event.target.value; renderSearchResults(); }
  if (event.target.id === "map-search") { ui.mapQuery = event.target.value; renderPaperMapResults(); }
  if (event.target.id === "paper-search") { ui.paperQuery = event.target.value; renderPaperResults(); }
  if (["idea-title", "idea-aliases"].includes(event.target.id)) scheduleIdeaMatches();
});
document.addEventListener("change", (event) => {
  if (event.target.id === "map-sort") { ui.mapSort = event.target.value === "year" ? "year" : "citations"; renderPaperMapResults(); const scroller = $(".paper-map-scroll"); if (scroller) { scroller.scrollTop = 0; scroller.scrollLeft = 0; } return; }
  const form = event.target.form;
  if (form?.id !== "idea-edit-form") return;
  // 类型和状态点一次就写入；正文仍然是草稿，等“保存卡片”。
  if (["kind", "status"].includes(event.target.name)) markIdea(form.dataset.id, event.target.name, event.target.value);
  else captureIdeaDraft(form);
});
window.addEventListener("pagehide", () => stopTimer());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshState().catch(() => {}); });
window.addEventListener("focus", () => { refreshState().catch(() => {}); });
$("#zotero-query").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); searchZotero(); } });
$("#relation-mode").addEventListener("change", relationTargets);
$("#restore-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > 20_000_000) throw new Error("备份文件太大，无法恢复。");
    let backup;
    try { backup = JSON.parse(await file.text()); } catch { throw new Error("这不是可以恢复的 PaperLine 备份文件。"); }
    const packageData = globalThis.PaperLineDesktop?.unpack(backup) || { backup, drafts: null };
    backup = packageData.backup;
    const count = (key) => (Array.isArray(backup?.[key]) ? backup[key].length : 0);
    const question = tr(`用这份备份替换当前数据？备份里有 ${count("lines")} 条阅读线、${count("ideas")} 张思想卡、${count("papers")} 篇论文。当前数据会先另存一份。`) + (packageData.drafts !== null ? "\n" + tr(`将恢复 ${Object.keys(packageData.drafts).length} 份有效草稿，并替换本机草稿。`) : "");
    if (!await confirmAction(tr(question))) return;
    const data = await postJson("/api/restore", { backup });
    stopTimer();
    closeDialog($("#session-dialog"));
    state = data.state;
    let draftsFailed = false;
    if (packageData.drafts !== null) {
      draftCache.clear();
      try { globalThis.PaperLineDesktop.installDrafts(packageData.drafts, state); }
      catch { draftsFailed = true; }
    }
    Object.assign(ui, { selectedLineId: "", selectedIdeaId: "", selectedPaperId: "", view: "graph" });
    closeDialog($("#settings-dialog"));
    render();
    noteLocalChange();
    if (draftsFailed) toast("数据已恢复，但草稿存储不可用。请保留迁移包并重试。", true);
    else toast(`已从备份恢复。原来的数据另存为 ${data.result.kept}。`);
  } catch (error) { toast(error.message, true); }
});
document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("close", () => { if (dialog.id === "session-dialog" && !dialog.open) stopTimer(); }));
$("#session-dialog").addEventListener("cancel", (event) => { if (ui.session?.saving) event.preventDefault(); });

$("#line-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const id = $("#line-id").value;
    const payload = { title: $("#line-title").value, question: $("#line-question").value, kind: $("#line-kind").value };
    if (id) { payload.id = id; payload.activeIdeaId = line(id)?.activeIdeaId || ""; }
    const draftKey = id ? `line:${id}` : "line-new", snapshot = JSON.stringify(readDraft(draftKey));
    await act(id ? "line.update" : "line.create", payload);
    if (JSON.stringify(readDraft(draftKey)) === snapshot) forgetDraft(draftKey);
    ui.view = "outline"; render();
    closeDialog($("#line-dialog"));
    toast(id ? "阅读线已更新。" : "阅读线已创建。");
  } catch (error) { toast(error.message, true); }
});
$("#idea-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = {
      title: $("#idea-title").value, kind: ideaKind(), entityType: $("#idea-entity-type").value,
      summary: $("#idea-summary").value, lineId: $("#idea-line").value,
      aliases: $("#idea-aliases").value, ...ideaSourcePayload(),
    };
    ui.view = "graph";
    const snapshot = JSON.stringify(readDraft("idea-new"));
    await act("idea.create", payload);
    if (JSON.stringify(readDraft("idea-new")) === snapshot) forgetDraft("idea-new");
    closeDialog($("#idea-dialog"));
    toast("思想卡已创建。");
  } catch (error) { toast(error.message, true); }
});
$("#paper-line-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = { id: $("#paper-line-paper").value, lineId: $("#paper-line-choice").value };
    if (!payload.lineId) { toast("请先创建阅读线。", true); return; }
    if ($("#paper-line-idea").value) payload.ideaId = $("#paper-line-idea").value;
    await act("paper.add_to_line", payload);
    closeDialog($("#paper-line-dialog"));
    toast("已加入阅读线。");
  } catch (error) { toast(error.message, true); }
});
$("#paper-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    ui.view = "papers";
    await act("paper.create", { title: $("#paper-title").value, authors: $("#paper-authors").value, year: $("#paper-year").value, doi: $("#paper-doi").value });
    closeDialog($("#paper-dialog"));
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
      await act("edge.update", { id: ui.editingEdgeId, relation: $("#relation-type").value, note: $("#relation-note").value, sourceUrl: $("#relation-source-url").value });
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
    await act("session.create", { lineId: session.lineId, ...(session.targetType ? { targetType: session.targetType, targetId: session.targetId } : { ideaId: session.ideaId }), note: $("#session-note").value, nextQuestion: $("#session-next-question").value, durationSeconds: elapsed });
    stopTimer(true);
    closeDialog($("#session-dialog"));
    toast("本次阅读已记录。下次可以从这里继续。");
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
    showWebdav(await postJson("/api/webdav/config", webdavPayload()));
    closeDialog($("#settings-dialog"));
    toast("设置已保存。");
    checkReminder();
  } catch (error) { toast(error.message, true); }
});
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "idea-edit-form") return;
  event.preventDefault();
  try {
    const id = event.target.dataset.id;
    const form = new FormData(event.target);
    const draft = readDraft(`idea:${id}`);
    const baseUpdatedAt = draft?.baseUpdatedAt ?? idea(id)?.updatedAt ?? "";
    await act("idea.update", { id, ...Object.fromEntries(form.entries()), baseUpdatedAt });
    toast("卡片已保存。");
  } catch (error) {
    if (/别的页面改过/.test(error.message)) await acceptNewerCard(event.target.dataset.id);
    toast(error.message, true);
  }
});

// Methods and model-family stages share papers without changing citation-map layout.
function switchWorkspaceView(view) {
  if (ui.view === "map") { const scroll = $(".paper-map-scroll"); if (scroll) ui.mapViewport = { left: scroll.scrollLeft, top: scroll.scrollTop }; }
  ui.view = view; render();
}
function stages() { return state.stages || []; }
function stage(id) { return stages().find((item) => item.id === id); }
function methods() { return state.ideas.filter((item) => item.entityType === "method"); }
function paperRelationRank(relation) { return ({ proposes: 0, improves: 1, uses: 2, questions: 3 })[relation] ?? 4; }
function comparePaperRelations(a, b) { return paperRelationRank(a.relation) - paperRelationRank(b.relation); }
function paperRoleClass(relation) { return paperRelationRank(relation) < 3 ? `paper-role-${relation}` : ""; }
function paperRelationLegend() {
  return `<div class="paper-relation-legend" aria-label="${tr("论文与方法关系")}">${["proposes", "improves", "uses"].map((relation) => `<span class="${paperRoleClass(relation)}"><i></i>${tr(labels.paper[relation])}</span>`).join("")}</div>`;
}
function paperIdeaEdges(paperId) { return state.edges.filter((item) => item.fromType === "paper" && item.toType !== "stage" && item.fromId === paperId && idea(item.toId)).sort(comparePaperRelations); }
function stagePaperEdges(stageId) { return state.edges.filter((item) => item.fromType === "paper" && item.toType === "stage" && item.toId === stageId && paper(item.fromId)); }
function draftValues(key, saved = {}) { return { ...saved, ...(readDraft(key) || {}) }; }
function workspaceDraft(form) {
  const key = form.dataset.workspaceDraft;
  if (key) writeDraft(key, Object.fromEntries(new FormData(form).entries()));
}
function sessionDraftKey(session) { return session.targetType ? `session:${session.targetType}:${session.targetId}:${session.lineId || ""}` : `session:${session.lineId}:${session.ideaId}`; }
function methodChoices(query = "") {
  const needle = normalized(query);
  return methods().filter((item) => !needle || normalized([item.title, ...(item.aliases || [])].join(" ")).includes(needle));
}
function methodEditor(item) {
  const edit = draftValues(`idea:${item.id}`, { ...item, entityType: item.entityType || "unclassified", aliases: (item.aliases || []).join(", ") });
  return `<form id="idea-edit-form" class="detail-form method-editor" data-id="${esc(item.id)}"><h3>编辑方法与笔记</h3><label>名称<input name="title" maxlength="120" value="${esc(edit.title)}" required></label><label>别名<input name="aliases" maxlength="1500" value="${esc(edit.aliases)}"></label><label>内容分类<select name="entityType">${[["method","方法"],["concept","概念"],["question","问题"],["unclassified","尚未分类"]].map(([value,label]) => `<option value="${value}" ${edit.entityType === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><div class="choice-grid">${choiceField("kind", "类型", labels.kind, edit.kind, item.id)}${choiceField("status", "理解状态", labels.status, edit.status, item.id)}</div><label>方法定义<textarea name="summary" maxlength="4000" rows="3">${esc(edit.summary)}</textarea></label><label>核心机制<textarea name="mechanism" maxlength="6000" rows="3">${esc(edit.mechanism)}</textarea></label><label>我的思考<textarea name="thoughts" maxlength="6000" rows="3">${esc(edit.thoughts)}</textarea></label><p id="idea-draft-status" class="field-help" ${readDraft(`idea:${item.id}`) ? "" : "hidden"}>草稿已保留，点击保存卡片可写入笔记。</p><button type="submit" class="button primary">保存方法与笔记</button></form>`;
}
function directEdgeControls(connection) {
  return `<div class="direct-relations">${["proposes", "improves", "uses"].map((relation) => `<button type="button" class="button quiet" data-workspace-action="edge-relation" data-id="${esc(connection.id)}" data-relation="${relation}" aria-pressed="${connection.relation === relation}">${labels.paper[relation]}</button>`).join("")}${connection.relation === "questions" ? `<span class="status-pill">质疑</span>` : ""}</div>`;
}
function editableEdge(connection, showPaper = false) {
  const target = idea(connection.toId), source = paper(connection.fromId), key = `edge:${connection.id}`, edit = draftValues(key, connection);
  if (!target || !source) return "";
  return `<div class="editable-edge ${paperRoleClass(connection.relation)}"><div class="inspector-section-head"><button type="button" class="text-action" data-action="${showPaper ? "select-paper" : "paper-view-idea"}" data-id="${esc(showPaper ? source.id : target.id)}"><span data-user-content>${esc(showPaper ? source.title : target.title)}</span></button><button type="button" class="mini-action" data-action="edit-edge" data-id="${esc(connection.id)}">编辑关系</button></div>${directEdgeControls(connection)}<p class="field-help" data-user-content>${esc(connection.note || "")}</p><details class="relation-evidence"><summary>编辑依据与原文位置</summary><form class="workspace-form" data-workspace-form="edge" data-workspace-draft="${esc(key)}" data-id="${esc(connection.id)}"><label>关系依据<textarea name="note" maxlength="3000" rows="2">${esc(edit.note || "")}</textarea></label><label>原文位置链接<input name="sourceUrl" maxlength="1500" value="${esc(edit.sourceUrl || "")}" placeholder="zotero://open-pdf/…"></label><button type="submit" class="button quiet">保存关系依据</button></form></details></div>`;
}
function fitMethodGraph(all = false) {
  const scroll = $(".graph-scroll"), svg = scroll?.querySelector?.("svg");
  if (!svg || !scroll.clientWidth) return;
  const box = svg.viewBox.baseVal;
  const availableHeight = window.innerHeight ? Math.min(720, window.innerHeight * .65) : box.height;
  zoomGraph(scroll, Math.min(1, scroll.clientWidth / box.width, all ? availableHeight / box.height : 1));
}
function renderMethodsWorkspace() {
  const choices = methodChoices(ui.methodQuery);
  let selected = idea(ui.selectedIdeaId);
  if (!selected) { selected = choices[0]; if (selected) ui.selectedIdeaId = selected.id; }
  const header = pageHeader("METHODS / 思想图", "共享方法，连接不同论文", "同一个方法可被不同论文提出、使用或改进；这些关系独立于引用与阅读顺序。", `<button type="button" class="button primary" data-workspace-action="new-method">＋ 新建方法</button>${selected ? `<button type="button" class="button secondary" data-workspace-action="edit-method">编辑当前方法</button>` : ""}<button type="button" class="button secondary" data-action="new-paper">＋ 添加论文</button>`, false);
  $("#main-view").innerHTML = header + `<label class="idea-search-label">搜索方法名称或别名<input id="method-search" type="search" value="${esc(ui.methodQuery)}" placeholder="例如：GRPO"></label><div id="method-results" class="card-tabs">${choices.map((item) => `<button type="button" class="card-tab ${selected?.id === item.id ? "active" : ""}" data-action="paper-view-idea" data-id="${esc(item.id)}" data-user-content>${esc(item.title)}</button>`).join("")}</div>` + (selected ? `${selected.entityType !== "method" ? `<p class="workspace-note">${!state.lines.some((path) => path.ideaIds.includes(selected.id)) ? tr("这张思想卡还没有加入阅读线。") : ""}${tr("这张旧卡尚未明确分类为方法。可在下方修改内容分类；旧笔记与关系保留。")}</p>` : ""}${graphMarkup(selected)}<section class="method-relations"><h2>论文与此方法的关系</h2>${state.edges.filter((item) => item.fromType === "paper" && item.toType !== "stage" && item.toId === selected.id).sort(comparePaperRelations).map((item) => editableEdge(item, true)).join("") || `<p class="field-help">还没有关联论文。选中右侧论文，直接添加已有方法或新方法。</p>`}</section>${methodEditor(selected)}` : `<div class="empty-main compact"><h2>还没有明确分类的方法</h2><p>新建共享方法，或从搜索中打开旧卡并手动确认分类。旧卡不会自动改成方法。</p><button type="button" class="button primary" data-workspace-action="new-method">新建方法</button></div>`);  if (selected && ui.methodFitId !== selected.id) {
    fitMethodGraph();
    if ($(".graph-scroll")?.clientWidth) ui.methodFitId = selected.id;
  }
}
let contributionQueue = Promise.resolve();
function queueContributionAction(operation) {
  const next = contributionQueue.catch(() => {}).then(operation);
  contributionQueue = next;
  return next;
}
function removeStageContribution(membershipId, relationshipId) {
  return queueContributionAction(() => {
    const membership = edge(membershipId);
    if (!membership) throw new Error("阶段成员已变化，请重新选择阶段。");
    return act("edge.update", { id: membershipId, contributionRefs: (membership.contributionRefs || []).filter((ref) => ref !== relationshipId) });
  });
}
function stageContributions(stageId) {
  return stagePaperEdges(stageId).flatMap((membership) => (membership.contributionRefs || []).flatMap((id) => {
    const connection = edge(id);
    return connection?.fromType === "paper" && connection.toType !== "stage" && connection.fromId === membership.fromId && idea(connection.toId)?.entityType === "method" ? [{ membership, connection }] : [];
  })).sort((a, b) => comparePaperRelations(a.connection, b.connection));
}
function timelineLayout(current) {
  const ordered = (current.stageIds || []).map(stage).filter(Boolean);
  const contributions = ordered.flatMap((item) => stageContributions(item.id));
  const methodIds = [...new Set(contributions.map(({ connection }) => connection.toId))];
  const methodInstances = ordered.flatMap((item) => [...new Set(stageContributions(item.id).map(({ connection }) => connection.toId))].map((methodId) => ({ stageId: item.id, methodId })));
  const rows = Math.max(1, ...ordered.map((item) => Math.max(stagePaperEdges(item.id).length, methodInstances.filter((instance) => instance.stageId === item.id).length)));
  return { stages: ordered, methodIds, methodInstances, contributions, width: Math.max(760, ordered.length * 460 + 40), height: 252 + rows * 108 };
}
function rememberTimelineViewport() {
  const scroll = $(".timeline-scroll");
  if (!scroll?.dataset?.lineId) return;
  ui.timelineViews ||= {};
  ui.timelineViews[scroll.dataset.lineId] = { zoom: ui.timelineZoom || 1, left: scroll.scrollLeft, top: scroll.scrollTop };
}
function restoreTimelineViewport() {
  const scroll = $(".timeline-scroll"), saved = ui.timelineViews?.[scroll?.dataset?.lineId];
  if (scroll && saved) { scroll.scrollLeft = saved.left; scroll.scrollTop = saved.top; }
}
function timelineLabel(value, width, font = 13) {
  const text = String(value || ""); let used = 0, result = "";
  for (const char of text) { const size = char.charCodeAt(0) > 255 ? font : font * .55; if (used + size > width - 14) return result + "…"; used += size; result += char; }
  return result;
}
function timelineNode({ x, y, width = 240, height = 72, title, subtitle = "", action, id, paperId = "", selected = false, kind, detail = "", relation = "" }) {
  return `<g class="timeline-node ${kind} ${paperRoleClass(relation)} ${selected ? "selected" : ""}" role="button" tabindex="0" aria-label="${esc(title)}" aria-pressed="${selected}" data-workspace-action="${action}" data-id="${esc(id)}" ${paperId ? `data-paper-id="${esc(paperId)}"` : ""}><title data-user-content>${esc(title)}${detail ? " · " + esc(detail) : ""}</title><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="13"/><text x="${x + 14}" y="${y + 28}" class="timeline-node-title" data-user-content>${esc(timelineLabel(title, width - 28))}</text><text x="${x + 14}" y="${y + 50}" class="timeline-node-subtitle" data-user-content>${esc(timelineLabel(subtitle, width - 28, 11))}</text></g>`;
}
function renderStageLine(current) {
  if (!ui.newStage && !(current.stageIds || []).includes(ui.selectedStageId)) ui.stageInspect = false;
  const layout = timelineLayout(current), { width, height } = layout;
  ui.timelineZoom = ui.timelineViews?.[current.id]?.zoom || 1;
  const paperPositions = new Map(), methodPositions = new Map();
  let route = "", branches = "", nodes = "", methodsMarkup = "";
  layout.stages.forEach((item, index) => {
    const x = 30 + index * 460, memberships = stagePaperEdges(item.id), refs = stageContributions(item.id);
    const localMethods = [...new Set(refs.map(({ connection }) => connection.toId))];
    if (index) route += `<path class="timeline-route" d="M ${x - 60} 107 H ${x - 8}" marker-end="url(#timeline-route-arrow)"/>`;
    nodes += `<text class="timeline-date" x="${x + 8}" y="42" data-user-content>${esc(item.date || tr("日期待补充"))}</text>`;
    nodes += timelineNode({ x, y: 70, width: 400, title: item.title, subtitle: `${index + 1} · ${tr("阶段顺序")}`, action: "select-stage", id: item.id, selected: ui.stageInspect && ui.selectedStageId === item.id, kind: "stage" });
    memberships.forEach((membership, row) => {
      const point = { x, y: 216 + row * 108 }; paperPositions.set(`${item.id}:${membership.fromId}`, point);
      branches += `<path class="timeline-membership" d="M ${x + 200} 142 V ${point.y - 15} H ${point.x + 90} V ${point.y}"/>`;
      nodes += timelineNode({ ...point, width: 180, title: paper(membership.fromId).title, subtitle: `${paper(membership.fromId).year || tr("年份未知")} · ${paperInstitution(paper(membership.fromId)) || tr("关联论文")}`, detail: [displayAuthors(paper(membership.fromId)), paperInstitution(paper(membership.fromId))].filter(Boolean).join(" · "), action: "timeline-paper", id: item.id, paperId: membership.fromId, selected: !ui.stageInspect && ui.selectedPaperId === membership.fromId, kind: "paper" });
    });
    localMethods.forEach((id, row) => {
      const point = { x: x + 230, y: 216 + row * 108 }; methodPositions.set(`${item.id}:${id}`, point);
      const relation = refs.find(({ connection }) => connection.toId === id).connection.relation;
      methodsMarkup += timelineNode({ ...point, width: 180, title: idea(id).title, subtitle: `${tr(labels.paper[relation])} · ${tr("共享方法 · 点击进入思想图")}`, action: "timeline-method", id, kind: "method", relation });
    });
    nodes += `<g class="timeline-node timeline-add" role="button" tabindex="0" aria-label="${tr("添加阶段论文")}" data-workspace-action="stage-papers" data-id="${esc(item.id)}"><text x="${x + 8}" y="185">${tr("＋ 论文")}</text></g><g class="timeline-node timeline-add" role="button" tabindex="0" aria-label="${tr("添加阶段方法")}" data-workspace-action="stage-methods" data-id="${esc(item.id)}"><text x="${x + 238}" y="185">${tr("＋ 方法")}${refs.length ? "" : ` · ${tr("未标注贡献")}`}</text></g>`;
  });
  const pairCounts = new Map();
  layout.contributions.forEach(({ membership, connection }) => {
    const point = paperPositions.get(`${membership.toId}:${membership.fromId}`), target = methodPositions.get(`${membership.toId}:${connection.toId}`);
    if (!point || !target) return;
    const x1 = point.x + 180, y1 = point.y + 36, x2 = target.x, y2 = target.y + 36;
    const key = `${membership.id}:${connection.toId}`, rank = pairCounts.get(key) || 0; pairCounts.set(key, rank + 1);
    branches += `<path class="timeline-contribution" d="M ${x1} ${y1} C ${x1 + 25} ${y1}, ${x2 - 25} ${y2}, ${x2} ${y2}" marker-end="url(#timeline-fact-arrow)"/><text class="timeline-verb" x="${x1 + 11}" y="${(y1 + y2) / 2 - 7 + rank * 14}">${labels.paper[connection.relation] || esc(connection.relation)}</text>`;
  });
  $("#main-view").innerHTML = pageHeader("MODEL FAMILY / 阅读线", current.title, "沿日期、论文与方法，理解每一步贡献。", `<button type="button" class="button primary" data-workspace-action="new-stage">＋ 阶段</button><button type="button" class="button secondary" data-action="edit-line">编辑阅读线</button><button type="button" class="button quiet" data-action="new-line">＋ 新建阅读线</button>`) + (current.question ? `<details class="timeline-goal"><summary>阅读目标</summary><p data-user-content>${esc(current.question)}</p></details>` : "") + `${paperRelationLegend()}<div class="timeline-controls"><p>${tr("沿主线阅读阶段，分支查看论文与明确标注的方法贡献。")}</p><div class="map-zoom"><button type="button" class="button quiet" data-workspace-action="fit-timeline">全图</button><button type="button" class="button quiet" data-workspace-action="timeline-zoom" data-step="-0.2" aria-label="缩小阅读线">−</button><button type="button" class="button quiet" data-workspace-action="timeline-zoom" data-step="0" id="timeline-zoom-percent" aria-label="重置阅读线缩放">${Math.round(ui.timelineZoom * 100)}%</button><button type="button" class="button quiet" data-workspace-action="timeline-zoom" data-step="0.2" aria-label="放大阅读线">＋</button></div></div>` + (layout.stages.length ? `<div class="timeline-scroll" data-line-id="${esc(current.id)}" tabindex="0" aria-label="模型演进阅读路线"><svg class="reading-timeline" width="${width * ui.timelineZoom}" height="${height * ui.timelineZoom}" viewBox="0 0 ${width} ${height}" role="group" aria-label="阶段按阅读顺序连接；关联论文通过明确动词连接共享方法"><defs><marker id="timeline-route-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#47755b"/></marker><marker id="timeline-fact-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7 Z" fill="#8b795b"/></marker></defs>${route}${branches}${nodes}${methodsMarkup}</svg></div><p class="map-footnote">${tr("阶段顺序不是模型继承关系；关联论文不自动等于模型首发论文。")} ${tr("同名方法在各阶段重复显示，点击进入同一个思想图实体。")} ${tr(graphZoomHint())}</p>` : `<div class="empty-main compact"><h2>这条阅读线还没有阶段</h2><p>先添加一个阶段，再搜索加入论文和明确的方法贡献。</p><button type="button" class="button primary" data-workspace-action="new-stage">＋ 阶段</button></div>`);
}

function selectTimelineStage(id, create = false) {
  ui.stageInspect = true; ui.newStage = create; ui.selectedStageId = create ? "" : id; ui.inspectorOpen = true;
  renderInspector(); localize($("#inspector"));
  document.querySelectorAll(".timeline-node.stage, .timeline-node.paper").forEach((node) => {
    const selected = !create && node.classList.contains("stage") && node.dataset.id === id;
    node.classList.toggle("selected", selected); node.setAttribute?.("aria-pressed", String(selected));
  });
}
function newStageEditor(current) {
  const key = `stage-new:${current.id}`, edit = draftValues(key);
  return `<section class="stage-panel"><h2>新增独立阶段</h2><form class="workspace-form" data-workspace-form="new-stage" data-workspace-draft="${esc(key)}" data-id="${esc(current.id)}"><label>阶段名称<input name="title" maxlength="120" value="${esc(edit.title || "")}" required></label><label>阶段日期<input name="date" type="date" value="${esc(edit.date || "")}"></label><label>本阶段贡献<textarea name="summary" maxlength="4000">${esc(edit.summary || "")}</textarea></label><button type="submit" class="button primary">新增阶段</button></form></section>`;
}
function stageEditor(item, current, index) {
  const key = `stage:${item.id}`, edit = draftValues(key, item), memberships = stagePaperEdges(item.id), refs = stageContributions(item.id);
  const methodPaper = memberships.some((member) => member.fromId === ui.stageMethodPaperId) ? paper(ui.stageMethodPaperId) : null;
  return `<section class="stage-panel"><div class="inspector-section-head"><span class="eyebrow">${index + 1} · ${tr("阶段顺序")}</span><div class="stage-actions"><button type="button" class="button quiet" data-workspace-action="move-stage" data-id="${esc(item.id)}" data-offset="-1" ${index === 0 ? "disabled" : ""}>上移</button><button type="button" class="button quiet" data-workspace-action="move-stage" data-id="${esc(item.id)}" data-offset="1" ${index === current.stageIds.length - 1 ? "disabled" : ""}>下移</button><button type="button" class="button quiet" data-workspace-action="detach-stage" data-id="${esc(item.id)}">移出本线</button></div></div><h2 data-user-content>${esc(item.title)}</h2><form class="workspace-form" data-workspace-form="stage" data-workspace-draft="${esc(key)}" data-id="${esc(item.id)}"><label>阶段名称<input name="title" maxlength="120" value="${esc(edit.title)}" required></label><label>阶段日期<input name="date" type="date" value="${esc(edit.date || "")}"></label><label>本阶段贡献<textarea name="summary" maxlength="4000" rows="3">${esc(edit.summary || "")}</textarea></label><button type="submit" class="button secondary">保存阶段</button></form><h3>阶段论文</h3>${memberships.map((membership) => `<div class="stage-paper-row"><button type="button" class="button quiet" data-action="select-paper" data-id="${esc(membership.fromId)}" data-user-content>${esc(paper(membership.fromId).title)}</button><button type="button" class="mini-action" data-workspace-action="remove-stage-paper" data-id="${esc(item.id)}" data-paper-id="${esc(membership.fromId)}">移出阶段</button></div>`).join("") || `<p class="field-help">此阶段还没有论文，可以直接添加。</p>`}<button type="button" class="button secondary" data-workspace-action="stage-papers" data-id="${esc(item.id)}">＋ 论文</button><h3>明确标注的方法贡献</h3>${refs.map(({ membership, connection }) => `<div class="stage-contribution-row"><button type="button" class="button quiet" data-workspace-action="timeline-method" data-id="${esc(connection.toId)}"><span data-user-content>${esc(paper(connection.fromId).title)} · ${tr(labels.paper[connection.relation])} · ${esc(idea(connection.toId).title)}</span></button><button type="button" class="mini-action" data-workspace-action="remove-contribution" data-id="${esc(membership.id)}" data-edge-id="${esc(connection.id)}">移出贡献展示</button></div>`).join("") || `<p class="field-help">尚无明确方法贡献；不会从阶段摘要或全部论文关系自动推断。</p>`}<button type="button" class="button secondary" data-workspace-action="stage-methods" data-id="${esc(item.id)}">＋ 方法</button>${methodPaper ? `<h3>${tr("为成员论文标注方法")}</h3><p data-user-content>${esc(methodPaper.title)}</p>${paperMethodForm(methodPaper, item.id)}` : ""}<button type="button" class="button secondary" data-workspace-action="read-stage" data-id="${esc(item.id)}">开始阶段阅读</button>${sessionHistory(item.id, "stage")}</section>`;
}
function renderStageInspector() {
  const current = line(ui.selectedLineId), target = stage(ui.selectedStageId);
  if (!current || current.kind !== "model_family") return;
  $("#inspector").innerHTML = `<button type="button" class="button quiet paper-inspector-close" data-action="close-paper-inspector">关闭详情 ×</button>` + (ui.newStage ? newStageEditor(current) : target ? stageEditor(target, current, current.stageIds.indexOf(target.id)) : "");
}
function paperPickerResults(query, context = ui.paperPicker) {
  const memberIds = context?.kind === "stage-method" ? new Set(stagePaperEdges(context.id).map((membership) => membership.fromId)) : null;
  const existing = context?.kind === "stage" ? new Set(stagePaperEdges(context.id).map((membership) => membership.fromId)) : new Set();
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  return state.papers.filter((item) => {
    const metadata = normalized([item.title, item.authors, item.doi, paperInstitution(item)].join(" "));
    return terms.every((term) => metadata.includes(term) || normalized(item.year) === term);
  }).filter((item) => (!memberIds || memberIds.has(item.id)) && !existing.has(item.id)).slice(0, 12);
}
function renderPaperPickerResults() {
  const context = ui.paperPicker; if (!context) return;
  const items = paperPickerResults($("#picker-paper-query").value);
  $("#picker-paper-results").innerHTML = items.length ? items.map((item) => `<div class="picker-paper-row"><div><strong data-user-content>${esc(item.title)}</strong><small data-user-content>${esc([displayAuthors(item), item.year, paperInstitution(item)].filter(Boolean).join(" · "))}</small></div><button type="button" class="button secondary" data-workspace-action="pick-paper" data-id="${esc(item.id)}">${tr(context.kind === "stage" ? "添加" : "选择")}</button></div>`).join("") : `<p class="field-help">没有匹配的论文。可以更换关键词；阶段方法只能选择已加入阶段的论文。</p>`;
  localize($("#picker-paper-results"));
}
function openPaperPicker(kind, id) {
  ui.paperPicker = { kind, id }; $("#picker-paper-query").value = "";
  $("#picker-paper-title").textContent = tr(kind === "stage" ? "搜索并添加阶段论文" : kind === "stage-method" ? "选择阶段内的成员论文" : "搜索关联此方法的论文");
  $("#picker-method-editor").innerHTML = ""; renderPaperPickerResults(); openDialog("#paper-picker-dialog"); $("#picker-paper-query").focus();
}

function paperMethodForm(item, stageId = "") {
  const draftKey = `paper-method:${item.id}${stageId ? `:${stageId}` : ""}`;
  const edit = draftValues(draftKey);
  return `<form class="workspace-form" data-workspace-form="annotate-method" data-workspace-draft="${esc(draftKey)}" data-id="${esc(item.id)}" ${stageId ? `data-stage-id="${esc(stageId)}"` : ""}><label>搜索已有方法或输入新名称<input name="title" maxlength="120" list="method-options-${esc(item.id)}" value="${esc(edit.title || "")}" placeholder="例如：GRPO"></label><label>明确选择已有方法<select name="ideaId"><option value="">按输入名称匹配或新建</option>${methods().map((method) => `<option value="${esc(method.id)}" ${edit.ideaId === method.id ? "selected" : ""} data-user-content>${esc(method.title)} · ${esc(method.id.slice(-6))}</option>`).join("")}</select></label><datalist id="method-options-${esc(item.id)}">${methods().map((method) => `<option value="${esc(method.title)}">${esc((method.aliases || []).join(" · "))}</option>`).join("")}</datalist>${paperIdeaEdges(item.id).some((connection) => idea(connection.toId)?.entityType === "method") ? `<label>选择既有关系（多条旧关系时）<select name="edgeId"><option value="">自动创建或复用唯一关系</option>${paperIdeaEdges(item.id).filter((connection) => idea(connection.toId)?.entityType === "method").map((connection) => `<option value="${esc(connection.id)}" ${edit.edgeId === connection.id ? "selected" : ""} data-user-content>${esc(idea(connection.toId).title)} · ${labels.paper[connection.relation]} · ${esc(truncate(connection.note || connection.id, 42))}</option>`).join("")}</select></label>` : ""}<label>关系依据<textarea name="note" maxlength="3000" rows="2">${esc(edit.note || "")}</textarea></label><label>原文位置链接<input name="sourceUrl" maxlength="1500" value="${esc(edit.sourceUrl || "")}"></label><p class="field-help">已有名称或别名会复用方法；新名称直接创建。请选择论文与方法的关系。</p><div class="direct-relations">${["proposes","improves","uses"].map((relation) => `<button type="submit" name="relation" value="${relation}" class="button secondary">${labels.paper[relation]}</button>`).join("")}</div></form>`;
}
function paperStageForm(item) {
  const edit = draftValues(`paper-stage:${item.id}`), paths = state.lines.filter((line) => line.kind === "model_family"), selectedLine = paths.find((line) => line.id === edit.lineId);
  return `<form class="workspace-form" data-workspace-form="join-stage" data-workspace-draft="paper-stage:${esc(item.id)}" data-id="${esc(item.id)}"><label>选择演进线或新建<select name="lineId"><option value="">＋ 新建演进线</option>${options(paths, edit.lineId)}</select></label><label>新演进线名称<input name="lineTitle" maxlength="120" value="${esc(edit.lineTitle || "")}" placeholder="例如：DeepSeek 模型演进"></label><label>选择阶段或新建<select name="stageId"><option value="">＋ 新增阶段</option>${options((selectedLine?.stageIds || []).map(stage).filter(Boolean), edit.stageId)}</select></label><label>新阶段名称<input name="stageTitle" maxlength="120" value="${esc(edit.stageTitle || "")}" placeholder="例如：R1 · 推理强化学习"></label><label>阶段日期<input name="date" type="date" value="${esc(edit.date || "")}"></label><label>本阶段贡献<textarea name="summary" maxlength="4000" rows="2">${esc(edit.summary || "")}</textarea></label><button type="submit" class="button primary">保存论文阶段</button></form>`;
}
function renderPaperInspector(item) {
  if (!item) return;
  renderMapInspector(item);
  const container = $("#inspector"), bridge = container.querySelector?.(".paper-bridge");
  const content = `<section class="inspector-section paper-workspace"><h3>方法关系</h3>${paperIdeaEdges(item.id).filter((connection) => idea(connection.toId)?.entityType === "method").map((connection) => editableEdge(connection)).join("") || `<p class="field-help">尚无方法关系。可以直接关联已有方法或创建新方法。</p>`}${paperMethodForm(item)}</section>${paperIdeaEdges(item.id).some((edge) => idea(edge.toId)?.entityType !== "method") ? `<section class="inspector-section"><h3>其他思想卡（保留原分类）</h3>${paperIdeaEdges(item.id).filter((edge) => idea(edge.toId)?.entityType !== "method").map((edge) => relationRow(edge, "idea", idea(edge.toId))).join("")}</section>` : ""}<section class="inspector-section paper-workspace"><h3>演进阶段</h3>${state.lines.filter((path) => path.kind === "model_family").flatMap((path) => (path.stageIds || []).filter((id) => stagePaperEdges(id).some((edge) => edge.fromId === item.id)).map((id) => `<div class="stage-membership"><button type="button" class="button quiet" data-action="select-line" data-id="${esc(path.id)}"><span data-user-content>${esc(path.title)} · ${esc(stage(id)?.title)}</span></button><button type="button" class="mini-action" data-workspace-action="remove-stage-paper" data-id="${esc(id)}" data-paper-id="${esc(item.id)}">移出阶段</button></div>`)).join("")}${paperStageForm(item)}</section><div class="paper-meta">${item.doi ? `<p data-user-content>DOI · ${esc(item.doi)}</p>` : ""}</div>`;
  // Preserve the citation inspector's original evidence sections, replacing only its bridge.
  if (bridge) bridge.outerHTML = content;
  else container.innerHTML += content;
  if (item.zoteroKey) container.innerHTML += `<section class="inspector-section"><h3>Zotero 批注</h3><button type="button" class="button quiet" data-action="load-annotations">读取</button>${ui.annotationPaperId === item.id ? (ui.annotations || []).map((annotation, index) => `<div class="annotation"><p data-user-content>${esc(annotation.text || annotation.comment || "")}</p><button type="button" class="button quiet" data-action="annotation-create" data-index="${index}">从批注新建卡片</button><button type="button" class="button quiet" data-action="annotation-link" data-index="${index}">关联已有卡</button></div>`).join("") : ""}</section>`;
  container.innerHTML += `<button type="button" class="button danger" data-action="delete-paper" data-id="${esc(item.id)}">删除这篇论文</button>`;
}
function openStageSession(id) {
  const target = stage(id); if (!target) return;
  ui.selectedStageId = id;
  stopTimer();
  const session = { targetType: "stage", targetId: id, lineId: ui.selectedLineId || "", elapsed: 0, startedAt: Date.now(), running: true };
  const saved = readDraft(sessionDraftKey(session));
  session.elapsed = Number.isFinite(saved?.elapsed) ? Math.max(0, Math.min(86400, saved.elapsed)) : 0;
  ui.session = session;
  $("#session-title").textContent = target.title; $("#session-line").textContent = line(session.lineId)?.title || "";
  $("#session-note").value = saved?.note || ""; $("#session-next-question").value = saved?.nextQuestion || "";
  $("#session-recap").hidden = true; $("#session-zotero").hidden = true;
  updateClock(); ui.timer = setInterval(updateClock, 1000); openDialog("#session-dialog");
}
async function submitWorkspaceForm(form, submitter) {
  const values = Object.fromEntries(new FormData(form).entries()), kind = form.dataset.workspaceForm;
  const draftKey = form.dataset.workspaceDraft, snapshot = draftKey ? JSON.stringify(readDraft(draftKey)) : "";
  let action, payload;
  if (kind === "annotate-method") {
    if (!["proposes","uses","improves"].includes(submitter?.value)) throw new Error("请选择提出、使用或改进。");
    if (!values.edgeId && !values.ideaId && !values.title.trim()) throw new Error("请输入方法名称或明确选择已有方法。");
    action = "paper.annotate_method"; payload = { paperId: form.dataset.id, ...(form.dataset.stageId ? { stageId: form.dataset.stageId } : {}), ...(values.edgeId ? { edgeId: values.edgeId, ideaId: edge(values.edgeId)?.toId } : values.ideaId ? { ideaId: values.ideaId } : { title: values.title }), relation: submitter.value, ...(values.note.trim() ? { note: values.note } : {}), ...(values.sourceUrl.trim() ? { sourceUrl: values.sourceUrl } : {}) };
  } else if (kind === "edge") { action = "edge.update"; payload = { id: form.dataset.id, note: values.note, sourceUrl: values.sourceUrl }; }
  else if (kind === "stage") { action = "stage.update"; payload = { id: form.dataset.id, ...values }; }
  else if (kind === "new-stage") { action = "stage.create"; payload = { ...values, lineId: form.dataset.id }; }
  else if (kind === "stage-paper") { action = "paper.add_to_stage"; payload = { paperId: values.paperId, lineId: ui.selectedLineId, stageId: form.dataset.id }; }
  else if (kind === "join-stage") {
    if (!values.lineId && !values.lineTitle.trim()) throw new Error("请选择演进线或填写新线名称。");
    if (!values.stageId && !values.stageTitle.trim()) throw new Error("请选择阶段或填写新阶段名称。");
    action = "paper.add_to_stage"; payload = { paperId: form.dataset.id, ...(values.lineId ? {lineId: values.lineId} : {lineTitle: values.lineTitle}), ...(values.stageId ? {stageId: values.stageId} : {stageTitle: values.stageTitle}), ...(values.date ? {date: values.date} : {}), ...(values.summary ? {summary: values.summary} : {}) };
  } else return;
  if (kind === "annotate-method" && form.dataset.stageId) await queueContributionAction(() => act(action, payload));
  else await act(action, payload);
  if (kind === "new-stage") { ui.newStage = false; ui.stageInspect = true; ui.inspectorOpen = true; }
  if (kind === "annotate-method" && $("#paper-picker-dialog")?.open) closeDialog($("#paper-picker-dialog"));
  if (draftKey && JSON.stringify(readDraft(draftKey)) === snapshot) forgetDraft(draftKey);
  render(); toast("已保存，关联内容保持同步。");
}
function captureDialogDraft(form) {
  if (form?.id === "line-form") writeDraft($("#line-id").value ? `line:${$("#line-id").value}` : "line-new", { title: $("#line-title").value, question: $("#line-question").value, kind: $("#line-kind").value });
  if (form?.id === "idea-form") writeDraft("idea-new", { title: $("#idea-title").value, aliases: $("#idea-aliases").value, summary: $("#idea-summary").value, kind: ideaKind(), entityType: $("#idea-entity-type").value, lineId: $("#idea-line").value, relation: $("#idea-source-relation").value });
}
document.addEventListener("input", (event) => {
  const form = event.target.form;
  captureDialogDraft(form);
  if (form?.dataset.workspaceForm === "annotate-method" && event.target.name === "title") {
    if (form.elements.ideaId) form.elements.ideaId.value = "";
    if (form.elements.edgeId) form.elements.edgeId.value = "";
  }
  if (form?.dataset.workspaceDraft) workspaceDraft(form);
  if (event.target.id === "picker-paper-query") renderPaperPickerResults();
  if (event.target.id === "method-search") {
    ui.methodQuery = event.target.value;
    $("#method-results").innerHTML = methodChoices(ui.methodQuery).map((item) => `<button type="button" class="card-tab" data-action="paper-view-idea" data-id="${esc(item.id)}" data-user-content>${esc(item.title)}</button>`).join("");
  }
});
document.addEventListener("change", (event) => {
  const form = event.target.form;
  captureDialogDraft(form);
  if (!form?.dataset.workspaceDraft) return;
  if (form.dataset.workspaceForm === "annotate-method") {
    if (event.target.name === "edgeId" && event.target.value && form.elements.ideaId) form.elements.ideaId.value = edge(event.target.value)?.toId || "";
    if (event.target.name === "ideaId" && form.elements.edgeId?.value && edge(form.elements.edgeId.value)?.toId !== event.target.value) form.elements.edgeId.value = "";
  }
  workspaceDraft(form);
  if (form.dataset.workspaceForm === "join-stage" && event.target.name === "lineId") {
    const path = line(event.target.value); form.elements.stageId.innerHTML = `<option value="">＋ 新增阶段</option>` + options((path?.stageIds || []).map(stage).filter(Boolean));
    workspaceDraft(form);
  }
});
document.addEventListener("submit", async (event) => {
  if (!event.target.dataset.workspaceForm) return;
  event.preventDefault();
  try { await submitWorkspaceForm(event.target, event.submitter); } catch (error) { toast(error.message, true); }
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest?.("[data-workspace-action]"); if (!button) return;
  const { workspaceAction: action, id } = button.dataset;
  try {
    if (action === "select-stage") selectTimelineStage(id);
    else if (action === "new-stage") selectTimelineStage("", true);
    else if (action === "timeline-paper") { ui.selectedStageId = id; updatePaperSelection(button.dataset.paperId); }
    else if (action === "timeline-method") { ui.stageInspect = false; ui.newStage = false; selectIdea(id); }
    else if (action === "stage-papers") { selectTimelineStage(id); openPaperPicker("stage", id); }
    else if (action === "stage-methods") {
      selectTimelineStage(id);
      const members = stagePaperEdges(id);
      if (members.length === 1) { ui.stageMethodPaperId = members[0].fromId; renderInspector(); localize($("#inspector")); }
      else if (members.length) openPaperPicker("stage-method", id);
      else { openPaperPicker("stage", id); toast("先添加阶段论文，再为它标注方法贡献。"); }
    }
    else if (action === "pick-paper") {
      const context = ui.paperPicker;
      if (context?.kind === "stage") {
        ui.stageInspect = true; ui.newStage = false; ui.selectedStageId = context.id;
        await act("paper.add_to_stage", { paperId: id, lineId: ui.selectedLineId, stageId: context.id }); closeDialog($("#paper-picker-dialog"));
      } else if (context?.kind === "stage-method") {
        ui.stageMethodPaperId = id; selectTimelineStage(context.id); closeDialog($("#paper-picker-dialog"));
      } else if (context?.kind === "method") {
        $("#picker-method-editor").innerHTML = paperMethodForm(paper(id));
        const form = $("#picker-method-editor").querySelector("form");
        form.elements.ideaId.value = context.id; form.elements.title.value = idea(context.id).title; localize($("#picker-method-editor"));
      }
    }
    else if (action === "remove-contribution") {
      await removeStageContribution(id, button.dataset.edgeId);
    }
    else if (action === "timeline-zoom") zoomGraph($(".timeline-scroll"), Number(button.dataset.step) ? ui.timelineZoom + Number(button.dataset.step) : 1);
    else if (action === "fit-timeline") {
      const scroll = $(".timeline-scroll"), svg = scroll?.querySelector("svg");
      if (svg) zoomGraph(scroll, Math.min(1, scroll.clientWidth / svg.viewBox.baseVal.width, scroll.clientHeight / svg.viewBox.baseVal.height));
    }
    else if (action === "new-method") { openIdeaDialog(); $("#idea-entity-type").value = "method"; if (ui.methodQuery) $("#idea-title").value = ui.methodQuery; renderIdeaMatches(); }
    else if (action === "fit-method") fitMethodGraph(true);
    else if (action === "edit-method") { const form = $("#idea-edit-form"); form?.scrollIntoView?.({ block: "start", behavior: "smooth" }); form?.querySelector?.("input")?.focus?.({ preventScroll: true }); }
    else if (action === "edge-relation") await act("edge.update", { id, relation: button.dataset.relation });
    else if (action === "move-stage") await act("line.move_stage", { lineId: ui.selectedLineId, stageId: id, offset: Number(button.dataset.offset) });
    else if (action === "detach-stage") { if (await confirmAction(tr("从当前阅读线移出阶段？阶段、论文和方法仍然保留。"))) await act("line.detach_stage", { lineId: ui.selectedLineId, stageId: id }); }
    else if (action === "remove-stage-paper") await act("stage.remove_paper", { stageId: id, paperId: button.dataset.paperId });
    else if (action === "read-stage") openStageSession(id);
  } catch (error) { toast(error.message, true); }
});

api("/api/state").then((data) => { state = data; render(); checkReminder(); setInterval(checkReminder, 30_000); refreshWebdav(); setInterval(refreshWebdav, 30_000); refreshZoteroSync(); }).catch((error) => {
  $("#main-view").innerHTML = `<div class="welcome"><h1>无法读取应用数据</h1><p>${esc(error.message)}</p></div>`;
  localize($("#main-view"));
});
