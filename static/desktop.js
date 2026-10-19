// Shared migration helpers also work in the browser; native calls are opt-in.
(() => {
  const nativeInvoke = globalThis.__TAURI__?.core?.invoke;
  const invoke = nativeInvoke ? async (command, args) => {
    try { return await nativeInvoke(command, args); }
    catch (error) { throw new Error(String(error?.message || error)); }
  } : null;
  const prefix = "paperline-draft:";
  const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  function validatedDrafts(drafts, backup) {
    if (!plain(drafts) || Object.keys(drafts).length > 2000) throw new Error("迁移草稿格式无效或数量过多。");
    const ideas = new Set((backup?.ideas || []).map((item) => item.id));
    const lines = new Map((backup?.lines || []).map((item) => [item.id, item]));
    const stages = new Set((backup?.stages || []).map((item) => item.id));
    const papers = new Set((backup?.papers || []).map((item) => item.id));
    const edges = new Map((backup?.edges || []).map((item) => [item.id, item]));
    const strings = (draft, fields) => Object.entries(draft).every(([field, value]) => Object.hasOwn(fields, field) && typeof value === "string" && value.length <= fields[field]);
    const reference = (id, collection) => id === undefined || id === "" || collection.has(id);
    const date = (value) => value === undefined || value === "" || (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) >= 1 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
    const session = (draft) => !Object.keys(draft).some((field) => !["elapsed", "note", "nextQuestion"].includes(field)) && Number.isInteger(draft.elapsed) && draft.elapsed >= 0 && draft.elapsed <= 86400 && typeof draft.note === "string" && draft.note.length <= 4000 && typeof draft.nextQuestion === "string" && draft.nextQuestion.length <= 1000;
    const decodedId = (value) => { try { return decodeURIComponent(value); } catch { return ""; } };
    const result = Object.create(null);
    const limits = { title: 120, aliases: 1500, summary: 4000, mechanism: 6000, thoughts: 6000, baseUpdatedAt: 100, kind: 20, status: 20, entityType: 20 };
    for (const [key, draft] of Object.entries(drafts)) {
      if (!plain(draft) || !key.startsWith(prefix)) continue;
      const parts = key.slice(prefix.length).split(":");
      if (parts[0] === "idea" && parts.length === 2 && ideas.has(parts[1])) {
        if (typeof draft.title !== "string" || Object.entries(draft).some(([field, value]) => !Object.hasOwn(limits, field) || typeof value !== "string" || value.length > limits[field])) continue;
        if (draft.kind !== undefined && !["concept", "innovation", "question"].includes(draft.kind)) continue;
        if (draft.status !== undefined && !["inbox", "learning", "understood"].includes(draft.status)) continue;
        if (draft.entityType !== undefined && !["method", "concept", "question", "unclassified"].includes(draft.entityType)) continue;
      } else if (parts[0] === "session" && parts.length === 3 && ideas.has(parts[2]) && lines.get(parts[1])?.ideaIds?.includes(parts[2])) {
        if (!session(draft)) continue;
      } else if (parts[0] === "session" && parts.length === 4 && parts[1] === "stage" && stages.has(parts[2]) && (parts[3] === "" || lines.get(parts[3])?.stageIds?.includes(parts[2]))) {
        if (!session(draft)) continue;
      } else if (parts[0] === "stage" && parts.length === 2 && stages.has(parts[1])) {
        if (!strings(draft, { title: 120, date: 10, summary: 4000, baseUpdatedAt: 100 })) continue;
      } else if (parts[0] === "stage-new" && parts.length === 2 && lines.get(parts[1])?.kind === "model_family") {
        if (!strings(draft, { title: 120, date: 10, summary: 4000 })) continue;
      } else if (parts[0] === "line" && parts.length === 2 && lines.has(parts[1])) {
        if (!strings(draft, { title: 120, question: 1000, kind: 20 })) continue;
      } else if (parts[0] === "edge" && parts.length === 2 && edges.has(parts[1])) {
        if (!strings(draft, { note: 3000, sourceUrl: 1500 })) continue;
      } else if (parts[0] === "paper-method" && [2, 3].includes(parts.length) && papers.has(parts[1])) {
        if (parts.length === 3 && (!stages.has(parts[2]) || !(backup.edges || []).some((edge) => edge.fromType === "paper" && edge.fromId === parts[1] && edge.toType === "stage" && edge.toId === parts[2] && edge.relation === "documents"))) continue;
        if (!strings(draft, { title: 120, ideaId: 150, edgeId: 40, note: 3000, sourceUrl: 1500 }) || !reference(draft.ideaId, ideas)) continue;
        if (draft.edgeId) {
          const edge = edges.get(draft.edgeId);
          if (!edge || edge.fromType !== "paper" || edge.fromId !== parts[1] || (edge.toType === undefined ? "idea" : edge.toType) !== "idea" || !ideas.has(edge.toId) || (draft.ideaId && draft.ideaId !== edge.toId)) continue;
        }
      } else if (parts[0] === "paper-stage" && parts.length === 2 && papers.has(parts[1])) {
        if (!strings(draft, { lineId: 150, lineTitle: 120, stageId: 150, stageTitle: 120, date: 10, summary: 4000 }) || !reference(draft.lineId, new Set(lines.keys())) || !reference(draft.stageId, stages)) continue;
        if (draft.lineId && draft.stageId && !lines.get(draft.lineId)?.stageIds?.includes(draft.stageId)) continue;
      } else if (parts[0] === "line-new" && parts.length === 1) {
        if (!strings(draft, { title: 120, question: 1000, kind: 20 })) continue;
      } else if ((parts[0] === "idea-new" && parts.length === 1) ||
        (parts[0] === "idea-new-parent" && parts.length === 2 && ideas.has(decodedId(parts[1]))) ||
        (parts[0] === "idea-new-paper" && parts.length === 3 && papers.has(decodedId(parts[1])))) {
        if (!strings(draft, { title: 120, aliases: 1500, summary: 4000, kind: 20, entityType: 20, lineId: 150, relation: 30 }) || !reference(draft.lineId, new Set(lines.keys()))) continue;
        if (draft.entityType !== undefined && !["method", "concept", "question", "unclassified"].includes(draft.entityType)) continue;
      } else continue;
      result[key] = { ...draft };
      if (["stage", "stage-new", "paper-stage"].includes(parts[0]) && !date(draft.date)) result[key].date = "";
    }
    return result;
  }
  function migration(backup, storage = globalThis.localStorage) {
    const drafts = Object.create(null);
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try { drafts[key] = JSON.parse(storage.getItem(key)); } catch { /* Ignore broken drafts. */ }
    }
    return { format: "paperline-desktop-migration", version: 1, backup, drafts: validatedDrafts(drafts, backup) };
  }
  function unpack(value) {
    if (value?.format !== "paperline-desktop-migration") return { backup: value, drafts: null };
    if (value.version !== 1 || !plain(value.backup) || !Array.isArray(value.backup.ideas) || !Array.isArray(value.backup.lines)) throw new Error("迁移包版本或数据格式无效。");
    return { backup: value.backup, drafts: validatedDrafts(value.drafts, value.backup) };
  }
  function installDrafts(drafts, backup, storage = globalThis.localStorage) {
    const accepted = validatedDrafts(drafts, backup);
    const keys = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    const previous = new Map(keys.map((key) => [key, storage.getItem(key)]));
    try {
      keys.forEach((key) => storage.removeItem(key));
      for (const [key, draft] of Object.entries(accepted)) storage.setItem(key, JSON.stringify(draft));
    } catch (error) {
      // Restore the previous drafts if the storage quota rejects this package.
      for (const key of Object.keys(accepted)) storage.removeItem(key);
      for (const [key, value] of previous) storage.setItem(key, value);
      throw error;
    }
  }
  async function saveJson(value, filename) {
    const contents = JSON.stringify(value, null, 2);
    if (invoke) return invoke("save_backup", { contents });
    const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  const bridge = { enabled: Boolean(invoke), migration, unpack, installDrafts, saveJson };
  if (invoke) {
    bridge.request = async (path, options = {}) => {
      const method = options.method || "GET";
      if (!["GET", "POST"].includes(method) || !path.startsWith("/api/")) throw new Error("不支持的桌面请求。");
      const body = options.body ? JSON.parse(options.body) : null;
      const response = await invoke("api_request", { method, path, body });
      return { status: response.status, ok: response.status >= 200 && response.status < 300, json: async () => response.data };
    };
    bridge.chooseDirectory = () => invoke("choose_directory");
    bridge.confirm = (message) => invoke("confirm_action", { message });
    const handleLink = (event) => {
      if (event.type === "auxclick" && event.button !== 1) return;
      const link = event.target.closest?.("a[href]");
      if (!link) return;
      const url = link.getAttribute("href") || "";
      if (!/^https?:\/\/|^zotero:\/\//i.test(url) && url !== "/api/backup") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const action = url === "/api/backup" ? bridge.request(url).then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "备份失败。");
        return saveJson(data, "paperline-backup.json");
      }) : invoke("open_external", { url });
      action.catch((error) => globalThis.alert(String(error.message || error)));
    };
    document.addEventListener("click", handleLink, true);
    document.addEventListener("auxclick", handleLink, true);
    document.querySelectorAll("[data-desktop-only]").forEach((node) => { node.hidden = false; });
    document.querySelectorAll("[data-browser-only]").forEach((node) => { node.hidden = true; });
  }
  globalThis.PaperLineDesktop = bridge;
})();
