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
    const result = Object.create(null);
    const limits = { title: 120, aliases: 1500, summary: 4000, mechanism: 6000, thoughts: 6000, baseUpdatedAt: 100, kind: 20, status: 20 };
    for (const [key, draft] of Object.entries(drafts)) {
      if (!plain(draft) || !key.startsWith(prefix)) continue;
      const parts = key.slice(prefix.length).split(":");
      if (parts[0] === "idea" && parts.length === 2 && ideas.has(parts[1])) {
        if (typeof draft.title !== "string" || Object.entries(draft).some(([field, value]) => !Object.hasOwn(limits, field) || typeof value !== "string" || value.length > limits[field])) continue;
        if (draft.kind !== undefined && !["concept", "innovation", "question"].includes(draft.kind)) continue;
        if (draft.status !== undefined && !["inbox", "learning", "understood"].includes(draft.status)) continue;
      } else if (parts[0] === "session" && parts.length === 3 && ideas.has(parts[2]) && lines.get(parts[1])?.ideaIds?.includes(parts[2])) {
        if (Object.keys(draft).some((field) => !["elapsed", "note", "nextQuestion"].includes(field)) || !Number.isInteger(draft.elapsed) || draft.elapsed < 0 || draft.elapsed > 86400 || typeof draft.note !== "string" || draft.note.length > 4000 || typeof draft.nextQuestion !== "string" || draft.nextQuestion.length > 1000) continue;
      } else continue;
      result[key] = { ...draft };
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
