/* ui/dashboard.js
 * Shared modules available via <script> tags:
 * - MILib  (redactHeaders, redactBody, trimArray, createRateLimiter)
 * - MIUtils (normalizeHeaders, hostMatchesWildcard, isStaticAssetUrl, shouldInterceptWith, parseHeadersJson, bodyToEditor)
 */

const port = browser.runtime.connect({ name: "dashboard" });

let currentMode = "OFF";
let currentId = null;
let currentEntry = null;
let lastForwardedRequest = null;
let lastForwardedResponse = null;
let showSensitive = false;

const el = (id) => document.getElementById(id);

const topbar = el("topbar");
const interceptModeSelect = el("interceptMode");
const armedBadge = el("armedBadge");

const queueSize = el("queueSize");
const queueList = el("queueList");

const reqMethod = el("reqMethod");
const reqUrl = el("reqUrl");
const reqHeaders = el("reqHeaders");
const reqBody = el("reqBody");

const btnForward = el("btnForward");
const btnDrop = el("btnDrop");
const btnSaveRepeater = el("btnSaveRepeater");
const btnForwardAll = el("btnForwardAll");
const btnDropAll = el("btnDropAll");

const repeaterList = el("repeaterList");
const btnRefreshRepeater = el("btnRefreshRepeater");

const responseBox = el("responseBox");
const editorHint = el("editorHint");
const btnSaveNote = el("btnSaveNote");
const toggleSensitive = el("toggleSensitive");

const scopeMode = el("scopeMode");
const bypassStatic = el("bypassStatic");
const allowDomains = el("allowDomains");
const allowUrlContains = el("allowUrlContains");
const btnLoadPolicy = el("btnLoadPolicy");
const btnSavePolicy = el("btnSavePolicy");
const btnPanicOff = el("btnPanicOff");

const notesList = el("notesList");
const btnExportNotes = el("btnExportNotes");
const btnClearNotes = el("btnClearNotes");

const auditList = el("auditList");
const btnRefreshAudit = el("btnRefreshAudit");
const btnClearAudit = el("btnClearAudit");

const ctxMenu = el("ctxMenu");
const ctxAddScope = el("ctxAddScope");

let ctxTarget = null;

// --- Redaction helpers ---
function displayHeaders(headers) {
  if (showSensitive) return headers;
  return MILib.redactHeaders(headers);
}

function displayBody(bodyText, contentType) {
  if (showSensitive) return bodyText;
  return MILib.redactBody(bodyText, contentType);
}

// --- Flash helper ---
function flashButton(btn, cls = "flash-ok") {
  btn.classList.remove(cls);
  void btn.offsetWidth;
  btn.classList.add(cls);
  btn.addEventListener("animationend", () => btn.classList.remove(cls), { once: true });
}

// --- Mode UI ---
function updateModeUI(mode) {
  currentMode = mode;
  interceptModeSelect.value = mode;
  topbar.classList.remove("armed", "observe");
  armedBadge.classList.add("hidden");
  armedBadge.classList.remove("observe-badge");

  if (mode === "INTERCEPT") {
    topbar.classList.add("armed");
    armedBadge.textContent = "ARMED";
    armedBadge.classList.remove("hidden");
  } else if (mode === "OBSERVE") {
    topbar.classList.add("observe");
    armedBadge.textContent = "OBSERVE";
    armedBadge.classList.remove("hidden");
    armedBadge.classList.add("observe-badge");
  }
}

// --- Policy ---
function policyToForm(p) {
  scopeMode.value = p.scopeMode || "ALLOWLIST";
  bypassStatic.value = String(!!p.bypassStaticAssets);
  allowDomains.value = (p.allowDomains || []).join("\n");
  allowUrlContains.value = (p.allowUrlContains || []).join("\n");
}

function formToPolicy() {
  return {
    scopeMode: scopeMode.value,
    bypassStaticAssets: bypassStatic.value === "true",
    allowDomains: allowDomains.value.split("\n").map(s => s.trim()).filter(Boolean),
    allowUrlContains: allowUrlContains.value.split("\n").map(s => s.trim()).filter(Boolean)
  };
}

async function loadPolicy() {
  const res = await browser.runtime.sendMessage({ type: "GET_POLICY" });
  if (res?.ok) policyToForm(res.policy);
}

