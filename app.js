/* EPUB 整书编辑器：解包 ZIP、编辑 XHTML/CSS、预览、重新打包保存。 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const EMBEDDED = params.get("embedded") === "1";
  const SHELL = params.get("shell") === "1";
  const paramsPath = params.get("projectEntry") || params.get("path") || "";
  const host = window.chrome && window.chrome.webview;
  const shellPending = new Map();
  const savePending = new Map();
  const state = {
    zip: null, bytes: null, name: "book.epub", path: paramsPath,
    current: "", currentMode: "text", dirty: new Set(), loading: false,
    previewToken: 0, blobCache: new Map(), treeFilter: "", saveSeq: 0, loadToken: "", loadPoller: 0,
    edits: new Map(), suppressChange: false, previewTarget: "", previewTimer: 0,
    previewMode: "flow", previewTheme: "sepia", previewFont: 20, previewKind: "html", paged: null,
    deletions: new Set(), opfPath: "", bookHash: "", draftKey: "", draftTimer: 0, saving: false,
    validation: null, wrap: true, autoSaveMs: 5000, autoSaveTimer: 0,
    cmDocs: new Map(), binaryDoc: null, readerPrefs: null, followReader: false,
  };
  let cm = null;
  const THEMES = ["lyra", "violet", "emerald", "sunset", "sakura", "light"];
  function applyWrap(on) {
    state.wrap = !!on;
    if (cm) cm.setOption("lineWrapping", state.wrap);
    const btn = $("wrapBtn");
    if (btn) btn.classList.toggle("active", state.wrap);
    try { localStorage.setItem("lyra.epubEditor.wrap", state.wrap ? "1" : "0"); } catch { }
  }
  function applyTheme(name) {
    const theme = THEMES.includes(name) ? name : "lyra";
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("lyra.epubEditor.theme", theme); } catch { }
    const sel = $("themeSelect");
    if (sel) sel.value = theme;
  }

  function status(text, error) {
    const el = $("status");
    if (el) { el.textContent = text || ""; el.style.color = error ? "#ff8a8a" : "#8b94a6"; }
  }
  function setEmpty(show, text) {
    const el = $("empty");
    if (!el) return;
    el.hidden = !show;
    if (text) el.firstElementChild.textContent = text;
  }
  function base64ToBytes(b64) {
    const bin = atob(String(b64 || ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(bin);
  }
  function extOf(rel) { const m = String(rel || "").match(/\.([a-z0-9]+)$/i); return m ? "." + m[1].toLowerCase() : ""; }
  function dirOf(rel) { const s = String(rel || ""); const i = s.lastIndexOf("/"); return i >= 0 ? s.slice(0, i) : ""; }
  function baseName(rel) { const s = String(rel || ""); const i = s.lastIndexOf("/"); return i >= 0 ? s.slice(i + 1) : s; }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }
  function resolvePath(baseDir, rel) {
    let s = safeDecode(String(rel || "").split("#")[0].split("?")[0]).replace(/\\/g, "/");
    if (!s || /^(?:[a-z]+:|\/\/|#)/i.test(s)) return "";
    const parts = s.startsWith("/") ? [] : String(baseDir || "").split("/").filter(Boolean);
    for (const p of s.replace(/^\//, "").split("/")) {
      if (!p || p === ".") continue;
      if (p === "..") parts.pop(); else parts.push(p);
    }
    return parts.join("/");
  }
  function relativeHref(fromDir, target) {
    const a = String(fromDir || "").split("/").filter(Boolean);
    const b = String(target || "").split("/").filter(Boolean);
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    return [...Array(a.length - common).fill(".."), ...b.slice(common)].join("/");
  }
  function xmlEscape(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function findNavPath(opfText, opfDir) {
    const items = opfText.match(/<item\b[^>]*\/?>/gi) || [];
    for (const tag of items) {
      const hm = tag.match(/href=["']([^"']+)["']/i);
      const pm = tag.match(/properties=["']([^"']*)["']/i);
      if (hm && pm && /(^|\s)nav(\s|$)/i.test(pm[1])) return resolvePath(opfDir, hm[1].split("#")[0]);
    }
    for (const tag of items) {
      const hm = tag.match(/href=["']([^"']+)["']/i);
      if (hm && /(?:^|\/)nav\.x?html?$/i.test(hm[1])) return resolvePath(opfDir, hm[1].split("#")[0]);
    }
    return "";
  }
  async function findOpfPath() {
    if (state.opfPath && state.zip.file(state.opfPath)) return state.opfPath;
    const c = await entryText("META-INF/container.xml");
    const m = c.match(/<rootfile\b[^>]*full-path=["']([^"']+)["']/i);
    if (m) { state.opfPath = safeDecode(m[1]); return state.opfPath; }
    const any = listFiles().find((f) => /\.opf$/i.test(f));
    state.opfPath = any || "";
    return state.opfPath;
  }
  function syncDocText(rel, text) {
    if (!rel || !cm || !state.cmDocs.has(rel)) return;
    const doc = state.cmDocs.get(rel);
    if (doc.getValue() === text) return;
    const oldSuppress = state.suppressChange;
    state.suppressChange = true;
    try { doc.setValue(text); } catch { }
    state.suppressChange = oldSuppress;
  }
  function markEntryEdited(rel, text) {
    if (!rel) return;
    syncDocText(rel, text);
    state.edits.set(rel, text);
    state.zip.file(rel, text);
    state.dirty.add(rel);
    $("dirtyBadge").hidden = false;
    scheduleDraftSave();
    scheduleAutoSave();
  }
  function refreshDirtyBadge() { $("dirtyBadge").hidden = !(state.dirty.size || state.deletions.size); }

  function isTextFile(rel) { return /\.(x?html?|css|js|mjs|xml|opf|ncx|svg|txt|md|json|smil)$/i.test(rel) || rel === "mimetype"; }
  function isHtmlFile(rel) { return /\.(x?html?|htm)$/i.test(rel); }
  function modeFor(rel) {
    const ext = extOf(rel);
    if (ext === ".css") return "css";
    if (ext === ".js" || ext === ".mjs") return "javascript";
    if (ext === ".xml" || ext === ".opf" || ext === ".ncx" || ext === ".svg" || ext === ".smil") return "xml";
    if (/\.(x?html?|htm)$/i.test(rel)) return "htmlmixed";
    return "text";
  }
  function mimeFor(rel) {
    const ext = extOf(rel);
    return ({ ".xhtml": "application/xhtml+xml", ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
      ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
      ".mp4": "video/mp4", ".xml": "application/xml", ".opf": "application/oebps-package+xml", ".ncx": "application/x-dtbncx+xml" })[ext] || "application/octet-stream";
  }
  function listFiles() {
    if (!state.zip) return [];
    const out = [];
    state.zip.forEach((path, entry) => {
      if (entry.dir) return;
      if (/\.bak$/i.test(path) || /(^|\/)\.dsh-draft\.json$/i.test(path)) return;
      out.push(path);
    });
    return out.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }
  function markDirty() {
    if (!state.current) return;
    state.dirty.add(state.current);
    $("dirtyBadge").hidden = false;
    refreshDirtyBadge();
    scheduleDraftSave();
    scheduleAutoSave();
    $("saveBtn").disabled = !state.zip;
    status("已修改 " + state.current + "，Ctrl+S 保存整本");
  }

  // ---------- 未保存草稿（IndexedDB，跨阅读器窗口稳定） ----------
  function hashBytes(bytes) {
    return new Promise((resolve) => {
      try {
        if (!window.crypto || !crypto.subtle) { resolve(String(bytes.length)); return; }
        crypto.subtle.digest("SHA-256", bytes).then((buf) => {
          const u = new Uint8Array(buf); let out = "";
          for (let i = 0; i < Math.min(12, u.length); i++) out += u[i].toString(16).padStart(2, "0");
          resolve(out);
        }).catch(() => resolve(String(bytes.length)));
      } catch { resolve(String(bytes.length)); }
    });
  }
  function draftKeyFor(name, bytes, hash) { return (name || "book.epub") + ":" + bytes.length + ":" + hash; }
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("lyra-epub-editor", 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore("drafts", { keyPath: "key" }); } catch { } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbPutDraft(draft) {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put(draft);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }
  async function idbDeleteDraft(key) {
    if (!key) return;
    try { const db = await idbOpen(); await new Promise((resolve) => { const tx = db.transaction("drafts", "readwrite"); tx.objectStore("drafts").delete(key); tx.oncomplete = resolve; tx.onerror = resolve; }); db.close(); } catch { }
  }
  async function idbGetDraft(key) {
    if (!key) return null;
    try { const db = await idbOpen(); const res = await new Promise((resolve) => { const tx = db.transaction("drafts", "readonly"); const r = tx.objectStore("drafts").get(key); r.onsuccess = () => resolve(r.result || null); r.onerror = () => resolve(null); }); db.close(); return res; } catch { return null; }
  }
  function scheduleDraftSave() {
    if (!state.draftKey || !state.zip) return;
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(saveDraftNow, 800);
  }
  async function saveDraftNow() {
    if (!state.draftKey || !state.zip) return;
    if (!state.dirty.size && !state.deletions.size) return;
    try {
      const edits = {};
      for (const [rel, text] of state.edits) edits[rel] = text;
      await idbPutDraft({ key: state.draftKey, name: state.name, path: state.path || "", size: state.bytes ? state.bytes.length : 0,
        at: Date.now(), edits, deletions: Array.from(state.deletions) });
    } catch { }
  }
  async function restoreDraftIfAny() {
    const draft = await idbGetDraft(state.draftKey);
    if (!draft) return false;
    const when = new Date(draft.at || 0);
    const ok = confirm("发现这本书上次未保存的草稿：\n" + when.toLocaleString() + "\n\n是否恢复？\n（选择取消会保留草稿，稍后仍可恢复）");
    if (!ok) return false;
    for (const rel of draft.deletions || []) {
      try { state.zip.remove(rel); } catch { }
      state.deletions.add(rel);
    }
    for (const [rel, text] of Object.entries(draft.edits || {})) {
      state.zip.file(rel, text);
      state.edits.set(rel, text);
      state.dirty.add(rel);
    }
    if (state.dirty.size || state.deletions.size) { $("dirtyBadge").hidden = false; refreshDirtyBadge(); renderTree(); }
    status("已恢复上次未保存的草稿，保存后会写回 EPUB");
    return true;
  }

  // ---------- EPUB 自动保存 ----------
  function setAutoSave(ms) {
    state.autoSaveMs = Math.max(0, Number(ms) || 0);
    const sel = $("autoSaveSelect");
    if (sel) sel.value = String(state.autoSaveMs);
    try { localStorage.setItem("lyra.epubEditor.autoSave", String(state.autoSaveMs)); } catch { }
    scheduleAutoSave();
  }
  function scheduleAutoSave() {
    clearTimeout(state.autoSaveTimer);
    if (!state.autoSaveMs || !state.zip) return;
    if (!state.dirty.size && !state.deletions.size) return;
    state.autoSaveTimer = setTimeout(() => { autoSaveNow().catch(() => { }); }, state.autoSaveMs);
  }
  async function autoSaveNow() {
    if (!state.autoSaveMs || !state.zip || state.saving) return;
    if (!state.dirty.size && !state.deletions.size) return;
    // 弹窗打开时不要偷偷保存，避免底层变化打断用户操作
    if (!$("validateOverlay").hidden || !$("outlineOverlay").hidden || !$("globalFindOverlay").hidden || !$("metaOverlay").hidden || !$("assetsOverlay").hidden) {
      scheduleAutoSave(); return;
    }
    state.saving = true;
    try {
      const issues = await validateBook();
      const errors = issues.filter((x) => x.level === "error");
      if (errors.length) {
        status("自动保存暂停：" + errors.length + " 个结构错误，请先点「检查」处理", true);
        scheduleAutoSave();
        return;
      }
      await performSave({ auto: true });
    } finally { state.saving = false; }
  }

  // ---------- host bridge ----------
  function hostCall(type, payload) {
    return new Promise((resolve, reject) => {
      if (!host) { reject(new Error("宿主不可用")); return; }
      const requestId = "epub-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      const onMessage = (ev) => {
        const d = ev.data || {};
        if (d.requestId !== requestId) return;
        try { host.removeEventListener("message", onMessage); } catch { }
        if (d.ok === false) reject(new Error(d.error || "宿主操作失败")); else resolve(d);
      };
      host.addEventListener("message", onMessage);
      host.postMessage(Object.assign({ type: type, requestId: requestId }, payload || {}));
      setTimeout(() => { try { host.removeEventListener("message", onMessage); } catch { } reject(new Error("宿主响应超时")); }, 20000);
    });
  }
  function shellHostCall(type, payload) {
    return new Promise((resolve, reject) => {
      const requestId = "epub-shell-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      shellPending.set(requestId, { resolve, reject });
      window.parent.postMessage({ type: "shell-host-request", requestId: requestId, method: type, payload: payload || {} }, "*");
      setTimeout(() => { if (shellPending.has(requestId)) { shellPending.delete(requestId); reject(new Error("编辑器外壳响应超时")); } }, 20000);
    });
  }
  function callHost(type, payload) { return SHELL ? shellHostCall(type, payload) : hostCall(type, payload); }

  // ---------- tree ----------
  function renderTree() {
    const box = $("tree");
    if (!box) return;
    box.innerHTML = "";
    const files = listFiles().filter((p) => !state.treeFilter || p.toLowerCase().includes(state.treeFilter));
    $("fileCount").textContent = String(listFiles().length);
    if (!files.length) { box.innerHTML = '<div class="tree-empty">没有匹配的文件</div>'; return; }
    for (const rel of files) {
      const item = document.createElement("div");
      item.className = "tree-item" + (rel === state.current ? " active" : "") + ((state.dirty.has(rel) || state.deletions.has(rel)) ? " dirty" : "");
      const icon = document.createElement("span");
      icon.className = "icon";
      const ext = extOf(rel);
      icon.textContent = /\.(x?html?|htm)$/i.test(rel) ? "H" : ext === ".css" ? "C" : ext === ".js" ? "J" : /\.(png|jpe?g|gif|webp|svg)$/i.test(rel) ? "I" : ext === ".opf" ? "O" : "·";
      const name = document.createElement("span");
      name.className = "rel";
      name.textContent = rel;
      item.appendChild(icon); item.appendChild(name);
      const del = document.createElement("span");
      del.className = "tree-del"; del.textContent = "×"; del.title = "从 EPUB 删除";
      del.addEventListener("click", (event) => { event.stopPropagation(); deleteEntry(rel).catch((e) => status(e.message, true)); });
      item.appendChild(del);
      item.title = rel;
      item.addEventListener("click", () => openEntry(rel).catch((e) => status(e.message, true)));
      box.appendChild(item);
    }
  }

  // ---------- open / edit ----------
  async function openEntry(rel) {
    if (!state.zip || !rel) return;
    const entry = state.zip.file(rel);
    if (!entry) { status("文件不存在：" + rel, true); return; }
    if (!isTextFile(rel)) {
      state.current = rel; state.currentMode = "binary";
      renderTree();
      $("currentFile").textContent = rel;
      $("fileMode").textContent = extOf(rel) + " · 二进制";
      if (!state.binaryDoc) state.binaryDoc = CodeMirror.Doc("", "");
      state.suppressChange = true;
      if (cm.getDoc() !== state.binaryDoc) cm.swapDoc(state.binaryDoc);
      state.suppressChange = false;
      cm.setOption("readOnly", true);
      $("saveBtn").disabled = !state.zip;
      status("二进制文件，不支持源码编辑：" + rel);
      updateChapterButtons();
      renderPreview(rel).catch(() => { });
      return;
    }
    const text = await entryText(rel);
    state.current = rel; state.currentMode = "text";
    if (isHtmlFile(rel)) state.previewTarget = rel;
    renderTree();
    $("currentFile").textContent = rel;
    $("fileMode").textContent = modeFor(rel) || "text";
    cm.setOption("readOnly", false);
    let doc = state.cmDocs.get(rel);
    if (!doc) { doc = CodeMirror.Doc(text, modeFor(rel)); state.cmDocs.set(rel, doc); }
    state.suppressChange = true;
    if (cm.getDoc() !== doc) cm.swapDoc(doc);
    state.suppressChange = false;
    cm.setOption("mode", modeFor(rel));
    $("saveBtn").disabled = !state.zip;
    updateChapterButtons();
    const previewRel = (extOf(rel) === ".css" && state.previewTarget && state.zip.file(state.previewTarget)) ? state.previewTarget : rel;
    renderPreview(previewRel).catch(() => { });
  }

  // ---------- preview ----------
  async function entryText(rel) {
    if (!rel || !state.zip) return "";
    if (state.edits.has(rel)) return state.edits.get(rel);
    const entry = state.zip.file(rel);
    return entry ? entry.async("string") : "";
  }
  async function blobUrlFor(rel) {
    if (state.blobCache.has(rel)) return state.blobCache.get(rel);
    const entry = state.zip && state.zip.file(rel);
    if (!entry) return "";
    const bytes = await entry.async("uint8array");
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeFor(rel) }));
    state.blobCache.set(rel, url);
    return url;
  }
  async function rewriteCss(text, baseDir) {
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    const parts = [];
    let last = 0, m;
    while ((m = re.exec(text))) {
      const raw = m[2].trim();
      if (/^(?:[a-z]+:|\/\/|data:)/i.test(raw)) continue;
      const target = resolvePath(baseDir, raw);
      const url = target ? await blobUrlFor(target) : "";
      if (!url) continue;
      parts.push(text.slice(last, m.index), 'url("' + url + '")');
      last = m.index + m[0].length;
    }
    parts.push(text.slice(last));
    return parts.join("");
  }
  async function rewriteHtml(text, fileRel) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    const baseDir = dirOf(fileRel);
    for (const el of Array.from(doc.querySelectorAll("[src]"))) {
      const raw = el.getAttribute("src") || "";
      if (/^(?:[a-z]+:|\/\/|data:|#)/i.test(raw)) continue;
      const target = resolvePath(baseDir, raw);
      if (!target) continue;
      const url = await blobUrlFor(target);
      if (url) el.setAttribute("src", url);
    }
    for (const el of Array.from(doc.querySelectorAll("link[href]"))) {
      const raw = el.getAttribute("href") || "";
      if (!/\.css$/i.test(raw)) continue;
      const target = resolvePath(baseDir, raw);
      const entry = target && state.zip.file(target);
      if (!entry) continue;
      const css = await rewriteCss(await entryText(target), dirOf(target));
      el.setAttribute("href", URL.createObjectURL(new Blob([css], { type: "text/css" })));
    }
    for (const el of Array.from(doc.querySelectorAll("a[href]"))) {
      const raw = el.getAttribute("href") || "";
      if (/^(?:[a-z]+:|\/\/|#|mailto:|javascript:)/i.test(raw)) continue;
      const target = resolvePath(baseDir, raw);
      if (!target) continue;
      el.setAttribute("data-lyra-href", target);
      el.removeAttribute("href");
    }
    for (const el of Array.from(doc.querySelectorAll("[style]"))) {
      el.setAttribute("style", await rewriteCss(el.getAttribute("style") || "", baseDir));
    }
    for (const style of Array.from(doc.querySelectorAll("style"))) {
      style.textContent = await rewriteCss(style.textContent || "", baseDir);
    }
    const title = doc.title || baseName(fileRel);
    const script = '<script>document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("[data-lyra-href]"):null;if(a){e.preventDefault();parent.postMessage({type:"epub-preview-open",path:a.getAttribute("data-lyra-href")},"*");}});<\/script>';
    return (doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : "<!doctype html>") + doc.documentElement.outerHTML.replace("</body>", script + "</body>");
  }
  // ---------- 分页预览：尽量贴近阅读器的整页排版 ----------
  const PREVIEW_THEMES = {
    sepia: { outer: "#24211d", page: "#f5f0e6", fg: "#2b2620", accent: "#8a5a2b" },
    paper: { outer: "#20242a", page: "#ffffff", fg: "#1a1a1a", accent: "#2f6fed" },
    green: { outer: "#17211b", page: "#e9f0e6", fg: "#28402a", accent: "#2e6b45" },
    dark: { outer: "#0c0c0e", page: "#17181b", fg: "#d9dde3", accent: "#66ccff" },
    nightblue: { outer: "#060a12", page: "#0a1120", fg: "#b8d4ff", accent: "#6aa8ff" },
  };
  function previewTheme() { return PREVIEW_THEMES[state.previewTheme] || PREVIEW_THEMES.sepia; }
  function parseReaderPrefsFromQuery() {
    try {
      const qp = new URLSearchParams(location.search);
      if (qp.get("readerFont") == null) return;
      const font = Math.max(12, Math.min(40, Number(qp.get("readerFont")) || 22));
      const line = Math.max(1.2, Math.min(3, Number(qp.get("readerLine")) || 1.95));
      const width = Math.max(420, Math.min(1400, Number(qp.get("readerWidth")) || 860));
      const theme = qp.get("readerTheme") || "dark";
      const bg = qp.get("readerBg") || "";
      const fg = qp.get("readerFg") || "";
      state.readerPrefs = { theme, font, line, width, bg, fg };
      state.followReader = true;
      try { if (localStorage.getItem("lyra.epubEditor.followReader") === "0") state.followReader = false; } catch { }
    } catch { }
  }
  function previewSettings() {
    if (state.followReader && state.readerPrefs) {
      const rp = state.readerPrefs;
      const base = PREVIEW_THEMES[rp.theme] || PREVIEW_THEMES.dark || PREVIEW_THEMES.sepia;
      return {
        theme: { outer: base.outer, page: rp.bg || base.page, fg: rp.fg || base.fg, accent: base.accent },
        font: Math.max(12, Math.min(40, rp.font)),
        line: Math.max(1.2, Math.min(3, rp.line)),
        width: Math.max(420, Math.min(1400, rp.width)),
      };
    }
    return { theme: previewTheme(), font: state.previewFont, line: 1.8, width: 760 };
  }
  function currentPreviewRel() {
    if (!state.current) return "";
    return (extOf(state.current) === ".css" && state.previewTarget && state.zip.file(state.previewTarget))
      ? state.previewTarget : state.current;
  }
  function updatePreviewControls() {
    const paged = state.previewMode === "paged" && state.previewKind === "html";
    const nav = $("pageNav");
    if (nav) nav.hidden = !paged;
    $("flowBtn").classList.toggle("active", state.previewMode !== "paged");
    $("pagedBtn").classList.toggle("active", state.previewMode === "paged");
    const p = state.paged;
    if (p) {
      $("pageLabel").textContent = (p.page + 1) + " / " + p.total;
      $("pagePrev").disabled = p.page <= 0;
      $("pageNext").disabled = p.page >= p.total - 1;
    } else {
      $("pageLabel").textContent = "1 / 1"; $("pagePrev").disabled = true; $("pageNext").disabled = true;
    }
    const follow = !!(state.followReader && state.readerPrefs);
    if ($("followReader")) {
      $("followReader").checked = follow;
      $("followReader").disabled = !state.readerPrefs;
    }
    if (follow && state.readerPrefs) {
      if (PREVIEW_THEMES[state.readerPrefs.theme]) $("previewTheme").value = state.readerPrefs.theme;
      $("fontLabel").textContent = String(Math.round(state.readerPrefs.font));
    } else {
      $("previewTheme").value = state.previewTheme;
      $("fontLabel").textContent = String(state.previewFont);
    }
    if ($("previewInfo")) {
      const base = paged ? "分页预览" : (state.previewKind === "html" ? "HTML 预览" : (state.previewKind === "image" ? "图片" : "源码"));
      $("previewInfo").textContent = base + (follow ? " · 跟随阅读器" : "");
    }
  }
  function applyPageTheme(doc) {
    const ps = previewSettings();
    const t = ps.theme;
    let st = doc.getElementById("lyra-page-style");
    if (!st) { st = doc.createElement("style"); st.id = "lyra-page-style"; (doc.head || doc.documentElement).appendChild(st); }
    st.textContent = `
      html,body{height:100%!important;margin:0!important;padding:0!important;overflow:hidden!important;background:${t.outer}!important}
      #lyra-page-shell{position:fixed!important;inset:0!important;display:flex!important;align-items:center!important;justify-content:center!important;background:${t.outer}!important;padding:24px;box-sizing:border-box}
      #lyra-page{position:relative;width:min(${ps.width}px,100%);height:100%;background:${t.page};color:${t.fg};border-radius:10px;box-shadow:0 24px 60px rgba(0,0,0,.35);box-sizing:border-box;padding:34px 42px;overflow:hidden}
      #lyra-page-content{color:${t.fg};column-fill:auto;overflow:visible;font-size:${ps.font}px;line-height:${ps.line};transition:transform .18s ease}
      #lyra-page-content img{max-width:100%!important;height:auto!important}
      #lyra-page-content a{color:${t.accent}}
      #lyra-page-content h1,#lyra-page-content h2,#lyra-page-content h3{color:${t.fg};line-height:1.35}
      #lyra-page-content p{margin:0 0 1em}
    `;
  }
  function setupPagedPreview(doc) {
    if (!doc || !doc.body) return;
    const body = doc.body;
    // 保留 script/style/link 在本体，其余正文搬进分页容器
    const shell = doc.createElement("div"); shell.id = "lyra-page-shell";
    const page = doc.createElement("div"); page.id = "lyra-page";
    const content = doc.createElement("div"); content.id = "lyra-page-content";
    for (const node of Array.from(body.childNodes)) {
      if (node.nodeType === 1 && /^(SCRIPT|STYLE|LINK|META)$/i.test(node.tagName)) continue;
      content.appendChild(node);
    }
    body.appendChild(shell); shell.appendChild(page); page.appendChild(content);
    applyPageTheme(doc);
    // 等布局
    const cs = doc.defaultView.getComputedStyle(page);
    const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    const padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
    const pageW = Math.max(120, page.clientWidth - padL - padR);
    const pageH = Math.max(120, page.clientHeight - padT - padB);
    const gap = 84;
    content.style.width = pageW + "px";
    content.style.height = pageH + "px";
    content.style.columnWidth = pageW + "px";
    content.style.columnGap = gap + "px";
    content.style.columnFill = "auto";
    // 计算列数（scrollWidth 覆盖所有列）
    void content.offsetWidth;
    const total = Math.max(1, Math.ceil((content.scrollWidth + gap) / (pageW + gap)));
    state.paged = { doc, content, total, page: 0, pageW, pageH, gap };
    goPreviewPage(0);
    doc.addEventListener("click", (event) => {
      if (event.target.closest("a,button,input,select,textarea")) return;
      turnPreviewPage(event.clientX < doc.documentElement.clientWidth / 2 ? -1 : 1);
    }, true);
  }
  function goPreviewPage(n) {
    const p = state.paged; if (!p) return;
    p.page = Math.max(0, Math.min(p.total - 1, n));
    p.content.style.transform = "translateX(" + (-p.page * (p.pageW + p.gap)) + "px)";
    updatePreviewControls();
  }
  function turnPreviewPage(delta) {
    if (!state.paged) return;
    goPreviewPage(state.paged.page + delta);
  }
  function applyPreviewPagination() {
    const frame = $("preview");
    if (!frame || !frame.contentDocument) return;
    const doc = frame.contentDocument;
    if (state.previewMode !== "paged" || state.previewKind !== "html") { state.paged = null; updatePreviewControls(); return; }
    try { setupPagedPreview(doc); } catch (e) { state.paged = null; }
    updatePreviewControls();
  }
  function rerenderPreview() {
    const rel = currentPreviewRel();
    if (rel) renderPreview(rel).catch(() => { });
  }

  async function renderPreview(rel) {
    const token = ++state.previewToken;
    const frame = $("preview");
    const info = $("previewInfo");
    if (!rel || !state.zip) { frame.srcdoc = ""; if (info) info.textContent = ""; return; }
    if (!isHtmlFile(rel)) {
      const entry = state.zip.file(rel);
      if (entry && /\.(png|jpe?g|gif|webp|svg)$/i.test(rel)) {
        const url = await blobUrlFor(rel);
        if (token !== state.previewToken) return;
        state.previewKind = "image";
        frame.srcdoc = '<html><body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="' + url + '" style="max-width:100%;max-height:100vh"></body></html>';
        info.textContent = "图片";
        state.paged = null; updatePreviewControls();
      } else {
        state.previewKind = "source";
        frame.srcdoc = '<html><body style="margin:0;padding:24px;font:14px/1.7 system-ui;color:#555;background:#fff">' + escapeHtml(rel) + '<br>仅源码编辑，无 HTML 预览</body></html>';
        info.textContent = "源码";
        state.paged = null; updatePreviewControls();
      }
      return;
    }
    const text = await entryText(rel);
    const html = await rewriteHtml(text, rel);
    if (token !== state.previewToken) return;
    state.previewKind = "html";
    state.paged = null;
    frame.srcdoc = html;
    info.textContent = "HTML 预览";
    updatePreviewControls();
  }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ---------- load / save ----------
  async function loadBytes(bytes, name, path) {
    state.zip = await JSZip.loadAsync(bytes);
    state.bytes = bytes;
    state.name = name || state.name;
    state.path = path || state.path;
    state.bookHash = await hashBytes(bytes);
    state.draftKey = draftKeyFor(state.name, bytes, state.bookHash);
    clearInterval(state.loadPoller);
    clearTimeout(state.autoSaveTimer);
    state.dirty.clear(); state.current = ""; state.edits.clear(); state.previewTarget = ""; state.deletions.clear(); state.opfPath = "";
    state.cmDocs.clear(); state.binaryDoc = null;
    state.blobCache.forEach((url) => { try { URL.revokeObjectURL(url); } catch { } });
    state.blobCache.clear();
    $("bookName").textContent = state.name + (state.path && state.path !== state.name ? "  ·  " + state.path : "");
    $("dirtyBadge").hidden = true;
    $("saveBtn").disabled = false;
    setEmpty(false);
    renderTree();
    let restoredDraft = false;
    try { restoredDraft = await restoreDraftIfAny(); } catch { }
    const files = listFiles();
    const target = files.find((f) => /\.(x?html?|htm)$/i.test(f)) || files[0];
    if (target) await openEntry(target); else {
      $("currentFile").textContent = "没有文件"; cm.setValue(""); cm.setOption("readOnly", true);
    }
    status(restoredDraft ? "已加载 " + files.length + " 个文件，已恢复未保存草稿" : "已加载 " + files.length + " 个文件");
  }
  async function loadFromHost() {
    setEmpty(false, "正在读取 EPUB…");
    status("正在读取 EPUB…");
    try {
      const res = await callHost("host.workspace.load", state.path ? { path: state.path } : {});
      if (!res || !res.data) throw new Error((res && res.error) || "没有读到 EPUB 数据");
      const bytes = base64ToBytes(res.data);
      await loadBytes(bytes, res.name || state.name, res.path || res.rel || state.path);
    } catch (e) {
      status("打开 EPUB 失败：" + (e && e.message ? e.message : e), true);
      setEmpty(true, "还没有打开 EPUB\n" + (e && e.message ? e.message : e));
    }
  }
  function virtualExists(rel) { return !!rel && !state.deletions.has(rel) && !!state.zip.file(rel); }
  function xmlParseError(text) {
    try {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      const err = doc.getElementsByTagName("parsererror");
      return err && err.length ? (err[0].textContent || "XML 解析失败").slice(0, 220) : "";
    } catch (e) { return String(e && e.message || e); }
  }
  function resolveHrefFile(baseFile, href) {
    const raw = String(href || "").trim();
    if (!raw || /^(?:[a-z]+:|\/\/|data:|#)/i.test(raw)) return "";
    const target = resolvePath(dirOf(baseFile), raw.split("#")[0].split("?")[0]);
    return target;
  }
  async function validateBook() {
    const issues = [];
    const add = (level, msg, file) => { if (issues.length < 240) issues.push({ level, msg, file: file || "" }); };
    if (!state.zip) { add("error", "没有打开 EPUB"); return issues; }
    const mime = await entryText("mimetype");
    if (!mime) add("error", "缺少 mimetype 文件", "mimetype");
    else if (mime.trim() !== "application/epub+zip") add("error", "mimetype 内容不正确（应为 application/epub+zip）", "mimetype");
    const container = await entryText("META-INF/container.xml");
    if (!container) add("error", "缺少 META-INF/container.xml", "META-INF/container.xml");
    const rootMatch = container.match(/<rootfile\b[^>]*full-path=["']([^"']+)["']/i);
    const opfPath = rootMatch ? safeDecode(rootMatch[1]) : await findOpfPath();
    if (!opfPath) add("error", "container.xml 里没有 rootfile full-path");
    const opfText = opfPath ? await entryText(opfPath) : "";
    if (opfPath && !opfText) add("error", "OPF 文件不存在", opfPath);
    let manifest = new Map();
    if (opfText) {
      const xmlErr = xmlParseError(opfText);
      if (xmlErr) add("error", "OPF XML 不合法：" + xmlErr, opfPath);
      try {
        const doc = new DOMParser().parseFromString(opfText, "application/xml");
        const opfDir = dirOf(opfPath);
        for (const item of Array.from(doc.getElementsByTagName("item"))) {
          const id = item.getAttribute("id") || "";
          const href = item.getAttribute("href") || "";
          const target = resolvePath(opfDir, href.split("#")[0]);
          if (id) manifest.set(id, { href, target, attrs: item });
          if (target && !virtualExists(target)) add("error", "manifest 引用的文件不存在：" + target, opfPath);
        }
        const spineEl = doc.getElementsByTagName("spine")[0];
        const itemrefs = spineEl ? Array.from(spineEl.getElementsByTagName("itemref")) : [];
        if (!itemrefs.length) add("error", "OPF 没有 spine 阅读顺序", opfPath);
        for (const ref of itemrefs) {
          const idref = ref.getAttribute("idref") || "";
          if (!manifest.has(idref)) add("error", "spine 引用了不存在的 id：" + idref, opfPath);
          else if (manifest.get(idref).target && !virtualExists(manifest.get(idref).target)) add("error", "spine 章节文件不存在：" + manifest.get(idref).target, opfPath);
        }
      } catch (e) { add("error", "解析 OPF 失败：" + (e && e.message || e), opfPath); }
    }
    // XML/XHTML 合法性
    const files = listFiles();
    for (const rel of files) {
      if (!/\.(x?html?|htm|opf|ncx|xml)$/i.test(rel)) continue;
      const text = await entryText(rel);
      if (!text) continue;
      const err = xmlParseError(text);
      if (err) add(/\.(x?html?|htm)$/i.test(rel) ? "warn" : "error", "XML 不合法：" + err, rel);
    }
    // 资源引用
    for (const rel of files) {
      if (!/\.(x?html?|htm)$/i.test(rel)) continue;
      const text = await entryText(rel);
      if (!text) continue;
      try {
        const doc = new DOMParser().parseFromString(text, "text/html");
        for (const el of Array.from(doc.querySelectorAll("[src]"))) {
          const raw = el.getAttribute("src") || "";
          const target = resolveHrefFile(rel, raw);
          if (target && !virtualExists(target)) add("warn", "引用的资源不存在：" + raw + " → " + target, rel);
        }
        for (const el of Array.from(doc.querySelectorAll("link[href]"))) {
          const raw = el.getAttribute("href") || "";
          const target = resolveHrefFile(rel, raw);
          if (target && !virtualExists(target)) add("warn", "引用的样式/资源不存在：" + raw + " → " + target, rel);
        }
        for (const el of Array.from(doc.querySelectorAll("a[href]"))) {
          const raw = el.getAttribute("href") || "";
          if (!raw || raw.startsWith("#") || /^(?:[a-z]+:|\/\/)/i.test(raw)) continue;
          const target = resolveHrefFile(rel, raw);
          if (target && !virtualExists(target)) add("warn", "链接目标不存在：" + raw + " → " + target, rel);
        }
      } catch { }
    }
    // CSS url() / @import
    for (const rel of files) {
      if (!/\.css$/i.test(rel)) continue;
      const text = await entryText(rel);
      if (!text) continue;
      const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)|@import\s+(?:url\()?['"]?([^'")\s;]+)/gi;
      let m;
      while ((m = re.exec(text))) {
        const raw = m[2] || m[3] || "";
        if (!raw || /^(?:[a-z]+:|\/\/|data:|#)/i.test(raw)) continue;
        const target = resolvePath(dirOf(rel), raw.split("#")[0].split("?")[0]);
        if (target && !virtualExists(target)) add("warn", "CSS 引用的文件不存在：" + raw + " → " + target, rel);
      }
    }
    return issues;
  }
  function closeValidation() { $("validateOverlay").hidden = true; state.validation = null; }
  function renderValidationView() {
    const data = state.validation;
    if (!data) return;
    const issues = data.issues;
    const list = $("validateList");
    list.innerHTML = "";
    const errors = issues.filter((x) => x.level === "error").length;
    const warns = issues.filter((x) => x.level === "warn").length;
    $("validateCount").textContent = errors + " 个错误 · " + warns + " 个警告";
    const summary = document.createElement("div");
    summary.className = "validate-summary";
    const ec = document.createElement("div"); ec.className = "vs-card error"; ec.innerHTML = '<b>' + errors + '</b><span>错误</span>';
    const wc = document.createElement("div"); wc.className = "vs-card warn"; wc.innerHTML = '<b>' + warns + '</b><span>警告</span>';
    const tip = document.createElement("div"); tip.className = "vs-tip"; tip.textContent = errors ? "错误必须处理，否则不建议保存；警告可以确认后继续。" : "没有错误，只有警告；确认后可以继续保存。";
    summary.appendChild(ec); summary.appendChild(wc); summary.appendChild(tip); list.appendChild(summary);
    const filters = document.createElement("div"); filters.className = "validate-filters";
    for (const [key, label, count] of [["all", "全部", issues.length], ["error", "错误", errors], ["warn", "警告", warns]]) {
      const b = document.createElement("button"); b.type = "button"; b.className = "validate-filter" + (data.filter === key ? " active" : "");
      b.textContent = label + " " + count;
      b.addEventListener("click", () => { if (!state.validation) return; state.validation.filter = key; renderValidationView(); });
      filters.appendChild(b);
    }
    list.appendChild(filters);
    const visible = issues.filter((x) => data.filter === "all" || x.level === data.filter);
    if (!visible.length) {
      const d = document.createElement("div"); d.className = "validate-empty"; d.textContent = data.filter === "all" ? "检查通过，没有发现结构问题。" : "这一类没有问题。";
      list.appendChild(d);
    }
    for (const x of visible) {
      const row = document.createElement("div"); row.className = "validate-row " + (x.level === "error" ? "error" : "warn");
      const badge = document.createElement("span"); badge.className = "validate-badge " + (x.level === "error" ? "error" : "warn"); badge.textContent = x.level === "error" ? "错误" : "警告";
      const msg = document.createElement("div"); msg.className = "msg";
      const txt = document.createElement("div"); txt.className = "validate-msg-text"; txt.textContent = x.msg; msg.appendChild(txt);
      if (x.file) { const f = document.createElement("div"); f.className = "file"; f.textContent = x.file; msg.appendChild(f); }
      row.appendChild(badge); row.appendChild(msg); list.appendChild(row);
    }
  }
  function showValidation(issues, onSave) {
    state.validation = { issues, onSave, filter: "all" };
    renderValidationView();
    $("validateSave").hidden = !onSave;
    $("validateSave").textContent = onSave ? "仍然保存" : "";
    $("validateCancel").textContent = onSave ? "取消" : "关闭";
    $("validateOverlay").hidden = false;
  }
  async function runValidationManual() {
    status("正在检查 EPUB 结构…");
    const issues = await validateBook();
    if (!issues.length) { status("检查通过：结构正常"); return; }
    showValidation(issues, null);
  }
  async function writeSaveBackup() {
    if (!state.bytes) return;
    try {
      const rel = (SHELL ? (state.path || state.name) : baseName(state.name || state.path || "book.epub")) + ".bak";
      const data = bytesToBase64(state.bytes);
      if (EMBEDDED) {
        try { window.parent.postMessage({ type: "epub-editor-backup", path: rel, data: data }, "*"); } catch { }
      } else {
        await callHost("host.file.save", { path: rel, data: data });
      }
    } catch { /* 旧宿主不支持 .bak 时不影响保存 */ }
  }
  async function performSave(opts = {}) {
    if (!state.zip) return;
    const auto = !!opts.auto;
    clearTimeout(state.autoSaveTimer);
    $("saveBtn").disabled = true;
    status(auto ? "正在自动保存…" : "正在打包 EPUB…");
    try {
      await writeSaveBackup();
      // 把内存里尚未写回 ZIP 的文本改动落盘；绝不能只打包原始 ZIP
      for (const rel of Array.from(state.dirty)) {
        if (!isTextFile(rel) || !state.zip.file(rel)) continue;
        const text = state.edits.has(rel) ? state.edits.get(rel) : await entryText(rel);
        state.zip.file(rel, text);
      }
      // 重新生成 ZIP，保证 mimetype 是第一个条目且不压缩（EPUB 规范要求）
      const out = new JSZip();
      out.file("mimetype", "application/epub+zip", { compression: "STORE" });
      for (const name of Object.keys(state.zip.files)) {
        if (name === "mimetype") continue;
        const entry = state.zip.files[name];
        if (entry.dir) continue;
        out.file(name, await entry.async("uint8array"), { compression: "DEFLATE" });
      }
      const bytes = await out.generateAsync({ type: "uint8array", mimeType: "application/epub+zip", compression: "DEFLATE" });
      state.bytes = bytes;
      const b64 = bytesToBase64(bytes);
      if (EMBEDDED) {
        const saveId = "epub-save-" + (++state.saveSeq);
        const ack = new Promise((resolve, reject) => {
          savePending.set(saveId, { resolve, reject });
          setTimeout(() => { if (savePending.has(saveId)) { savePending.delete(saveId); reject(new Error("阅读器保存响应超时")); } }, 15000);
        });
        window.parent.postMessage({ type: "epub-editor-save", saveId: saveId, name: state.name, silent: auto, data: bytes.buffer }, "*");
        await ack;
      } else {
        const payload = { data: b64 };
        if (state.path) payload.path = state.path;
        const res = await callHost("host.workspace.save", payload);
        if (!res || res.ok === false) throw new Error((res && res.error) || "宿主保存失败");
      }
      const oldDraftKey = state.draftKey;
      state.dirty.clear();
      state.edits.clear();
      state.deletions.clear();
      state.blobCache.forEach((url) => { try { URL.revokeObjectURL(url); } catch { } });
      state.blobCache.clear();
      if (oldDraftKey) idbDeleteDraft(oldDraftKey);
      state.bookHash = await hashBytes(bytes);
      state.draftKey = draftKeyFor(state.name, bytes, state.bookHash);
      $("dirtyBadge").hidden = true;
      renderTree();
      if (auto) {
        status("已自动保存 " + new Date().toLocaleTimeString());
      } else {
        status("已保存：" + state.name);
        if (state.current && state.zip.file(state.current)) renderPreview(state.previewTarget && isHtmlFile(state.previewTarget) ? state.previewTarget : state.current).catch(() => { });
      }
    } catch (e) {
      status("保存失败：" + (e && e.message ? e.message : e), true);
    } finally {
      $("saveBtn").disabled = !state.zip;
    }
  }
  // ---------- 章节与目录编辑 ----------
  function outlineTitleFromDoc(text) {
    try {
      const doc = new DOMParser().parseFromString(text, "text/html");
      const t = doc.querySelector("title");
      if (t && t.textContent.trim()) return t.textContent.trim();
      const h = doc.querySelector("h1,h2,h3");
      if (h && h.textContent.trim()) return h.textContent.trim().slice(0, 120);
    } catch { }
    return "";
  }
  async function readOutlineData() {
    const opfPath = await findOpfPath();
    if (!opfPath) throw new Error("没有找到 package.opf");
    const opfText = await entryText(opfPath);
    if (!opfText) throw new Error("OPF 内容为空");
    const doc = new DOMParser().parseFromString(opfText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("OPF XML 不合法");
    const opfDir = dirOf(opfPath);
    const manifest = new Map();
    for (const item of Array.from(doc.getElementsByTagName("item"))) {
      const id = item.getAttribute("id") || "";
      const href = item.getAttribute("href") || "";
      if (!id) continue;
      manifest.set(id, { href, target: resolvePath(opfDir, href.split("#")[0]), properties: item.getAttribute("properties") || "", mediaType: item.getAttribute("media-type") || "" });
    }
    const spineEl = doc.getElementsByTagName("spine")[0];
    if (!spineEl) throw new Error("OPF 没有 spine");
    const itemrefs = Array.from(spineEl.getElementsByTagName("itemref"));
    const navItem = Array.from(manifest.values()).find((x) => /\bnav\b/i.test(x.properties)) || Array.from(manifest.values()).find((x) => /(?:^|\/)nav\.x?html$/i.test(x.target));
    const navPath = navItem ? navItem.target : "";
    let navText = navPath && state.zip.file(navPath) ? await entryText(navPath) : "";
    let navDoc = null;
    const navTitles = new Map();
    if (navText) {
      try {
        navDoc = new DOMParser().parseFromString(navText, "application/xhtml+xml");
        if (!navDoc.getElementsByTagName("parsererror").length) {
          for (const a of Array.from(navDoc.getElementsByTagName("a"))) {
            const href = a.getAttribute("href") || "";
            const target = resolvePath(dirOf(navPath), href.split("#")[0]);
            const label = (a.textContent || "").replace(/\s+/g, " ").trim();
            if (target && label && !navTitles.has(target)) navTitles.set(target, label);
          }
        } else navDoc = null;
      } catch { navDoc = null; }
    }
    const rows = [];
    for (const ref of itemrefs) {
      const idref = ref.getAttribute("idref") || "";
      const item = manifest.get(idref);
      const target = item ? item.target : "";
      let title = navTitles.get(target) || "";
      if (!title && target && state.zip.file(target)) title = outlineTitleFromDoc(await entryText(target));
      if (!title) title = target ? baseName(target) : idref;
      rows.push({ idref, target, title, originalTitle: title });
    }
    return { opfPath, opfText, opfDir, manifest, rows, navPath, navText, navDoc, navTitles };
  }
  let outlineData = null;
  let outlineDragIndex = -1;
  function renderOutlineRows() {
    const host = $("outlineList"); host.innerHTML = "";
    if (!outlineData || !outlineData.rows.length) {
      const empty = document.createElement("div"); empty.className = "outline-empty"; empty.textContent = "这本书的 spine 里没有章节"; host.appendChild(empty); return;
    }
    outlineData.rows.forEach((row, index) => {
      const el = document.createElement("div");
      el.className = "outline-row"; el.draggable = true; el.dataset.index = String(index);
      el.innerHTML = '<span class="outline-handle">⋮⋮</span><span></span><input spellcheck="false"><span class="outline-file"></span>';
      const input = el.querySelector("input");
      input.value = row.title;
      input.placeholder = "章节标题";
      input.addEventListener("input", () => { row.title = input.value; });
      el.querySelector(".outline-file").textContent = row.target || row.idref;
      el.querySelector(".outline-file").title = row.target || row.idref;
      el.addEventListener("dragstart", (event) => {
        outlineDragIndex = index; el.classList.add("dragging");
        try { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); } catch { }
      });
      el.addEventListener("dragend", () => { outlineDragIndex = -1; document.querySelectorAll(".outline-row").forEach((x) => x.classList.remove("dragging", "drag-over")); });
      el.addEventListener("dragover", (event) => { event.preventDefault(); el.classList.add("drag-over"); });
      el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
      el.addEventListener("drop", (event) => {
        event.preventDefault(); el.classList.remove("drag-over");
        const from = outlineDragIndex;
        const to = Number(el.dataset.index);
        if (from < 0 || from === to || !outlineData) return;
        const [item] = outlineData.rows.splice(from, 1);
        outlineData.rows.splice(to, 0, item);
        renderOutlineRows();
      });
      host.appendChild(el);
    });
  }
  async function openOutline() {
    if (!state.zip) return;
    try {
      status("正在读取目录…");
      outlineData = await readOutlineData();
      renderOutlineRows();
      $("outlineMeta").textContent = outlineData.rows.length + " 章 · " + outlineData.opfPath;
      $("outlineOverlay").hidden = false;
      status("拖动章节排序，改标题后应用");
    } catch (e) { status("读取目录失败：" + (e && e.message ? e.message : e), true); }
  }
  function closeOutline() { $("outlineOverlay").hidden = true; outlineData = null; }
  async function applyOutline() {
    if (!outlineData) return;
    try {
      const { opfPath, opfText, opfDir, rows, navPath, navText, navDoc } = outlineData;
      // 1. spine itemref 顺序
      const spineMatch = opfText.match(/(<spine\b[^>]*>)([\s\S]*?)(<\/spine>)/i);
      if (!spineMatch) throw new Error("OPF 没有可写的 spine");
      const refs = [];
      const refById = new Map();
      const refRe = /<itemref\b[^>]*\/?>/gi;
      let rm;
      while ((rm = refRe.exec(spineMatch[2]))) {
        const tag = rm[0];
        const idMatch = tag.match(/idref=["']([^"']+)["']/i);
        const id = idMatch ? idMatch[1] : "";
        refs.push(tag);
        if (id) refById.set(id, tag);
      }
      const ordered = [];
      for (const row of rows) if (refById.has(row.idref)) ordered.push(refById.get(row.idref));
      for (const tag of refs) if (!ordered.includes(tag)) ordered.push(tag);
      const nextSpine = spineMatch[1] + "\n" + ordered.map((x) => "  " + x).join("\n") + "\n" + spineMatch[3];
      let nextOpf = opfText.slice(0, spineMatch.index) + nextSpine + opfText.slice(spineMatch.index + spineMatch[0].length);
      markEntryEdited(opfPath, nextOpf);
      // 2. 章节标题（XHTML title + 第一个 h1）
      for (const row of rows) {
        const title = String(row.title || "").trim();
        if (!title || title === row.originalTitle || !row.target || !state.zip.file(row.target)) continue;
        const old = await entryText(row.target);
        let next = old;
        next = next.replace(/<title[^>]*>[\s\S]*?<\/title>/i, "<title>" + xmlEscape(title) + "</title>");
        next = next.replace(/<h1([^>]*)>[\s\S]*?<\/h1>/i, "<h1$1>" + xmlEscape(title) + "</h1>");
        if (next !== old) markEntryEdited(row.target, next);
      }
      // 3. nav 标题 + 顶层顺序
      if (navPath && navDoc) {
        try {
          const navEl = navDoc.getElementsByTagName("nav")[0];
          const ol = navEl ? navEl.getElementsByTagName("ol")[0] : null;
          if (ol) {
            const lis = Array.from(ol.children).filter((x) => x.tagName && x.tagName.toLowerCase() === "li");
            const byTarget = new Map();
            for (const li of lis) {
              const a = li.getElementsByTagName("a")[0];
              if (!a) continue;
              const href = a.getAttribute("href") || "";
              const target = resolvePath(dirOf(navPath), href.split("#")[0]);
              if (target) byTarget.set(target, li);
              const row = rows.find((r) => r.target === target);
              if (row && row.title !== row.originalTitle) a.textContent = row.title;
            }
            const orderedLis = [];
            for (const row of rows) if (byTarget.has(row.target)) orderedLis.push(byTarget.get(row.target));
            for (const li of lis) if (!orderedLis.includes(li)) orderedLis.push(li);
            for (const li of orderedLis) ol.appendChild(li);
          }
          const serializer = new XMLSerializer();
          let nextNav = serializer.serializeToString(navDoc);
          if (/^<\?xml/i.test(navText) && !/^<\?xml/i.test(nextNav)) nextNav = '<?xml version="1.0" encoding="utf-8"?>\n' + nextNav;
          markEntryEdited(navPath, nextNav);
        } catch { }
      }
      closeOutline();
      status("目录与章节标题已应用，保存后写入 EPUB");
      renderPreview(currentPreviewRel()).catch(() => { });
    } catch (e) { status("应用目录失败：" + (e && e.message ? e.message : e), true); }
  }

  // ---------- 全书搜索 / 替换 ----------
  let globalFindData = { matches: [], files: 0, query: "" };
  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function gfRegex() {
    const q = $("gfQuery").value;
    if (!q) return null;
    const flags = "g" + ($("gfCase").checked ? "" : "i");
    try { return $("gfRegex").checked ? new RegExp(q, flags) : new RegExp(escapeRegExp(q), flags); }
    catch (e) { status("正则表达式错误：" + e.message, true); return undefined; }
  }
  function gfSnippet(text, start, end) {
    const lineStart = text.lastIndexOf("\n", start) + 1;
    let lineEnd = text.indexOf("\n", end);
    if (lineEnd < 0) lineEnd = text.length;
    let a = Math.max(lineStart, start - 42), b = Math.min(lineEnd, end + 60);
    let pre = text.slice(a, start), hit = text.slice(start, end), post = text.slice(end, b);
    if (a > lineStart) pre = "…" + pre;
    if (b < lineEnd) post += "…";
    return escapeHtml(pre) + "<mark>" + escapeHtml(hit) + "</mark>" + escapeHtml(post);
  }
  async function runGlobalSearch() {
    const re = gfRegex();
    if (re === null) { status("请输入查找内容", true); return; }
    if (re === undefined) return;
    const files = listFiles().filter((f) => isTextFile(f) && f !== "mimetype");
    const matches = [];
    let hitFiles = 0;
    status("正在全书搜索…");
    for (const file of files) {
      const text = await entryText(file);
      if (!text) continue;
      re.lastIndex = 0;
      let m; let count = 0;
      while ((m = re.exec(text)) && matches.length < 1200) {
        if (m[0] === "") { re.lastIndex++; continue; }
        const line = text.slice(0, m.index).split("\n").length;
        matches.push({ file, start: m.index, end: m.index + m[0].length, line, snippet: gfSnippet(text, m.index, m.index + m[0].length) });
        count++;
        if (count >= 80) break;
      }
      if (count) hitFiles++;
    }
    globalFindData = { matches, files: hitFiles, query: $("gfQuery").value };
    renderGlobalFindResults();
    status(matches.length ? "找到 " + matches.length + " 处" : "没有找到：" + globalFindData.query);
  }
  function renderGlobalFindResults() {
    const host = $("gfResults"); host.innerHTML = "";
    const matches = globalFindData.matches || [];
    $("globalFindCount").textContent = matches.length + " 处 · " + globalFindData.files + " 个文件";
    if (!matches.length) { const d = document.createElement("div"); d.className = "gf-empty"; d.textContent = globalFindData.query ? "没有匹配结果" : "输入内容后点「搜索」"; host.appendChild(d); return; }
    let lastFile = "";
    for (const m of matches) {
      if (m.file !== lastFile) {
        lastFile = m.file;
        const f = document.createElement("div"); f.className = "gf-file"; f.textContent = m.file;
        const n = matches.filter((x) => x.file === m.file).length;
        const c = document.createElement("span"); c.textContent = n + " 处"; f.appendChild(c); host.appendChild(f);
      }
      const row = document.createElement("div"); row.className = "gf-row";
      const line = document.createElement("span"); line.className = "gf-line"; line.textContent = "L" + m.line;
      const sn = document.createElement("span"); sn.className = "gf-snippet"; sn.innerHTML = m.snippet;
      row.appendChild(line); row.appendChild(sn);
      row.title = m.file + ":" + m.line;
      row.addEventListener("click", async () => {
        closeGlobalFind();
        await openEntry(m.file);
        setTimeout(() => {
          try {
            const pos = cm.posFromIndex(m.start);
            cm.setCursor(pos); cm.setSelection(pos, cm.posFromIndex(m.end));
            cm.scrollIntoView(pos, 80); cm.focus();
          } catch { }
        }, 120);
      });
      host.appendChild(row);
    }
  }
  async function replaceAllGlobal() {
    const matches = globalFindData.matches || [];
    if (!matches.length) { status("先搜索再替换", true); return; }
    if (!confirm("将在 " + globalFindData.files + " 个文件中替换 " + matches.length + " 处，确定？")) return;
    const re = gfRegex(); if (!re) return;
    const replacement = $("gfReplace").value;
    const byFile = new Map();
    for (const m of matches) { if (!byFile.has(m.file)) byFile.set(m.file, 0); byFile.set(m.file, byFile.get(m.file) + 1); }
    status("正在替换…");
    for (const file of byFile.keys()) {
      const text = await entryText(file);
      let next;
      if ($("gfRegex").checked) next = text.replace(re, replacement);
      else next = text.replace(re, () => replacement);
      if (next !== text) markEntryEdited(file, next);
    }
    globalFindData.matches = [];
    renderGlobalFindResults();
    closeGlobalFind();
    renderTree();
    refreshDirtyBadge();
    scheduleDraftSave();
    if (currentPreviewRel()) renderPreview(currentPreviewRel()).catch(() => { });
    status("已在 " + byFile.size + " 个文件中替换 " + matches.length + " 处，保存后写入 EPUB");
  }
  function openGlobalFind() {
    if (!state.zip) return;
    $("globalFindOverlay").hidden = false;
    const sel = cm && cm.getSelection(); if (sel && !$("gfQuery").value) $("gfQuery").value = sel;
    $("gfQuery").focus(); $("gfQuery").select();
    renderGlobalFindResults();
  }
  function closeGlobalFind() { $("globalFindOverlay").hidden = true; }

  // ---------- 书籍元数据 ----------
  const DC_NS = "http://purl.org/dc/elements/1.1/";
  function dcGet(metadata, tag) {
    let el = metadata.getElementsByTagNameNS(DC_NS, tag)[0];
    if (!el) el = metadata.getElementsByTagName("dc:" + tag)[0];
    if (!el) el = metadata.getElementsByTagName(tag)[0];
    return el || null;
  }
  function dcSet(doc, metadata, tag, value, removeEmpty) {
    let el = dcGet(metadata, tag);
    if (!el) {
      if (removeEmpty && !value) return;
      el = doc.createElementNS(DC_NS, "dc:" + tag);
      metadata.appendChild(el);
    }
    el.textContent = value || "";
  }
  async function openMetadata() {
    if (!state.zip) return;
    const opfPath = await findOpfPath();
    if (!opfPath) { status("没有找到 OPF", true); return; }
    const opfText = await entryText(opfPath);
    const doc = new DOMParser().parseFromString(opfText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) { status("OPF XML 不合法，无法编辑元数据", true); return; }
    const metadata = doc.getElementsByTagName("metadata")[0];
    if (!metadata) { status("OPF 没有 metadata", true); return; }
    const field = (tag) => { const el = dcGet(metadata, tag); return el ? (el.textContent || "").trim() : ""; };
    $("metaTitle").value = field("title");
    $("metaCreator").value = field("creator");
    $("metaLanguage").value = field("language");
    $("metaPublisher").value = field("publisher");
    $("metaDate").value = field("date");
    $("metaIdentifier").value = field("identifier");
    $("metaDescription").value = field("description");
    $("metaFile").textContent = opfPath;
    $("metaOverlay").hidden = false;
    $("metaTitle").focus();
  }
  function closeMetadata() { $("metaOverlay").hidden = true; }
  async function applyMetadata() {
    const opfPath = await findOpfPath();
    if (!opfPath) return;
    const opfText = await entryText(opfPath);
    const doc = new DOMParser().parseFromString(opfText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) { status("OPF XML 不合法", true); return; }
    const metadata = doc.getElementsByTagName("metadata")[0];
    if (!metadata) { status("OPF 没有 metadata", true); return; }
    dcSet(doc, metadata, "title", $("metaTitle").value.trim());
    dcSet(doc, metadata, "creator", $("metaCreator").value.trim(), true);
    dcSet(doc, metadata, "language", $("metaLanguage").value.trim(), true);
    dcSet(doc, metadata, "publisher", $("metaPublisher").value.trim(), true);
    dcSet(doc, metadata, "date", $("metaDate").value.trim(), true);
    dcSet(doc, metadata, "identifier", $("metaIdentifier").value.trim(), true);
    dcSet(doc, metadata, "description", $("metaDescription").value.trim(), true);
    let next = new XMLSerializer().serializeToString(doc);
    if (/^<\?xml/i.test(opfText) && !/^<\?xml/i.test(next)) next = '<?xml version="1.0" encoding="utf-8"?>\n' + next;
    markEntryEdited(opfPath, next);
    closeMetadata();
    status("书籍信息已应用，保存后写入 OPF");
    scheduleDraftSave();
  }

  // ---------- 图片资源 / 封面 ----------
  let assetSelected = "";
  function imageFiles() {
    return listFiles().filter((f) => /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(f) && !/\.bak$/i.test(f));
  }
  async function renderAssets() {
    const grid = $("assetsGrid"); grid.innerHTML = "";
    const files = imageFiles();
    $("assetsCount").textContent = files.length + " 张图片";
    if (!files.length) { const e = document.createElement("div"); e.className = "assets-empty"; e.textContent = "这本书里没有图片。可以点「导入图片」添加。"; grid.appendChild(e); }
    for (const rel of files) {
      const card = document.createElement("div"); card.className = "asset-card" + (rel === assetSelected ? " selected" : "");
      const thumb = document.createElement("div"); thumb.className = "asset-thumb";
      try {
        const url = await blobUrlFor(rel);
        if (url) { const img = document.createElement("img"); img.src = url; img.alt = ""; img.loading = "lazy"; thumb.appendChild(img); }
      } catch { }
      const name = document.createElement("div"); name.className = "asset-name"; name.textContent = rel;
      const size = document.createElement("small"); size.textContent = extOf(rel).toUpperCase().replace(".", "");
      name.appendChild(size);
      card.appendChild(thumb); card.appendChild(name);
      card.addEventListener("click", () => { assetSelected = rel; renderAssets().catch(() => { }); });
      grid.appendChild(card);
    }
    $("assetInsert").disabled = !assetSelected;
    $("assetCover").disabled = !assetSelected;
  }
  async function openAssets() {
    if (!state.zip) return;
    assetSelected = "";
    $("assetsOverlay").hidden = false;
    await renderAssets();
  }
  function closeAssets() { $("assetsOverlay").hidden = true; }
  async function insertAsset() {
    if (!assetSelected) { status("先选择一张图片", true); return; }
    if (!state.current) { status("先打开一个章节", true); return; }
    const rel = relativeHref(dirOf(state.current), assetSelected);
    const name = baseName(assetSelected);
    if (isHtmlFile(state.current)) {
      cm.replaceSelection('\n<img src="' + rel + '" alt="' + xmlEscape(name) + '" />\n');
    } else if (extOf(state.current) === ".css") {
      cm.replaceSelection('url("' + rel + '")');
    } else {
      status("当前文件不是 HTML/CSS，无法插入图片", true); return;
    }
    closeAssets();
    status("已插入图片：" + rel);
  }
  async function setAssetCover() {
    if (!assetSelected) { status("先选择一张图片", true); return; }
    const opfPath = await findOpfPath();
    if (!opfPath) { status("没有找到 OPF", true); return; }
    const opfText = await entryText(opfPath);
    const doc = new DOMParser().parseFromString(opfText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) { status("OPF XML 不合法", true); return; }
    const manifest = doc.getElementsByTagName("manifest")[0];
    const metadata = doc.getElementsByTagName("metadata")[0];
    if (!manifest) { status("OPF 没有 manifest", true); return; }
    const ns = doc.documentElement.namespaceURI || "http://www.idpf.org/2007/opf";
    const opfDir = dirOf(opfPath);
    const href = relativeHref(opfDir, assetSelected);
    let item = null;
    for (const it of Array.from(manifest.getElementsByTagName("item"))) {
      const h = it.getAttribute("href") || "";
      if (resolvePath(opfDir, h.split("#")[0]) === assetSelected) { item = it; break; }
    }
    let id = "";
    if (item) {
      id = item.getAttribute("id") || "";
      const props = (item.getAttribute("properties") || "").split(/\s+/).filter(Boolean);
      if (!props.includes("cover-image")) props.push("cover-image");
      item.setAttribute("properties", props.join(" "));
    }
    if (!id) {
      let n = 1; do { id = "cover-image" + (n > 1 ? "-" + n : ""); n++; } while (Array.from(manifest.getElementsByTagName("item")).some((x) => x.getAttribute("id") === id));
      item = doc.createElementNS(ns, "item");
      item.setAttribute("id", id); item.setAttribute("href", href); item.setAttribute("media-type", mimeFor(assetSelected));
      item.setAttribute("properties", "cover-image");
      manifest.appendChild(item);
    }
    for (const it of Array.from(manifest.getElementsByTagName("item"))) {
      if (it !== item) {
        const props = (it.getAttribute("properties") || "").split(/\s+/).filter((p) => p && p !== "cover-image");
        if (props.length) it.setAttribute("properties", props.join(" ")); else it.removeAttribute("properties");
      }
    }
    if (metadata) {
      let meta = null;
      for (const m of Array.from(metadata.getElementsByTagName("meta"))) if ((m.getAttribute("name") || "").toLowerCase() === "cover") { meta = m; break; }
      if (!meta) { meta = doc.createElementNS(ns, "meta"); meta.setAttribute("name", "cover"); metadata.appendChild(meta); }
      meta.setAttribute("content", id);
    }
    const guide = doc.getElementsByTagName("guide")[0];
    if (guide) {
      let ref = null;
      for (const r of Array.from(guide.getElementsByTagName("reference"))) if ((r.getAttribute("type") || "").toLowerCase() === "cover") { ref = r; break; }
      if (!ref) { ref = doc.createElementNS(ns, "reference"); ref.setAttribute("type", "cover"); guide.appendChild(ref); }
      ref.setAttribute("href", href); ref.setAttribute("title", "Cover");
    }
    let next = new XMLSerializer().serializeToString(doc);
    if (/^<\?xml/i.test(opfText) && !/^<\?xml/i.test(next)) next = '<?xml version="1.0" encoding="utf-8"?>\n' + next;
    markEntryEdited(opfPath, next);
    closeAssets();
    status("封面已设为 " + assetSelected + "，保存后写入 OPF");
  }
  async function importAssetFiles(fileList) {
    if (!fileList || !fileList.length || !state.zip) return;
    for (const file of Array.from(fileList)) {
      if (!/^image\//i.test(file.type) && !/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(file.name)) continue;
      let name = String(file.name || "image").replace(/[\\/:*?"<>|]/g, "_");
      let rel = "assets/" + name;
      let n = 2;
      while (state.zip.file(rel)) { const ext = extOf(name); rel = "assets/" + name.slice(0, name.length - ext.length) + "-" + n + ext; n++; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      state.zip.file(rel, bytes);
      state.dirty.add(rel);
      $("dirtyBadge").hidden = false;
      refreshDirtyBadge();
      renderTree();
      status("已导入 " + rel + "，保存后写入 EPUB");
    }
    await renderAssets();
  }
  async function saveBook() {
    if (!state.zip) return;
    if (!state.dirty.size && !state.deletions.size) { status("没有需要保存的修改"); return; }
    if (state.saving) return;
    clearTimeout(state.autoSaveTimer);
    state.saving = true;
    try {
      status("正在检查结构…");
      const issues = await validateBook();
      if (issues.length) {
        showValidation(issues, () => { closeValidation(); performSave(); });
        return;
      }
      await performSave();
    } finally { state.saving = false; }
  }
  function downloadBook() {
    if (!state.zip) return;
    state.zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" }).then((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = state.name || "book.epub";
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  }

  // ---------- 新建 / 删除文件 ----------
  async function createChapter() {
    if (!state.zip) return;
    const count = listFiles().filter((f) => /\.(x?html?|htm)$/i.test(f)).length + 1;
    const title = prompt("新章节标题", "第 " + count + " 章");
    if (title == null) return;
    const cleanTitle = String(title).trim() || "第 " + count + " 章";
    const opfPath = await findOpfPath();
    const contentDir = opfPath ? dirOf(opfPath) : "";
    const stem = "chapter-" + count;
    let rel = (contentDir ? contentDir + "/" : "") + stem + ".xhtml";
    let i = count;
    while (state.zip.file(rel)) { i++; rel = (contentDir ? contentDir + "/" : "") + "chapter-" + i + ".xhtml"; }
    const doc = '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>' + xmlEscape(cleanTitle) + '</title></head>\n<body>\n<h1>' + xmlEscape(cleanTitle) + '</h1>\n<p></p>\n</body>\n</html>\n';
    state.zip.file(rel, doc);
    markEntryEdited(rel, doc);
    if (!opfPath) {
      status("已新建 " + rel + "（没有找到 OPF，未加入目录）");
      await openEntry(rel);
      renderTree();
      return;
    }
    const opfText = await entryText(opfPath);
    let id = stem.replace(/[^\w-]/g, "_");
    while (new RegExp('id=["\']' + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '["\']').test(opfText)) id += "_x";
    const href = relativeHref(contentDir, rel);
    let nextOpf = opfText;
    if (/<\/manifest>/i.test(nextOpf)) nextOpf = nextOpf.replace(/<\/manifest>/i, '  <item id="' + id + '" href="' + xmlEscape(href) + '" media-type="application/xhtml+xml"/>\n</manifest>');
    if (/<\/spine>/i.test(nextOpf)) nextOpf = nextOpf.replace(/<\/spine>/i, '  <itemref idref="' + id + '"/>\n</spine>');
    markEntryEdited(opfPath, nextOpf);
    // 尝试更新 EPUB3 nav
    const navPath = findNavPath(nextOpf, contentDir);
    if (navPath) {

      if (state.zip.file(navPath)) {
        let navText = await entryText(navPath);
        const navHref = relativeHref(dirOf(navPath), rel);
        const li = '  <li><a href="' + xmlEscape(navHref) + '">' + xmlEscape(cleanTitle) + '</a></li>';
        if (/<\/ol>/i.test(navText)) navText = navText.replace(/<\/ol>/i, li + "\n</ol>");
        markEntryEdited(navPath, navText);
      }
    }
    await openEntry(rel);
    renderTree();
    status("已新建章节 " + cleanTitle + "（已加入 OPF 与目录，保存后写入 EPUB）");
  }
  function updateChapterButtons() {
    const isHtml = !!state.current && isHtmlFile(state.current);
    if ($("splitChapterBtn")) $("splitChapterBtn").disabled = !isHtml;
    if ($("mergeChapterBtn")) $("mergeChapterBtn").disabled = !isHtml;
  }
  function chapterBodyParts(text) {
    const open = /<body\b[^>]*>/i.exec(text);
    const close = /<\/body\s*>/i.exec(text);
    if (!open || !close || close.index < open.index) return null;
    const start = open.index + open[0].length;
    return { start, end: close.index, prefix: text.slice(0, start), suffix: text.slice(close.index) };
  }
  function replaceHeadTitle(text, title) {
    if (/<title[^>]*>[\s\S]*?<\/title>/i.test(text)) return text.replace(/<title[^>]*>[\s\S]*?<\/title>/i, "<title>" + xmlEscape(title) + "</title>");
    return text;
  }
  async function spineChapterFiles() {
    const opfPath = await findOpfPath();
    if (!opfPath) return { opfPath: "", files: [], targets: [], ids: [], opfText: "" };
    const opfText = await entryText(opfPath);
    const doc = new DOMParser().parseFromString(opfText, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return { opfPath, files: [], targets: [], ids: [], opfText };
    const opfDir = dirOf(opfPath);
    const manifest = new Map();
    for (const item of Array.from(doc.getElementsByTagName("item"))) {
      const id = item.getAttribute("id") || "";
      const href = item.getAttribute("href") || "";
      if (id) manifest.set(id, { href, target: resolvePath(opfDir, href.split("#")[0]) });
    }
    const spine = doc.getElementsByTagName("spine")[0];
    const ids = spine ? Array.from(spine.getElementsByTagName("itemref")).map((x) => x.getAttribute("idref") || "") : [];
    const targets = ids.map((id) => manifest.get(id)?.target || "");
    return { opfPath, files: targets, targets, ids, opfText, manifest, opfDir };
  }
  async function splitChapterAtCursor() {
    if (!state.current || !isHtmlFile(state.current)) { status("先打开一个 XHTML 章节", true); return; }
    const cursor = cm.indexFromPos(cm.getCursor());
    const text = await entryText(state.current);
    const body = chapterBodyParts(text);
    if (!body) { status("找不到 <body>，无法拆分", true); return; }
    if (cursor <= body.start || cursor >= body.end) { status("光标需要放在正文中间", true); return; }
    const before = text.slice(body.start, cursor);
    const blockRe = /<\/(?:p|div|h[1-6]|section|article|li|blockquote|pre|table|tr|td)\s*>/gi;
    let m; let splitRel = 0;
    while ((m = blockRe.exec(before))) splitRel = m.index + m[0].length;
    if (!splitRel) { status("光标前没有完整的段落/块级元素，先把光标放到段落之后", true); return; }
    const splitPos = body.start + splitRel;
    const part1 = text.slice(body.start, splitPos), part2 = text.slice(splitPos, body.end);
    if (!part1.trim() || !part2.trim()) { status("拆分后至少有一半是空的，换个位置再试", true); return; }
    const oldTitle = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || baseName(state.current)).replace(/<[^>]+>/g, "").trim();
    const newTitle = prompt("拆分出的新章节标题", oldTitle + " · 下");
    if (newTitle == null) return;
    const cleanTitle = String(newTitle).trim() || (oldTitle + " · 下");
    const opfPath = await findOpfPath();
    if (!opfPath) { status("没有找到 OPF", true); return; }
    const opfText = await entryText(opfPath);
    const opfDir = dirOf(opfPath);
    const spine = await spineChapterFiles();
    const idx = spine.targets.indexOf(state.current);
    if (idx < 0) { status("当前章节不在 spine 中，无法插入新章节", true); return; }
    const currentId = spine.ids[idx];
    const stem = baseName(state.current).replace(/\.[^.]+$/, "");
    // 命名刻意用字母后缀（c1 -> c1b），确保按文件名排序时下半章在上半章之后
    const dir = dirOf(state.current) ? dirOf(state.current) + "/" : "";
    const ext = extOf(state.current) || ".xhtml";
    let suffix = "b";
    let newRel = dir + stem + suffix + ext;
    for (let i = 2; state.zip.file(newRel) && i < 200; i++) {
      suffix = String.fromCharCode(97 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : "");
      newRel = dir + stem + suffix + ext;
    }
    let newId = (stem + suffix).replace(/[^\w-]/g, "_");
    while (spine.ids.includes(newId)) newId += "_x";
    const newText = replaceHeadTitle(text.slice(0, body.start) + part2 + text.slice(body.end), cleanTitle);
    state.zip.file(newRel, newText);
    markEntryEdited(newRel, newText);
    markEntryEdited(state.current, text.slice(0, body.start) + part1 + text.slice(body.end));
    const newHref = relativeHref(opfDir, newRel);
    const itemRe = new RegExp('<item\\b[^>]*href=["\']' + relativeHref(opfDir, state.current).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '["\'][^>]*>', "i");
    const im = opfText.match(itemRe);
    if (!im) { status("OPF 里找不到当前章节 manifest，无法插入", true); return; }
    let nextOpf = opfText.slice(0, im.index) + im[0] + '\n  <item id="' + newId + '" href="' + xmlEscape(newHref) + '" media-type="application/xhtml+xml"/>' + opfText.slice(im.index + im[0].length);
    const refRe = new RegExp('<itemref\\b[^>]*idref=["\']' + currentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '["\'][^>]*>', "i");
    const rm = nextOpf.match(refRe);
    if (rm) nextOpf = nextOpf.slice(0, rm.index) + rm[0] + '\n  <itemref idref="' + newId + '"/>' + nextOpf.slice(rm.index + rm[0].length);
    markEntryEdited(opfPath, nextOpf);
    const navPath = findNavPath(nextOpf, opfDir);
    if (navPath) {
      if (state.zip.file(navPath)) {
        const navText = await entryText(navPath);
        const curHref = relativeHref(dirOf(navPath), state.current);
        const newNavHref = relativeHref(dirOf(navPath), newRel);
        const esc = curHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const liRe = new RegExp('(<li\\b[^>]*>\\s*<a\\b[^>]*href=["\']' + esc + '["\'][^>]*>[\\s\\S]*?</a>\\s*</li>)', "i");
        const li = liRe.exec(navText);
        if (li) markEntryEdited(navPath, navText.slice(0, li.index) + li[1] + '\n  <li><a href="' + xmlEscape(newNavHref) + '">' + xmlEscape(cleanTitle) + '</a></li>' + navText.slice(li.index + li[1].length));
      }
    }
    renderTree();
    updateChapterButtons();
    await openEntry(newRel);
    status("已拆分为「" + newRel + "」，保存后写入 EPUB");
  }
  async function mergeNextChapter() {
    if (!state.current || !isHtmlFile(state.current)) { status("先打开一个 XHTML 章节", true); return; }
    const spine = await spineChapterFiles();
    const idx = spine.targets.indexOf(state.current);
    if (idx < 0) { status("当前章节不在 spine 中", true); return; }
    const nextRel = spine.targets[idx + 1];
    if (!nextRel || !state.zip.file(nextRel)) { status("当前章节已经是最后一章", true); return; }
    if (!isHtmlFile(nextRel)) { status("下一章不是 XHTML，无法合并", true); return; }
    const curText = await entryText(state.current);
    const nextText = await entryText(nextRel);
    const a = chapterBodyParts(curText), b = chapterBodyParts(nextText);
    if (!a || !b) { status("章节缺少 <body>，无法合并", true); return; }
    if (!confirm("把「" + nextRel + "」合并到当前章节，并删除下一章？")) return;
    const merged = curText.slice(0, a.start) + curText.slice(a.start, a.end).replace(/\s+$/, "") + "\n" + nextText.slice(b.start, b.end).trim() + "\n" + curText.slice(a.end);
    markEntryEdited(state.current, merged);
    await deleteEntry(nextRel, { skipConfirm: true });
    updateChapterButtons();
    status("已合并下一章：" + nextRel + "，保存后写入 EPUB");
  }

  async function deleteEntry(rel, opts = {}) {
    if (!state.zip || !rel) return;
    const opfPath = await findOpfPath();
    const keep = rel === "mimetype" || /^META-INF\/container\.xml$/i.test(rel) || (opfPath && rel === opfPath);
    if (keep) { status("不能删除 EPUB 必需文件：" + rel, true); return; }
    if (!opts.skipConfirm && !confirm("从整本书删除 " + rel + "？\n会尝试同步清理 OPF/目录引用。")) return;
    state.zip.remove(rel);
    state.edits.delete(rel); state.dirty.delete(rel); state.deletions.add(rel);
    state.cmDocs.delete(rel);
    if (opfPath) {
      const opfText = await entryText(opfPath);
      const opfDir = dirOf(opfPath);
      const relHref = relativeHref(opfDir, rel);
      const esc = relHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const itemRe = new RegExp('<item\\b[^>]*href=["\']' + esc + '["\'][^>]*>', "i");
      const im = opfText.match(itemRe);
      let id = "";
      if (im) { const idm = im[0].match(/id=["']([^"']+)["']/i); id = idm ? idm[1] : ""; }
      let nextOpf = opfText.replace(itemRe, "");
      if (id) nextOpf = nextOpf.replace(new RegExp('<itemref\\b[^>]*idref=["\']' + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '["\'][^>]*>', "i"), "");
      markEntryEdited(opfPath, nextOpf);
      const navPath = findNavPath(nextOpf, opfDir);
      if (navPath) {
        if (state.zip.file(navPath)) {
          const navText = await entryText(navPath);
          const navHref = relativeHref(dirOf(navPath), rel);
          const esc2 = navHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const nextNav = navText.replace(new RegExp('<li\\b[^>]*>\\s*<a\\b[^>]*href=["\']' + esc2 + '["\'][^>]*>[\\s\\S]*?</a>\\s*</li>', "i"), "");
          markEntryEdited(navPath, nextNav);
        }
      }
    }
    refreshDirtyBadge();
    scheduleDraftSave();
    scheduleAutoSave();
    if (state.current === rel) {
      const next = listFiles().find((f) => /\.(x?html?|htm)$/i.test(f)) || listFiles()[0];
      if (next) await openEntry(next);
    }
    renderTree();
    status("已从工作副本删除 " + rel + "，保存后写入 EPUB");
  }

  // ---------- embedded protocol ----------
  window.addEventListener("message", (event) => {
    const d = event.data || {};
    if (d.type === "epub-editor-load" && d.data) {
      try {
        state.loadToken = d.token || "";
        const bytes = d.data instanceof ArrayBuffer ? new Uint8Array(d.data) : d.data instanceof Uint8Array ? d.data : base64ToBytes(d.data);
        loadBytes(bytes, d.name, "").then(() => {
          clearInterval(state.loadPoller);
          try { window.parent.postMessage({ type: "epub-editor-loaded", ok: true, token: state.loadToken }, "*"); } catch { }
        }).catch((e) => {
          status("加载失败：" + (e && e.message ? e.message : e), true);
          try { window.parent.postMessage({ type: "epub-editor-loaded", ok: false, token: state.loadToken, error: String(e && e.message || e) }, "*"); } catch { }
        });
      } catch (e) {
        status("加载失败：" + (e && e.message ? e.message : e), true);
        try { window.parent.postMessage({ type: "epub-editor-loaded", ok: false, error: String(e && e.message || e) }, "*"); } catch { }
      }
      return;
    }
    if (d.type === "epub-editor-saved") {
      const p = savePending.get(d.saveId);
      if (p) { savePending.delete(d.saveId); if (d.ok === false) p.reject(new Error(d.error || "保存失败")); else p.resolve(); }
      return;
    }
    if (d.type === "epub-preview-open" && d.path && state.zip && state.zip.file(d.path)) {
      openEntry(d.path).catch((e) => status(e.message, true));
      return;
    }
    if (d.type === "shell-host-result") {
      const p = shellPending.get(d.requestId);
      if (!p) return;
      shellPending.delete(d.requestId); d.ok === false ? p.reject(new Error(d.error || "外壳操作失败")) : p.resolve(d);
    }
  });

  // ---------- boot ----------
  // ---------- 查找 / 替换 ----------
  function findQuery() { return $("findInput") ? $("findInput").value : ""; }
  function allMatches(query) {
    const out = [];
    if (!cm || !query) return out;
    const text = cm.getValue();
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    let at = 0;
    while (at <= lower.length) {
      const hit = lower.indexOf(q, at);
      if (hit < 0) break;
      out.push({ from: cm.posFromIndex(hit), to: cm.posFromIndex(hit + query.length) });
      at = hit + Math.max(1, q.length);
    }
    return out;
  }
  function updateFindCount(matches) {
    const el = $("findCount");
    if (!el) return;
    if (!matches.length) { el.textContent = "0/0"; return; }
    const sel = cm.listSelections()[0];
    const at = matches.findIndex((m) => CodeMirror.cmpPos(m.from, sel.anchor) === 0 && CodeMirror.cmpPos(m.to, sel.head) === 0);
    el.textContent = (at >= 0 ? at + 1 : 1) + "/" + matches.length;
  }
  function selectMatch(match) {
    if (!match) return;
    cm.setSelection(match.from, match.to);
    cm.scrollIntoView({ from: match.from, to: match.to }, 80);
    updateFindCount(allMatches(findQuery()));
  }
  function findNext(backward) {
    const q = findQuery();
    if (!q) return;
    const matches = allMatches(q);
    updateFindCount(matches);
    if (!matches.length) { status("没有找到：" + q); return; }
    const sel = cm.listSelections()[0];
    const curPos = sel.head;
    let idx;
    if (backward) {
      idx = -1;
      for (let i = 0; i < matches.length; i++) if (CodeMirror.cmpPos(matches[i].from, curPos) < 0) idx = i;
      if (idx < 0) idx = matches.length - 1;
    } else {
      idx = 0;
      for (let i = 0; i < matches.length; i++) if (CodeMirror.cmpPos(matches[i].from, curPos) > 0) { idx = i; break; }
      if (CodeMirror.cmpPos(matches[idx].from, curPos) <= 0 && idx === 0) idx = 0;
    }
    selectMatch(matches[idx]);
  }
  function openFind() {
    const bar = $("findBar");
    bar.hidden = false;
    const sel = cm.getSelection();
    if (sel && sel.length < 160) $("findInput").value = sel;
    $("findInput").focus(); $("findInput").select();
    const q = findQuery();
    if (q) updateFindCount(allMatches(q));
  }
  function closeFind() { $("findBar").hidden = true; cm.focus(); }
  function replaceOne() {
    const q = findQuery();
    if (!q) return;
    const sel = cm.getSelection();
    if (sel !== q) findNext(false);
    if (cm.getSelection() === q) { cm.replaceSelection($("replaceInput").value, "around"); findNext(false); }
  }
  function replaceAll() {
    const q = findQuery();
    if (!q) return;
    const matches = allMatches(q);
    if (!matches.length) { status("没有找到：" + q); return; }
    for (let i = matches.length - 1; i >= 0; i--) cm.replaceRange($("replaceInput").value, matches[i].from, matches[i].to);
    status("已替换 " + matches.length + " 处：" + q);
    updateFindCount(allMatches(q));
  }

  function bind() {
    $("preview").addEventListener("load", () => applyPreviewPagination());
    $("followReader").addEventListener("change", () => {
      state.followReader = $("followReader").checked;
      try { localStorage.setItem("lyra.epubEditor.followReader", state.followReader ? "1" : "0"); } catch { }
      updatePreviewControls();
      if (state.previewMode === "paged") rerenderPreview();
    });
    $("flowBtn").addEventListener("click", () => { state.previewMode = "flow"; updatePreviewControls(); rerenderPreview(); try { localStorage.setItem("lyra.epubEditor.previewMode", "flow"); } catch { } });
    $("pagedBtn").addEventListener("click", () => { state.previewMode = "paged"; updatePreviewControls(); rerenderPreview(); try { localStorage.setItem("lyra.epubEditor.previewMode", "paged"); } catch { } });
    $("pagePrev").addEventListener("click", () => turnPreviewPage(-1));
    $("pageNext").addEventListener("click", () => turnPreviewPage(1));
    $("previewTheme").addEventListener("change", () => { state.followReader = false; try { localStorage.setItem("lyra.epubEditor.followReader", "0"); } catch { } state.previewTheme = $("previewTheme").value; updatePreviewControls(); if (state.previewMode === "paged") rerenderPreview(); try { localStorage.setItem("lyra.epubEditor.previewTheme", state.previewTheme); } catch { } });
    $("fontDown").addEventListener("click", () => { state.followReader = false; try { localStorage.setItem("lyra.epubEditor.followReader", "0"); } catch { } state.previewFont = Math.max(14, state.previewFont - 1); updatePreviewControls(); if (state.previewMode === "paged") rerenderPreview(); try { localStorage.setItem("lyra.epubEditor.previewFont", String(state.previewFont)); } catch { } });
    $("fontUp").addEventListener("click", () => { state.followReader = false; try { localStorage.setItem("lyra.epubEditor.followReader", "0"); } catch { } state.previewFont = Math.min(32, state.previewFont + 1); updatePreviewControls(); if (state.previewMode === "paged") rerenderPreview(); try { localStorage.setItem("lyra.epubEditor.previewFont", String(state.previewFont)); } catch { } });
    try {
      state.previewMode = localStorage.getItem("lyra.epubEditor.previewMode") === "paged" ? "paged" : "flow";
      state.previewTheme = localStorage.getItem("lyra.epubEditor.previewTheme") || "sepia";
      state.previewFont = Math.max(14, Math.min(32, Number(localStorage.getItem("lyra.epubEditor.previewFont")) || 20));
    } catch { }
    updatePreviewControls();
    $("themeSelect").addEventListener("change", () => applyTheme($("themeSelect").value));
    try { applyWrap(localStorage.getItem("lyra.epubEditor.wrap") !== "0"); } catch { applyWrap(true); }
    try {
      const rawAuto = localStorage.getItem("lyra.epubEditor.autoSave");
      let savedAuto = rawAuto === null ? 5000 : Number(rawAuto);
      if (localStorage.getItem("lyra.epubEditor.autoSaveV2") !== "1") {
        if (!Number.isFinite(savedAuto) || savedAuto >= 10000) savedAuto = 5000;
        localStorage.setItem("lyra.epubEditor.autoSaveV2", "1");
      }
      state.autoSaveMs = Number.isFinite(savedAuto) && savedAuto >= 0 ? savedAuto : 5000;
    } catch { state.autoSaveMs = 5000; }
    $("autoSaveSelect").value = String(state.autoSaveMs);
    $("autoSaveSelect").addEventListener("change", () => setAutoSave(Number($("autoSaveSelect").value)));
    $("wrapBtn").addEventListener("click", () => applyWrap(!state.wrap));
    $("formatBtn").addEventListener("click", () => formatCurrentFile());
    try { applyTheme(localStorage.getItem("lyra.epubEditor.theme") || "lyra"); } catch { applyTheme("lyra"); }
    $("saveBtn").addEventListener("click", () => saveBook());
    if (EMBEDDED) {
      $("backBtn").hidden = false;
      $("backBtn").addEventListener("click", () => {
        if (state.dirty.size && !confirm("有未保存修改，返回阅读会丢失这些修改，确定？")) return;
        try { window.parent.postMessage({ type: "epub-editor-close" }, "*"); } catch { }
      });
    }
    $("filter").addEventListener("input", () => { state.treeFilter = String($("filter").value || "").trim().toLowerCase(); renderTree(); });
    $("newChapterBtn").addEventListener("click", () => createChapter().catch((e) => status(e.message, true)));
    $("splitChapterBtn").addEventListener("click", () => splitChapterAtCursor().catch((e) => status(e.message, true)));
    $("mergeChapterBtn").addEventListener("click", () => mergeNextChapter().catch((e) => status(e.message, true)));
    $("findBtn").addEventListener("click", () => openFind());
    $("validateBtn").addEventListener("click", () => runValidationManual().catch((e) => status(e.message, true)));
    $("outlineBtn").addEventListener("click", () => openOutline().catch((e) => status(e.message, true)));
    $("globalFindBtn").addEventListener("click", () => openGlobalFind());
    $("metaBtn").addEventListener("click", () => openMetadata().catch((e) => status(e.message, true)));
    $("assetsBtn").addEventListener("click", () => openAssets().catch((e) => status(e.message, true)));
    $("assetsClose").addEventListener("click", closeAssets);
    $("assetInsert").addEventListener("click", () => insertAsset().catch((e) => status(e.message, true)));
    $("assetCover").addEventListener("click", () => setAssetCover().catch((e) => status(e.message, true)));
    $("assetFiles").addEventListener("change", () => { importAssetFiles($("assetFiles").files).catch((e) => status(e.message, true)); $("assetFiles").value = ""; });
    $("metaCancel").addEventListener("click", closeMetadata);
    $("metaApply").addEventListener("click", () => applyMetadata().catch((e) => status(e.message, true)));
    $("gfSearch").addEventListener("click", () => runGlobalSearch().catch((e) => status(e.message, true)));
    $("gfReplaceAll").addEventListener("click", () => replaceAllGlobal().catch((e) => status(e.message, true)));
    $("gfClose").addEventListener("click", closeGlobalFind);
    $("gfQuery").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); runGlobalSearch().catch((e) => status(e.message, true)); } });
    $("gfRegex").addEventListener("change", () => { globalFindData = { matches: [], files: 0, query: "" }; renderGlobalFindResults(); });
    $("outlineCancel").addEventListener("click", closeOutline);
    $("outlineApply").addEventListener("click", () => applyOutline().catch((e) => status(e.message, true)));
    $("validateCancel").addEventListener("click", closeValidation);
    $("validateSave").addEventListener("click", () => {
      const cb = state.validation && state.validation.onSave;
      closeValidation();
      if (cb) cb();
    });
    $("findClose").addEventListener("click", closeFind);
    $("findNext").addEventListener("click", () => findNext(false));
    $("findPrev").addEventListener("click", () => findNext(true));
    $("replaceOne").addEventListener("click", replaceOne);
    $("replaceAll").addEventListener("click", replaceAll);
    $("findInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); findNext(event.shiftKey); }
      if (event.key === "Escape") { event.preventDefault(); closeFind(); }
    });
    $("replaceInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); replaceOne(); }
    });
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); openFind(); }
      if (event.key === "Escape" && !$("findBar").hidden) closeFind();
    });
    $("reloadBtn").addEventListener("click", () => { if (state.dirty.size && !confirm("有未保存修改，确定重新加载？")) return; loadFromHost(); });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !$("assetsOverlay").hidden) { closeAssets(); return; }
      if (event.key === "Escape" && !$("metaOverlay").hidden) { closeMetadata(); return; }
      if (event.key === "Escape" && !$("globalFindOverlay").hidden) { closeGlobalFind(); return; }
      if (event.key === "Escape" && !$("outlineOverlay").hidden) { closeOutline(); return; }
      if (event.key === "Escape" && !$("validateOverlay").hidden) { closeValidation(); return; }
      if (state.previewMode === "paged" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        const tag = (event.target && event.target.tagName || "").toLowerCase();
        if (!/input|textarea|select/.test(tag)) { event.preventDefault(); turnPreviewPage(event.key === "ArrowLeft" ? -1 : 1); return; }
      }
      if (event.altKey && event.key.toLowerCase() === "z") { event.preventDefault(); applyWrap(!state.wrap); return; }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "m") { event.preventDefault(); openMetadata().catch((e) => status(e.message, true)); return; }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "i") { event.preventDefault(); openAssets().catch((e) => status(e.message, true)); return; }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); openGlobalFind(); return; }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "o") { event.preventDefault(); openOutline().catch((e) => status(e.message, true)); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveBook(); return; }
      if (EMBEDDED && event.key === "Escape" && $("findBar").hidden) {
        if (state.dirty.size && !confirm("有未保存修改，返回阅读会丢失这些修改，确定？")) return;
        try { window.parent.postMessage({ type: "epub-editor-close" }, "*"); } catch { }
      }
    });
    window.addEventListener("resize", () => { if (state.previewMode === "paged") { clearTimeout(state.previewTimer); state.previewTimer = setTimeout(rerenderPreview, 220); } });
    window.addEventListener("beforeunload", (event) => { if (state.dirty.size) { event.preventDefault(); event.returnValue = ""; } });
    const empty = $("empty");
    const input = document.createElement("input"); input.type = "file"; input.accept = ".epub"; input.hidden = true;
    document.body.appendChild(input);
    input.addEventListener("change", async () => { const f = input.files && input.files[0]; if (!f) return; loadBytes(new Uint8Array(await f.arrayBuffer()), f.name, "").catch((e) => status(e.message, true)); });
    empty.addEventListener("click", (event) => { if (event.target === empty || event.target.closest("button")) input.click(); });
    empty.innerHTML = '<div>还没有打开 EPUB<br><button class="primary" type="button">选择 EPUB</button></div>';
  }
  function toggleEpubComment() {
    const sel = cm.getSelection();
    const ext = extOf(state.current);
    const wrap = ext === ".css" ? ["/* ", " */"] : (ext === ".js" || ext === ".mjs") ? ["// ", ""] : ["<!-- ", " -->"];
    if (sel) {
      const t = sel.trim();
      if (t.startsWith("<!--") && t.endsWith("-->")) cm.replaceSelection(t.slice(4, -3).trim());
      else if (t.startsWith("/*") && t.endsWith("*/")) cm.replaceSelection(t.slice(2, -2).trim());
      else cm.replaceSelection(wrap[0] + sel + wrap[1]);
      return;
    }
    const cur = cm.getCursor();
    const line = cm.getLine(cur.line);
    const indent = (line.match(/^\s*/) || [""])[0];
    const body = line.slice(indent.length);
    if (wrap[0] === "// ") {
      if (/^\s*\/\//.test(body)) cm.replaceRange(body.replace(/^\s*\/\/\s?/, ""), { line: cur.line, ch: indent.length }, { line: cur.line, ch: line.length });
      else cm.replaceRange("// " + body, { line: cur.line, ch: indent.length }, { line: cur.line, ch: line.length });
    } else cm.replaceRange(wrap[0] + body + wrap[1], { line: cur.line, ch: indent.length }, { line: cur.line, ch: line.length });
  }
  function schedulePreviewRefresh() {
    clearTimeout(state.previewTimer);
    state.previewTimer = setTimeout(() => {
      if (!state.zip) return;
      const rel = (extOf(state.current) === ".css" && state.previewTarget && state.zip.file(state.previewTarget))
        ? state.previewTarget : state.current;
      if (rel) renderPreview(rel).catch(() => { });
    }, 260);
  }
  // ---------- 源码格式化 / 行编辑 ----------
  function formatMarkupText(text) {
    if (/<(pre|textarea)\b/i.test(text)) return { ok: false, error: "包含 <pre>/<textarea>，为避免改坏预格式内容，暂不自动格式化" };
    if (/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/i.test(text)) return { ok: false, error: "包含内联 <script>/<style>，暂不自动格式化" };
    const inline = new Set(["a","abbr","b","bdi","bdo","br","cite","code","data","dfn","em","i","img","kbd","mark","q","rp","rt","ruby","s","samp","small","span","strong","sub","sup","time","u","var","wbr"]);
    const voidTags = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
    const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/gi;
    const out = [];
    let depth = 0, buffer = "";
    const indent = () => "  ".repeat(Math.max(0, depth));
    const flush = () => {
      const v = buffer.replace(/\s+/g, " ").trim();
      if (v) out.push(indent() + v);
      buffer = "";
    };
    let m;
    while ((m = re.exec(text))) {
      const tok = m[0];
      if (tok.startsWith("<!--") || tok.startsWith("<![CDATA[") || tok.startsWith("<?") || /^<!DOCTYPE/i.test(tok)) {
        flush(); out.push(indent() + tok.trim());
        continue;
      }
      if (tok.startsWith("<")) {
        const close = /^<\//.test(tok);
        const nameMatch = tok.match(/^<\/?\s*([A-Za-z][\w:.-]*)/);
        const lname = nameMatch ? nameMatch[1].toLowerCase().split(":").pop() : "";
        const selfClose = /\/\s*>$/.test(tok);
        if (close) {
          flush(); depth = Math.max(0, depth - 1); out.push(indent() + tok.trim());
        } else if (inline.has(lname) && !voidTags.has(lname)) {
          buffer += tok;
        } else if (voidTags.has(lname) || selfClose) {
          flush(); out.push(indent() + tok.trim());
        } else {
          flush(); out.push(indent() + tok.trim());
          depth++;
        }
      } else {
        buffer += tok;
      }
    }
    flush();
    return { ok: true, text: out.join("\n") + (text.endsWith("\n") ? "\n" : "") };
  }
  function formatCssText(text) {
    let out = [], depth = 0, buf = "", i = 0, paren = 0;
    const indent = () => "  ".repeat(Math.max(0, depth));
    const flush = (suffix) => {
      const v = buf.replace(/\s+/g, " ").trim();
      if (v) out.push(indent() + v + (suffix || ""));
      buf = "";
    };
    while (i < text.length) {
      const ch = text[i], next = text[i + 1];
      if (ch === "/" && next === "*") {
        flush();
        let end = text.indexOf("*/", i + 2);
        if (end < 0) end = text.length; else end += 2;
        out.push(indent() + text.slice(i, end).trim());
        i = end; continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < text.length) {
          if (text[j] === "\\") j += 2;
          else if (text[j] === ch) { j++; break; }
          else j++;
        }
        buf += text.slice(i, j); i = j; continue;
      }
      if (ch === "(") { paren++; buf += ch; i++; continue; }
      if (ch === ")") { paren = Math.max(0, paren - 1); buf += ch; i++; continue; }
      if (paren === 0 && ch === "{") {
        flush(" {"); depth++; i++; continue;
      }
      if (paren === 0 && ch === "}") {
        flush(); depth = Math.max(0, depth - 1); out.push(indent() + "}"); i++; continue;
      }
      if (paren === 0 && ch === ";") {
        flush(";"); i++; continue;
      }
      buf += ch; i++;
    }
    flush();
    return { ok: true, text: out.join("\n") + (text.endsWith("\n") ? "\n" : "") };
  }
  function formatCurrentFile() {
    if (!state.current || state.currentMode !== "text") { status("先打开一个文本文件", true); return; }
    const ext = extOf(state.current);
    const text = cm.getValue();
    let result;
    if (ext === ".css") result = formatCssText(text);
    else if (/\.(x?html?|htm|xml|opf|ncx|svg)$/i.test(ext)) result = formatMarkupText(text);
    else { status("当前文件类型暂不支持格式化：" + ext, true); return; }
    if (!result.ok) { status(result.error, true); return; }
    if (result.text === text) { status("当前文件已经是格式化状态"); return; }
    const cursor = cm.getCursor();
    cm.replaceRange(result.text, { line: 0, ch: 0 }, { line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length });
    cm.setCursor(Math.min(cursor.line, cm.lastLine()), 0);
    status("已格式化 " + state.current + "，可 Ctrl+Z 撤销");
  }
  function goToLine() {
    const line = prompt("跳到行号（1 - " + (cm.lineCount()) + "）", String(cm.getCursor().line + 1));
    if (line == null) return;
    const n = Math.max(1, Math.min(cm.lineCount(), parseInt(line, 10) || 1));
    cm.setCursor({ line: n - 1, ch: 0 }); cm.scrollIntoView({ line: n - 1, ch: 0 }, 60); cm.focus();
  }
  function moveLine(delta) {
    const cur = cm.getCursor();
    const target = cur.line + delta;
    if (target < 0 || target >= cm.lineCount()) return;
    const lineText = cm.getLine(cur.line), targetText = cm.getLine(target);
    cm.operation(() => {
      cm.replaceRange(targetText, { line: cur.line, ch: 0 }, { line: cur.line, ch: lineText.length });
      cm.replaceRange(lineText, { line: target, ch: 0 }, { line: target, ch: targetText.length });
      cm.setCursor({ line: target, ch: cur.ch });
    });
  }
  function duplicateLine() {
    const cur = cm.getCursor();
    const line = cm.getLine(cur.line);
    cm.replaceRange("\n" + line, { line: cur.line, ch: line.length });
    cm.setCursor({ line: cur.line + 1, ch: cur.ch });
  }

  function initEditor() {
    cm = CodeMirror.fromTextArea($("code"), {
      lineNumbers: true, mode: "htmlmixed", lineWrapping: false, indentUnit: 2,
      viewportMargin: 40, autoCloseBrackets: true, matchBrackets: true,
      extraKeys: {
        "Ctrl-/": toggleEpubComment, "Cmd-/": toggleEpubComment,
        "Shift-Alt-F": formatCurrentFile, "Ctrl-G": goToLine,
        "Alt-Up": () => moveLine(-1), "Alt-Down": () => moveLine(1), "Shift-Alt-D": duplicateLine,
      },
    });
    cm.on("cursorActivity", () => {
      const p = cm.getCursor();
      const el = $("cursorInfo");
      if (el) el.textContent = "Ln " + (p.line + 1) + ", Col " + (p.ch + 1);
    });
    applyWrap(state.wrap);
    cm.on("change", () => {
      if (state.suppressChange || !state.current || state.currentMode !== "text") return;
      state.edits.set(state.current, cm.getValue());
      markDirty();
      schedulePreviewRefresh();
    });
    cm.setSize("100%", "100%");
  }
  function boot() {
    parseReaderPrefsFromQuery();
    bind();

    initEditor();
    if (EMBEDDED) {
      setEmpty(true, "等待阅读器发送 EPUB…");
      try { window.parent.postMessage({ type: "epub-editor-ready" }, "*"); } catch { }
      clearInterval(state.loadPoller);
      state.loadPoller = setInterval(() => {
        if (state.zip) { clearInterval(state.loadPoller); return; }
        try { window.parent.postMessage({ type: "epub-editor-need-data" }, "*"); } catch { }
      }, 1500);
    } else {
      loadFromHost();
    }
  }
  boot();
})();
