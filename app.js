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
    deletions: new Set(), opfPath: "",
  };
  let cm = null;
  const THEMES = ["lyra", "violet", "emerald", "sunset", "sakura", "light"];
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
  async function findOpfPath() {
    if (state.opfPath && state.zip.file(state.opfPath)) return state.opfPath;
    const c = await entryText("META-INF/container.xml");
    const m = c.match(/<rootfile\b[^>]*full-path=["']([^"']+)["']/i);
    if (m) { state.opfPath = safeDecode(m[1]); return state.opfPath; }
    const any = listFiles().find((f) => /\.opf$/i.test(f));
    state.opfPath = any || "";
    return state.opfPath;
  }
  function markEntryEdited(rel, text) {
    if (!rel) return;
    state.edits.set(rel, text);
    state.zip.file(rel, text);
    state.dirty.add(rel);
    $("dirtyBadge").hidden = false;
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
    state.zip.forEach((path, entry) => { if (!entry.dir) out.push(path); });
    return out.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }
  function markDirty() {
    if (!state.current) return;
    state.dirty.add(state.current);
    $("dirtyBadge").hidden = false;
    refreshDirtyBadge();
    $("saveBtn").disabled = !state.zip;
    status("已修改 " + state.current + "，Ctrl+S 保存整本");
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
      cm.setValue("");
      cm.setOption("readOnly", true);
      $("saveBtn").disabled = !state.zip;
      status("二进制文件，不支持源码编辑：" + rel);
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
    state.suppressChange = true;
    cm.setValue(text);
    state.suppressChange = false;
    cm.setOption("mode", modeFor(rel));
    cm.clearHistory();
    $("saveBtn").disabled = !state.zip;
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
        frame.srcdoc = '<html><body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="' + url + '" style="max-width:100%;max-height:100vh"></body></html>';
        info.textContent = "图片";
      } else {
        frame.srcdoc = '<html><body style="margin:0;padding:24px;font:14px/1.7 system-ui;color:#555;background:#fff">' + escapeHtml(rel) + '<br>仅源码编辑，无 HTML 预览</body></html>';
        info.textContent = "源码";
      }
      return;
    }
    const text = await entryText(rel);
    const html = await rewriteHtml(text, rel);
    if (token !== state.previewToken) return;
    frame.srcdoc = html;
    info.textContent = "HTML 预览";
  }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  // ---------- load / save ----------
  async function loadBytes(bytes, name, path) {
    state.zip = await JSZip.loadAsync(bytes);
    state.bytes = bytes;
    state.name = name || state.name;
    state.path = path || state.path;
    clearInterval(state.loadPoller);
    state.dirty.clear(); state.current = ""; state.edits.clear(); state.previewTarget = ""; state.deletions.clear(); state.opfPath = "";
    state.blobCache.forEach((url) => { try { URL.revokeObjectURL(url); } catch { } });
    state.blobCache.clear();
    $("bookName").textContent = state.name + (state.path && state.path !== state.name ? "  ·  " + state.path : "");
    $("dirtyBadge").hidden = true;
    $("saveBtn").disabled = false;
    setEmpty(false);
    renderTree();
    const files = listFiles();
    const target = files.find((f) => /\.(x?html?|htm)$/i.test(f)) || files[0];
    if (target) await openEntry(target); else {
      $("currentFile").textContent = "没有文件"; cm.setValue(""); cm.setOption("readOnly", true);
    }
    status("已加载 " + files.length + " 个文件");
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
  async function saveBook() {
    if (!state.zip) return;
    if (!state.dirty.size && !state.deletions.size) { status("没有需要保存的修改"); return; }
    $("saveBtn").disabled = true;
    status("正在打包 EPUB…");
    try {
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
        window.parent.postMessage({ type: "epub-editor-save", saveId: saveId, name: state.name, data: bytes.buffer }, "*");
        await ack;
      } else {
        const payload = { data: b64 };
        if (state.path) payload.path = state.path;
        const res = await callHost("host.workspace.save", payload);
        if (!res || res.ok === false) throw new Error((res && res.error) || "宿主保存失败");
      }
      state.dirty.clear();
      state.edits.clear();
      state.deletions.clear();
      state.blobCache.forEach((url) => { try { URL.revokeObjectURL(url); } catch { } });
      state.blobCache.clear();
      $("dirtyBadge").hidden = true;
      renderTree();
      status("已保存：" + state.name);
      if (state.current && state.zip.file(state.current)) renderPreview(state.previewTarget && isHtmlFile(state.previewTarget) ? state.previewTarget : state.current).catch(() => { });
    } catch (e) {
      status("保存失败：" + (e && e.message ? e.message : e), true);
    } finally {
      $("saveBtn").disabled = !state.zip;
    }
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
    const navMatch = nextOpf.match(/<item\b[^>]*properties=["'][^"']*nav[^"']*["'][^>]*href=["']([^"']+)["']/i) ||
      nextOpf.match(/<item\b[^>]*href=["']([^"']*nav[^"']*\.x?html)["'][^>]*>/i);
    if (navMatch) {
      const navPath = resolvePath(contentDir, navMatch[1]);
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
  async function deleteEntry(rel) {
    if (!state.zip || !rel) return;
    const opfPath = await findOpfPath();
    const keep = rel === "mimetype" || /^META-INF\/container\.xml$/i.test(rel) || (opfPath && rel === opfPath);
    if (keep) { status("不能删除 EPUB 必需文件：" + rel, true); return; }
    if (!confirm("从整本书删除 " + rel + "？\n会尝试同步清理 OPF/目录引用。")) return;
    state.zip.remove(rel);
    state.edits.delete(rel); state.dirty.delete(rel); state.deletions.add(rel);
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
      const navMatch = nextOpf.match(/<item\b[^>]*properties=["'][^"']*nav[^"']*["'][^>]*href=["']([^"']+)["']/i);
      if (navMatch) {
        const navPath = resolvePath(opfDir, navMatch[1]);
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
    $("themeSelect").addEventListener("change", () => applyTheme($("themeSelect").value));
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
    $("findBtn").addEventListener("click", () => openFind());
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); saveBook(); return; }
      if (EMBEDDED && event.key === "Escape" && $("findBar").hidden) {
        if (state.dirty.size && !confirm("有未保存修改，返回阅读会丢失这些修改，确定？")) return;
        try { window.parent.postMessage({ type: "epub-editor-close" }, "*"); } catch { }
      }
    });
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
  function initEditor() {
    cm = CodeMirror.fromTextArea($("code"), {
      lineNumbers: true, mode: "htmlmixed", lineWrapping: false, indentUnit: 2,
      viewportMargin: 40, autoCloseBrackets: true, matchBrackets: true,
      extraKeys: { "Ctrl-/": toggleEpubComment, "Cmd-/": toggleEpubComment },
    });
    cm.on("cursorActivity", () => {
      const p = cm.getCursor();
      const el = $("cursorInfo");
      if (el) el.textContent = "Ln " + (p.line + 1) + ", Col " + (p.ch + 1);
    });
    cm.on("change", () => {
      if (state.suppressChange || !state.current || state.currentMode !== "text") return;
      state.edits.set(state.current, cm.getValue());
      markDirty();
      schedulePreviewRefresh();
    });
    cm.setSize("100%", "100%");
  }
  function boot() {
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