async function savePolicy() {
  const p = formToPolicy();
  const res = await browser.runtime.sendMessage({ type: "SET_POLICY", policy: p });
  responseBox.textContent = pretty(res);
}

function setButtonsEnabled(enabled) {
  btnForward.disabled = !enabled;
  btnDrop.disabled = !enabled;
  btnSaveRepeater.disabled = !enabled;
}

function setBulkButtonsEnabled(enabled) {
  btnForwardAll.disabled = !enabled;
  btnDropAll.disabled = !enabled;
}

function pretty(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

function formatResponse(res) {
  if (!res) return "No response";
  if (!res.ok && res.error) return `Error: ${res.error}\nDuration: ${res.durationMs}ms`;

  const r = res.response || res;
  if (!r.status) return pretty(res);

  let out = `HTTP ${r.status} ${r.statusText || ""}\n`;
  out += `URL: ${r.url || ""}\n`;
  out += `Duration: ${r.durationMs}ms\n`;

  // Show request headers (contains cookie/authorization → redaction visible here)
  if (lastForwardedRequest && lastForwardedRequest.headers && Object.keys(lastForwardedRequest.headers).length) {
    out += "\n--- Request Headers (sent) ---\n";
    const drh = displayHeaders(lastForwardedRequest.headers);
    for (const [k, v] of Object.entries(drh)) out += `${k}: ${v}\n`;
    const reqRedacted = Object.keys(lastForwardedRequest.headers).filter(k => MILib.isSensitiveHeader(k)).length;
    if (reqRedacted > 0 && !showSensitive) out += `(${reqRedacted} header redacted)\n`;
  }

  if (r.headers) {
    out += "\n--- Response Headers ---\n";
    const dh = displayHeaders(r.headers);
    for (const [k, v] of Object.entries(dh)) {
      out += `${k}: ${v}\n`;
    }
    const respRedacted = Object.keys(r.headers).filter(k => MILib.isSensitiveHeader(k)).length;
    if (respRedacted > 0 && !showSensitive) out += `(${respRedacted} header redacted)\n`;
  }

  if (r.body && r.body.bytesBase64) {
    const ct = (r.headers && (r.headers["content-type"] || "")) || "";
    const isText = /text|json|xml|html|javascript|css|svg|urlencoded/i.test(ct);
    if (isText) {
      try {
        out += "\n--- Response Body ---\n";
        out += displayBody(atob(r.body.bytesBase64), ct);
      } catch (_) {
        out += "\n--- Response Body (base64) ---\n" + r.body.bytesBase64;
      }
    } else {
      out += `\n--- Response Body (binary, ${r.body.originalBytes} bytes) ---\n`;
      out += `[base64] ${r.body.bytesBase64.substring(0, 200)}...`;
    }
    if (r.body.truncated) {
      out += `\n[Truncated: ${r.body.capturedBytes}/${r.body.originalBytes} bytes]`;
    }
  }

  return out;
}

// --- Context menu ---
function showCtxMenu(x, y, entry) {
  ctxTarget = entry;
  ctxMenu.style.left = x + "px";
  ctxMenu.style.top = y + "px";
  ctxMenu.classList.remove("hidden");
}

function hideCtxMenu() {
  ctxMenu.classList.add("hidden");
  ctxTarget = null;
}

document.addEventListener("click", (e) => {
  if (!ctxMenu.contains(e.target)) hideCtxMenu();
});

ctxAddScope.addEventListener("click", async () => {
  if (!ctxTarget || !ctxTarget.url) return;
  try {
    const hostname = new URL(ctxTarget.url).hostname;
    const current = allowDomains.value.split("\n").map(s => s.trim()).filter(Boolean);
    if (!current.includes(hostname)) {
      current.push(hostname);
      allowDomains.value = current.join("\n");
      await savePolicy();
      flashButton(ctxAddScope, "flash-ok");
    }
  } catch (_) {}
  hideCtxMenu();
});

// --- Queue ---
function renderQueue(queue) {
  queueSize.textContent = String(queue.length);
  // Only enable bulk actions for non-observe intercepted items
  const hasIntercepted = queue.some(q => !q.observe);
  setBulkButtonsEnabled(hasIntercepted);
  queueList.replaceChildren();

  if (!queue.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "Queue vuota.";
    queueList.appendChild(d);
    return;
  }

  for (const q of queue) {
    const item = document.createElement("div");
    item.className = "item click" + (q.observe ? " observe-item" : "");
    item.dataset.id = q.id;

    const u = new URL(q.url);
    const top = document.createElement("div");
    const left = document.createElement("div");
    left.className = "mono";

    const b = document.createElement("b");
    b.textContent = String(q.method || "");
    left.appendChild(b);
    left.appendChild(document.createTextNode(" " + String(u.host || "")));

    const right = document.createElement("div");
    right.className = "badge";
    right.textContent = q.observe ? "OBSERVE" : String(q.type || "");

    top.appendChild(left);
    top.appendChild(right);

    const mid = document.createElement("div");
    mid.className = "small mono";
    mid.textContent = `${u.pathname}${u.search || ""}`;

    const bot = document.createElement("div");
    bot.className = "small";
    bot.textContent = q.bodyHint ? `Body: ${q.bodyHint}` : `Time: ${q.time}`;

    item.appendChild(top);
    item.appendChild(mid);
    item.appendChild(bot);

    if (!q.observe) {
      item.addEventListener("click", () => selectEntry(q));
    }

    // Long-press for context menu (mobile)
    let longPressTimer = null;
    item.addEventListener("touchstart", (e) => {
      longPressTimer = setTimeout(() => {
        e.preventDefault();
        const touch = e.touches[0];
        showCtxMenu(touch.clientX, touch.clientY, q);
      }, 300);
    }, { passive: false });
    item.addEventListener("touchmove", () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });
    item.addEventListener("touchend", () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, q);
    });

    queueList.appendChild(item);
  }
}

function selectEntry(entry) {
  if (entry.observe) return;
  currentId = entry.id;
  currentEntry = entry;

  reqMethod.value = entry.method || "GET";
  reqUrl.value = entry.url || "";
  reqHeaders.value = pretty(entry.headers || {});
  reqBody.value = MIUtils.bodyToEditor(entry.requestBody);

  editorHint.textContent = `Selezionata: ${entry.method} ${entry.url}`;
  setButtonsEnabled(true);
}

async function refreshQueue() {
  const res = await browser.runtime.sendMessage({ type: "GET_QUEUE" });
  if (res?.ok) {
    updateModeUI(res.interceptMode || "OFF");
    renderQueue(res.queue || []);
  }
}

// --- Repeater ---
async function refreshRepeater() {
  const res = await browser.runtime.sendMessage({ type: "LIST_REPEATER_ITEMS" });
  repeaterList.replaceChildren();

  const items = res?.items || [];
  if (!items.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "Repeater vuoto.";
    repeaterList.appendChild(d);
    return;
  }

  for (const it of items) {
    const box = document.createElement("div");
    box.className = "item";

    const top = document.createElement("div");
    top.className = "row";

    const leftWrap = document.createElement("div");
    const nameB = document.createElement("b");
    nameB.textContent = String(it.name || "Unnamed");
    leftWrap.appendChild(nameB);
    leftWrap.appendChild(document.createTextNode(" "));
    const methodSpan = document.createElement("span");
    methodSpan.className = "badge";
    methodSpan.textContent = String(it.request?.method || "");
    leftWrap.appendChild(methodSpan);

    const rightTime = document.createElement("div");
    rightTime.className = "badge";
    rightTime.textContent = new Date(it.savedAt).toLocaleString();

    top.appendChild(leftWrap);
    top.appendChild(rightTime);

    const mid = document.createElement("div");
    mid.className = "small mono";
    mid.textContent = it.request?.url || "";

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.style.marginTop = "8px";

    const run = document.createElement("button");
    run.className = "primary";
    run.textContent = "Run";
    run.addEventListener("click", async () => {
      responseBox.textContent = "Running...";
      const r = await browser.runtime.sendMessage({ type: "RUN_REPEATER_ITEM", request: it.request });
      responseBox.textContent = formatResponse(r);
      lastForwardedRequest = it.request;
      lastForwardedResponse = r;
      btnSaveNote.disabled = false;
      flashButton(run, "flash-ok");
    });

    const load = document.createElement("button");
    load.textContent = "Load to Editor";
    load.addEventListener("click", () => {
      const req = it.request || {};
      currentId = null;
      currentEntry = null;
      reqMethod.value = req.method || "GET";
      reqUrl.value = req.url || "";
      reqHeaders.value = pretty(req.headers || {});
      reqBody.value = MIUtils.bodyToEditor(req.body);
      editorHint.textContent = `Loaded from Repeater: ${it.name || "Unnamed"}`;
      setButtonsEnabled(false);
    });

    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await browser.runtime.sendMessage({ type: "DELETE_REPEATER_ITEM", id: it.id });
      flashButton(del, "flash-danger");
      await refreshRepeater();
    });

    actions.appendChild(run);
    actions.appendChild(load);
    actions.appendChild(del);

    box.appendChild(top);
    box.appendChild(mid);
    box.appendChild(actions);
    repeaterList.appendChild(box);
  }
}

// --- Notes ---
function decodeBodyForNote(body) {
  if (!body) return "";
  if (body.kind === "text") return body.text || "";
  if ((body.kind === "raw_base64" || body.kind === "raw_base64_truncated") && body.bytesBase64) {
    try { return atob(body.bytesBase64); } catch (_) { return body.bytesBase64; }
  }
  if (body.kind === "formData") return pretty(body.formData);
  return pretty(body);
}

function formatNoteForExport(note) {
  const ts = new Date(note.timestamp).toLocaleString("sv-SE");
  const req = note.request || {};
  const res = note.response || {};
  const resp = res.response || res;

  let out = "\u2550".repeat(50) + "\n";
  out += `[${ts}] ${req.method || "?"} ${req.url || "?"}\n`;
  out += "\u2550".repeat(50) + "\n\n";

  if (req.headers && Object.keys(req.headers).length) {
    out += "\u2500\u2500 REQUEST HEADERS \u2500\u2500\n";
    const dh = displayHeaders(req.headers);
    for (const [k, v] of Object.entries(dh)) out += `${k}: ${v}\n`;
    out += "\n";
  }

  const reqBodyText = decodeBodyForNote(req.body);
  if (reqBodyText) {
    const ct = req.headers?.["content-type"] || "";
    out += "\u2500\u2500 REQUEST BODY \u2500\u2500\n";
    out += displayBody(reqBodyText, ct) + "\n\n";
  }

  if (resp.status) {
    out += `\u2500\u2500 RESPONSE: ${resp.status} ${resp.statusText || ""} (${resp.durationMs || 0}ms) \u2500\u2500\n\n`;
  } else if (res.error) {
    out += `\u2500\u2500 RESPONSE ERROR: ${res.error} \u2500\u2500\n\n`;
  }

  if (resp.headers && Object.keys(resp.headers).length) {
    out += "\u2500\u2500 RESPONSE HEADERS \u2500\u2500\n";
    const dh = displayHeaders(resp.headers);
    for (const [k, v] of Object.entries(dh)) out += `${k}: ${v}\n`;
    out += "\n";
  }

  if (resp.body && resp.body.bytesBase64) {
    const ct = (resp.headers && (resp.headers["content-type"] || "")) || "";
    const isText = /text|json|xml|html|javascript|css|svg|urlencoded/i.test(ct);
    out += "\u2500\u2500 RESPONSE BODY \u2500\u2500\n";
    if (isText) {
      try { out += displayBody(atob(resp.body.bytesBase64), ct); } catch (_) { out += resp.body.bytesBase64; }
    } else {
      out += `[binary, ${resp.body.originalBytes || 0} bytes]`;
    }
    out += "\n";
  }

  out += "\n";
  return out;
}

async function refreshNotes() {
  const res = await browser.runtime.sendMessage({ type: "LIST_NOTES" });
  notesList.replaceChildren();
  const notes = res?.notes || [];

  if (!notes.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "Nessuna nota salvata.";
    notesList.appendChild(d);
    return;
  }

  for (const note of notes) {
    const card = document.createElement("div");
    card.className = "item";

    const req = note.request || {};
    const res2 = note.response || {};
    const resp = res2.response || res2;

    const titleRow = document.createElement("div");
    titleRow.className = "row";
    const titleLeft = document.createElement("div");
    titleLeft.className = "mono";
    const methodB = document.createElement("b");
    methodB.textContent = req.method || "?";
    titleLeft.appendChild(methodB);
    titleLeft.appendChild(document.createTextNode(" " + (req.url || "")));
    const titleRight = document.createElement("div");
    titleRight.className = "badge";
    titleRight.textContent = resp.status ? `${resp.status}` : "N/A";
    titleRow.appendChild(titleLeft);
    titleRow.appendChild(titleRight);
    card.appendChild(titleRow);

    const tsDiv = document.createElement("div");
    tsDiv.className = "small";
    tsDiv.textContent = new Date(note.timestamp).toLocaleString();
    card.appendChild(tsDiv);

    // Request headers (collapsible, redacted)
    if (req.headers && Object.keys(req.headers).length) {
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.className = "small";
      sum.textContent = "Request Headers";
      sum.style.cursor = "pointer";
      sum.style.color = "var(--accent)";
      det.appendChild(sum);
      const pre = document.createElement("pre");
      pre.className = "pre";
      pre.style.fontSize = "11px";
      pre.style.minHeight = "auto";
      const dh = displayHeaders(req.headers);
      let hText = "";
      for (const [k, v] of Object.entries(dh)) hText += `${k}: ${v}\n`;
      pre.textContent = hText;
      det.appendChild(pre);
      card.appendChild(det);
    }

    // Request body (redacted)
    const reqBodyText = decodeBodyForNote(req.body);
    if (reqBodyText) {
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.className = "small";
      sum.textContent = "Request Body";
      sum.style.cursor = "pointer";
      sum.style.color = "var(--accent)";
      det.appendChild(sum);
      const pre = document.createElement("pre");
      pre.className = "pre";
      pre.style.fontSize = "11px";
      pre.style.minHeight = "auto";
      const ct = req.headers?.["content-type"] || "";
      pre.textContent = displayBody(reqBodyText, ct);
      det.appendChild(pre);
      card.appendChild(det);
    }

    // Response headers (redacted)
    if (resp.headers && Object.keys(resp.headers).length) {
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.className = "small";
      sum.textContent = `Response Headers (${resp.status || "?"})`;
      sum.style.cursor = "pointer";
      sum.style.color = "var(--accent)";
      det.appendChild(sum);
      const pre = document.createElement("pre");
      pre.className = "pre";
      pre.style.fontSize = "11px";
      pre.style.minHeight = "auto";
      const dh = displayHeaders(resp.headers);
      let hText = "";
      for (const [k, v] of Object.entries(dh)) hText += `${k}: ${v}\n`;
      pre.textContent = hText;
      det.appendChild(pre);
      card.appendChild(det);
    }

    // Response body (redacted)
    if (resp.body && resp.body.bytesBase64) {
      const ct = (resp.headers && (resp.headers["content-type"] || "")) || "";
      const isText = /text|json|xml|html|javascript|css|svg|urlencoded/i.test(ct);
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.className = "small";
      sum.textContent = "Response Body";
      sum.style.cursor = "pointer";
      sum.style.color = "var(--accent)";
      det.appendChild(sum);
      const pre = document.createElement("pre");
      pre.className = "pre";
      pre.style.fontSize = "11px";
      pre.style.minHeight = "auto";
      if (isText) {
        try { pre.textContent = displayBody(atob(resp.body.bytesBase64), ct); } catch (_) { pre.textContent = resp.body.bytesBase64; }
      } else {
        pre.textContent = `[binary, ${resp.body.originalBytes || 0} bytes]`;
      }
      det.appendChild(pre);
      card.appendChild(det);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.style.marginTop = "6px";
    const delBtn = document.createElement("button");
    delBtn.className = "danger btn-sm";
    delBtn.textContent = "Elimina";
    delBtn.addEventListener("click", async () => {
      await browser.runtime.sendMessage({ type: "DELETE_NOTE", id: note.id });
      flashButton(delBtn, "flash-danger");
      await refreshNotes();
    });
    actions.appendChild(delBtn);
    card.appendChild(actions);

    notesList.appendChild(card);
  }
}

// --- Audit Log ---
async function refreshAuditLog() {
  const res = await browser.runtime.sendMessage({ type: "LIST_AUDIT_LOG" });
  auditList.replaceChildren();
  const entries = res?.log || [];

  if (!entries.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No audit entries.";
    auditList.appendChild(d);
    return;
  }

  for (const entry of entries.slice().reverse()) {
    const item = document.createElement("div");
    item.className = "item";

    const row = document.createElement("div");
    row.className = "row";

    const left = document.createElement("div");
    left.className = "mono small";
    const actionB = document.createElement("b");
    actionB.textContent = entry.action;
    left.appendChild(actionB);
    if (entry.method) left.appendChild(document.createTextNode(` ${entry.method}`));
    if (entry.mode) left.appendChild(document.createTextNode(` ${entry.mode}`));
    if (entry.count != null) left.appendChild(document.createTextNode(` (${entry.count})`));

    const right = document.createElement("div");
    right.className = "small";
    right.textContent = new Date(entry.timestamp).toLocaleString();

    row.appendChild(left);
    row.appendChild(right);
    item.appendChild(row);

    if (entry.url) {
      const urlDiv = document.createElement("div");
      urlDiv.className = "small mono";
      urlDiv.textContent = entry.url;
      item.appendChild(urlDiv);
    }

    auditList.appendChild(item);
  }
}

// --- Realtime updates ---
port.onMessage.addListener((m) => {
  if (!m || !m.type) return;

  if (m.type === "INIT") {
    updateModeUI(m.payload.interceptMode || "OFF");
    renderQueue(m.payload.queue || []);
    queueSize.textContent = String((m.payload.queue || []).length);
    if (m.payload.policy) policyToForm(m.payload.policy);
  }

  if (m.type === "QUEUE_UPDATED") {
    updateModeUI(m.payload.interceptMode || "OFF");
    queueSize.textContent = String(m.payload.size ?? 0);
    refreshQueue();
  }

  if (m.type === "REQUEST_INTERCEPTED") {
    refreshQueue();
  }

  if (m.type === "REQUEST_UPDATED") {
    refreshQueue();
  }

  if (m.type === "POLICY_UPDATED") {
    policyToForm(m.payload.policy);
  }
});

// --- Mode selector ---
interceptModeSelect.addEventListener("change", async () => {
  const mode = interceptModeSelect.value;
  await browser.runtime.sendMessage({ type: "TOGGLE_INTERCEPT", mode });
  updateModeUI(mode);
  await refreshQueue();
});

// --- Forward / Drop ---
btnDrop.addEventListener("click", async () => {
  if (!currentId) return;
  await browser.runtime.sendMessage({ type: "DROP_REQUEST", id: currentId });
  flashButton(btnDrop, "flash-danger");
  currentId = null;
  currentEntry = null;
  editorHint.textContent = "Dropped. Seleziona una request dalla Queue.";
  setButtonsEnabled(false);
  await refreshQueue();
});

btnForward.addEventListener("click", async () => {
  if (!currentId) return;

  let headers;
  try {
    headers = MIUtils.parseHeadersJson(reqHeaders.value);
  } catch (e) {
    responseBox.textContent = String(e);
    return;
  }

  const bodyText = reqBody.value || "";
  let body = null;
  if (bodyText.trim()) {
    try {
      const obj = JSON.parse(bodyText);
      if (obj && typeof obj === "object" && obj.kind) {
        body = obj;
      } else {
        body = { kind: "text", text: bodyText };
      }
    } catch (_) {
      body = { kind: "raw_base64", bytesBase64: bodyText.trim() };
    }
  }

  responseBox.textContent = "Forwarding...";
  const edited = {
    method: reqMethod.value.trim() || "GET",
    url: reqUrl.value.trim(),
    headers,
    body
  };

  const res = await browser.runtime.sendMessage({ type: "FORWARD_REQUEST", id: currentId, edited });
  responseBox.textContent = formatResponse(res);
  flashButton(btnForward, "flash-ok");

  lastForwardedRequest = edited;
  lastForwardedResponse = res;
  btnSaveNote.disabled = false;

  setButtonsEnabled(false);
  currentId = null;
  currentEntry = null;
  await refreshQueue();
});

// --- Drop All / Forward All ---
btnDropAll.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "DROP_ALL" });
  flashButton(btnDropAll, "flash-danger");
  currentId = null;
  currentEntry = null;
  setButtonsEnabled(false);
  await refreshQueue();
});

btnForwardAll.addEventListener("click", async () => {
  responseBox.textContent = "Forwarding all...";
  const res = await browser.runtime.sendMessage({ type: "FORWARD_ALL" });
  responseBox.textContent = `Forwarded ${res.forwarded || 0} requests.`;
  flashButton(btnForwardAll, "flash-ok");
  currentId = null;
  currentEntry = null;
  setButtonsEnabled(false);
  await refreshQueue();
});

// --- Save to Repeater ---
btnSaveRepeater.addEventListener("click", async () => {
  if (!currentEntry) return;

  let headers;
  try { headers = MIUtils.parseHeadersJson(reqHeaders.value); }
  catch (e) { responseBox.textContent = String(e); return; }

  const name = `${reqMethod.value.toUpperCase()} ${new URL(reqUrl.value).pathname}`.slice(0, 80);
  const bodyText = reqBody.value || "";
  let body = null;
  if (bodyText.trim()) {
    try {
      const obj = JSON.parse(bodyText);
      body = (obj && obj.kind) ? obj : { kind: "text", text: bodyText };
    } catch (_) {
      body = { kind: "raw_base64", bytesBase64: bodyText.trim() };
    }
  }

  const item = {
    name,
    request: { method: reqMethod.value.trim() || "GET", url: reqUrl.value.trim(), headers, body }
  };

  const res = await browser.runtime.sendMessage({ type: "SAVE_REPEATER_ITEM", item });
  responseBox.textContent = pretty(res);
  flashButton(btnSaveRepeater, "flash-ok");
  await refreshRepeater();
});

// --- Save to Notes ---
btnSaveNote.addEventListener("click", async () => {
  if (!lastForwardedRequest && !lastForwardedResponse) return;
  await browser.runtime.sendMessage({
    type: "SAVE_NOTE",
    request: lastForwardedRequest,
    response: lastForwardedResponse
  });
  flashButton(btnSaveNote, "flash-ok");
  btnSaveNote.disabled = true;
  lastForwardedRequest = null;
  lastForwardedResponse = null;
  await refreshNotes();
});

// --- Export Notes ---
btnExportNotes.addEventListener("click", async () => {
  const res = await browser.runtime.sendMessage({ type: "LIST_NOTES" });
  const notes = res?.notes || [];
  if (!notes.length) {
    responseBox.textContent = "Nessuna nota da esportare.";
    return;
  }

  let txt = "Mobile Interceptor - Notes Export\n";
  txt += "Generated: " + new Date().toLocaleString() + "\n\n";
  for (const note of notes) txt += formatNoteForExport(note);

  const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "interceptor-notes-" + new Date().toISOString().slice(0, 10) + ".txt";
  a.click();
  URL.revokeObjectURL(url);
  flashButton(btnExportNotes, "flash-ok");
});

// --- Clear Notes ---
btnClearNotes.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "CLEAR_NOTES" });
  flashButton(btnClearNotes, "flash-danger");
  await refreshNotes();
});

// --- Show sensitive toggle ---
toggleSensitive.addEventListener("change", () => {
  showSensitive = toggleSensitive.checked;
  const label = toggleSensitive.parentElement.querySelector("span");
  label.textContent = showSensitive ? "Sensitive: VISIBLE" : "Sensitive: HIDDEN";
  refreshNotes();
  // Re-render response box if we have cached response
  if (lastForwardedResponse) {
    responseBox.textContent = formatResponse(lastForwardedResponse);
  }
});

// --- Audit log buttons ---
btnRefreshAudit.addEventListener("click", refreshAuditLog);
btnClearAudit.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "CLEAR_AUDIT_LOG" });
  flashButton(btnClearAudit, "flash-danger");
  await refreshAuditLog();
});

// --- Other button handlers ---
btnRefreshRepeater.addEventListener("click", refreshRepeater);
btnLoadPolicy.addEventListener("click", loadPolicy);
btnSavePolicy.addEventListener("click", savePolicy);

btnPanicOff.addEventListener("click", async () => {
  interceptModeSelect.value = "OFF";
  await browser.runtime.sendMessage({ type: "TOGGLE_INTERCEPT", mode: "OFF" });
  updateModeUI("OFF");
  responseBox.textContent = "PANIC: Intercept disabilitato.";
  flashButton(btnPanicOff, "flash-danger");
  await refreshQueue();
});

// --- Boot ---
setButtonsEnabled(false);
setBulkButtonsEnabled(false);
btnSaveNote.disabled = true;
refreshQueue();
refreshRepeater();
refreshNotes();
refreshAuditLog();
loadPolicy();
