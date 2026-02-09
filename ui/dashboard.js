/* ui/dashboard.js */

const port = browser.runtime.connect({ name: "dashboard" });

let interceptEnabled = false;
let currentId = null;
let currentEntry = null;
let lastForwardedRequest = null;
let lastForwardedResponse = null;

const el = (id) => document.getElementById(id);

const toggleIntercept = el("toggleIntercept");
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

const ctxMenu = el("ctxMenu");
const ctxAddScope = el("ctxAddScope");

// --- Context menu state ---
let ctxTarget = null;

// --- Flash helper ---
function flashButton(btn, cls = "flash-ok") {
  btn.classList.remove(cls);
  void btn.offsetWidth; // force reflow
  btn.classList.add(cls);
  btn.addEventListener("animationend", () => btn.classList.remove(cls), { once: true });
}

function policyToForm(p) {
  scopeMode.value = p.scopeMode || "ALLOWLIST";
  bypassStatic.value = String(!!p.bypassStaticAssets);
  allowDomains.value = (p.allowDomains || []).join("\n");
  allowUrlContains.value = (p.allowUrlContains || []).join("\n");
}

function formToPolicy() {
  const domains = allowDomains.value
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const contains = allowUrlContains.value
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  return {
    scopeMode: scopeMode.value,
    bypassStaticAssets: bypassStatic.value === "true",
    allowDomains: domains,
    allowUrlContains: contains
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

  if (r.headers) {
    out += "\n--- Response Headers ---\n";
    for (const [k, v] of Object.entries(r.headers)) {
      out += `${k}: ${v}\n`;
    }
  }

  if (r.body && r.body.bytesBase64) {
    const ct = (r.headers && (r.headers["content-type"] || "")) || "";
    const isText = /text|json|xml|html|javascript|css|svg|urlencoded/i.test(ct);
    if (isText) {
      try {
        out += "\n--- Response Body ---\n";
        out += atob(r.body.bytesBase64);
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

function parseHeadersJson(text) {
  if (!text.trim()) return {};
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch (_) {}
  throw new Error("Headers non validi: inserisci un JSON object, es: {\"x-test\":\"1\"}");
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

function renderQueue(queue) {
  queueSize.textContent = String(queue.length);
  setBulkButtonsEnabled(queue.length > 0);
  queueList.innerHTML = "";

  if (!queue.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "Queue vuota.";
    queueList.appendChild(d);
    return;
  }

  for (const q of queue) {
    const item = document.createElement("div");
    item.className = "item click";
    item.dataset.id = q.id;

    const u = new URL(q.url);
    const top = document.createElement("div");
    // SAFE DOM building (no innerHTML)
    const left = document.createElement("div");
    left.className = "mono";

    const b = document.createElement("b");
    b.textContent = String(q.method || "");
    left.appendChild(b);

    left.appendChild(document.createTextNode(" " + String(u.host || "")));

    const right = document.createElement("div");
    right.className = "badge";
    right.textContent = String(q.type || "");

    top.innerHTML = ""; // optional: ensure empty
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

    item.addEventListener("click", () => selectEntry(q));

    // Long-press for context menu (mobile)
    let longPressTimer = null;
    let touchMoved = false;
    item.addEventListener("touchstart", (e) => {
      touchMoved = false;
      longPressTimer = setTimeout(() => {
        e.preventDefault();
        const touch = e.touches[0];
        showCtxMenu(touch.clientX, touch.clientY, q);
      }, 300);
    }, { passive: false });
    item.addEventListener("touchmove", () => {
      touchMoved = true;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });
    item.addEventListener("touchend", () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });
    // Desktop right-click
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, q);
    });

    queueList.appendChild(item);
  }
}

function bodyToEditor(body) {
  if (!body) return "";
  if (body.kind === "formData") return pretty(body);
  if (body.kind === "raw_base64" || body.kind === "raw_base64_truncated") {
    return body.bytesBase64; // user can paste base64 raw
  }
  if (body.kind === "text") return body.text || "";
  return pretty(body);
}

function selectEntry(entry) {
  currentId = entry.id;
  currentEntry = entry;

  reqMethod.value = entry.method || "GET";
  reqUrl.value = entry.url || "";
  reqHeaders.value = pretty(entry.headers || {});
  reqBody.value = bodyToEditor(entry.requestBody);

  editorHint.textContent = `Selezionata: ${entry.method} ${entry.url}`;
  setButtonsEnabled(true);
}

async function refreshQueue() {
  const res = await browser.runtime.sendMessage({ type: "GET_QUEUE" });
  if (res?.ok) {
    interceptEnabled = !!res.interceptEnabled;
    toggleIntercept.checked = interceptEnabled;
    renderQueue(res.queue || []);
  }
}

async function refreshRepeater() {
  const res = await browser.runtime.sendMessage({ type: "LIST_REPEATER_ITEMS" });
  repeaterList.innerHTML = "";

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
    // SAFE DOM building (no innerHTML)
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

    top.innerHTML = ""; // optional
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
      // Enable Save to Notes with repeater request+response
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
      reqBody.value = bodyToEditor(req.body);
      editorHint.textContent = `Loaded from Repeater: ${it.name || "Unnamed"}`;
      setButtonsEnabled(false); // not linked to queue item
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
  const ts = new Date(note.timestamp).toLocaleString("sv-SE"); // YYYY-MM-DD HH:mm:ss
  const req = note.request || {};
  const res = note.response || {};
  const resp = res.response || res;

  let out = "\u2550".repeat(50) + "\n";
  out += `[${ts}] ${req.method || "?"} ${req.url || "?"}\n`;
  out += "\u2550".repeat(50) + "\n\n";

  // Request headers
  if (req.headers && Object.keys(req.headers).length) {
    out += "\u2500\u2500 REQUEST HEADERS \u2500\u2500\n";
    for (const [k, v] of Object.entries(req.headers)) {
      out += `${k}: ${v}\n`;
    }
    out += "\n";
  }

  // Request body
  const reqBodyText = decodeBodyForNote(req.body);
  if (reqBodyText) {
    out += "\u2500\u2500 REQUEST BODY \u2500\u2500\n";
    out += reqBodyText + "\n\n";
  }

  // Response
  if (resp.status) {
    out += `\u2500\u2500 RESPONSE: ${resp.status} ${resp.statusText || ""} (${resp.durationMs || 0}ms) \u2500\u2500\n\n`;
  } else if (res.error) {
    out += `\u2500\u2500 RESPONSE ERROR: ${res.error} \u2500\u2500\n\n`;
  }

  // Response headers
  if (resp.headers && Object.keys(resp.headers).length) {
    out += "\u2500\u2500 RESPONSE HEADERS \u2500\u2500\n";
    for (const [k, v] of Object.entries(resp.headers)) {
      out += `${k}: ${v}\n`;
    }
    out += "\n";
  }

  // Response body
  if (resp.body && resp.body.bytesBase64) {
    const ct = (resp.headers && (resp.headers["content-type"] || "")) || "";
    const isText = /text|json|xml|html|javascript|css|svg|urlencoded/i.test(ct);
    out += "\u2500\u2500 RESPONSE BODY \u2500\u2500\n";
    if (isText) {
      try { out += atob(resp.body.bytesBase64); } catch (_) { out += resp.body.bytesBase64; }
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
  notesList.innerHTML = "";
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

    // Title row
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

    // Timestamp
    const tsDiv = document.createElement("div");
    tsDiv.className = "small";
    tsDiv.textContent = new Date(note.timestamp).toLocaleString();
    card.appendChild(tsDiv);

    // Request headers (collapsible)
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
      let hText = "";
      for (const [k, v] of Object.entries(req.headers)) hText += `${k}: ${v}\n`;
      pre.textContent = hText;
      det.appendChild(pre);
      card.appendChild(det);
    }

    // Request body
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
      pre.textContent = reqBodyText;
      det.appendChild(pre);
      card.appendChild(det);
    }

    // Response headers
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
      let hText = "";
      for (const [k, v] of Object.entries(resp.headers)) hText += `${k}: ${v}\n`;
      pre.textContent = hText;
      det.appendChild(pre);
      card.appendChild(det);
    }

    // Response body
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
        try { pre.textContent = atob(resp.body.bytesBase64); } catch (_) { pre.textContent = resp.body.bytesBase64; }
      } else {
        pre.textContent = `[binary, ${resp.body.originalBytes || 0} bytes]`;
      }
      det.appendChild(pre);
      card.appendChild(det);
    }

    // Delete button
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

// Realtime updates
port.onMessage.addListener((m) => {
  if (!m || !m.type) return;

  if (m.type === "INIT") {
    interceptEnabled = !!m.payload.interceptEnabled;
    toggleIntercept.checked = interceptEnabled;
    renderQueue(m.payload.queue || []);
    queueSize.textContent = String((m.payload.queue || []).length);
    if (m.payload.policy) policyToForm(m.payload.policy);
  }

  if (m.type === "QUEUE_UPDATED") {
    interceptEnabled = !!m.payload.interceptEnabled;
    toggleIntercept.checked = interceptEnabled;
    queueSize.textContent = String(m.payload.size ?? 0);
    // full refresh to keep simple
    refreshQueue();
  }

  if (m.type === "REQUEST_INTERCEPTED") {
    // fast path: refresh queue
    refreshQueue();
  }

  if (m.type === "REQUEST_UPDATED") {
    // could patch UI if selected; simplest: refresh
    refreshQueue();
  }
  if (m.type === "POLICY_UPDATED") {
    policyToForm(m.payload.policy);
  }


});

// Toggle intercept
toggleIntercept.addEventListener("change", async () => {
  const enabled = toggleIntercept.checked;
  await browser.runtime.sendMessage({ type: "TOGGLE_INTERCEPT", enabled });
  await refreshQueue();
});

// Forward / Drop
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
    headers = parseHeadersJson(reqHeaders.value);
  } catch (e) {
    responseBox.textContent = String(e);
    return;
  }

  // Body strategy:
  // - if looks like JSON in textarea => keep as text
  // - otherwise treat as base64 raw (user can paste raw)
  const bodyText = reqBody.value || "";
  let body = null;

  if (bodyText.trim()) {
    // Try parse as JSON {kind:...} (for formData/raw metadata)
    try {
      const obj = JSON.parse(bodyText);
      if (obj && typeof obj === "object" && obj.kind) {
        body = obj;
      } else {
        body = { kind: "text", text: bodyText };
      }
    } catch (_) {
      // Assume base64 raw
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

  // Save for "Save to Notes"
  lastForwardedRequest = edited;
  lastForwardedResponse = res;
  btnSaveNote.disabled = false;

  setButtonsEnabled(false);
  currentId = null;
  currentEntry = null;
  await refreshQueue();
});

// Drop All / Forward All
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

btnSaveRepeater.addEventListener("click", async () => {
  if (!currentEntry) return;

  let headers;
  try { headers = parseHeadersJson(reqHeaders.value); }
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
    request: {
      method: reqMethod.value.trim() || "GET",
      url: reqUrl.value.trim(),
      headers,
      body
    }
  };

  const res = await browser.runtime.sendMessage({ type: "SAVE_REPEATER_ITEM", item });
  responseBox.textContent = pretty(res);
  flashButton(btnSaveRepeater, "flash-ok");
  await refreshRepeater();
});

// Save to Notes
btnSaveNote.addEventListener("click", async () => {
  if (!lastForwardedRequest && !lastForwardedResponse) return;
  const res = await browser.runtime.sendMessage({
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

// Export Notes
btnExportNotes.addEventListener("click", async () => {
  const res = await browser.runtime.sendMessage({ type: "LIST_NOTES" });
  const notes = res?.notes || [];
  if (!notes.length) {
    responseBox.textContent = "Nessuna nota da esportare.";
    return;
  }

  let txt = "Mobile Interceptor - Notes Export\n";
  txt += "Generated: " + new Date().toLocaleString() + "\n\n";

  for (const note of notes) {
    txt += formatNoteForExport(note);
  }

  const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "interceptor-notes-" + new Date().toISOString().slice(0, 10) + ".txt";
  a.click();
  URL.revokeObjectURL(url);
  flashButton(btnExportNotes, "flash-ok");
});

// Clear Notes
btnClearNotes.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "CLEAR_NOTES" });
  flashButton(btnClearNotes, "flash-danger");
  await refreshNotes();
});

btnRefreshRepeater.addEventListener("click", refreshRepeater);
btnLoadPolicy.addEventListener("click", loadPolicy);
btnSavePolicy.addEventListener("click", savePolicy);

btnPanicOff.addEventListener("click", async () => {
  toggleIntercept.checked = false;
  await browser.runtime.sendMessage({ type: "TOGGLE_INTERCEPT", enabled: false });
  responseBox.textContent = "PANIC: Intercept disabilitato.";
  flashButton(btnPanicOff, "flash-danger");
  await refreshQueue();
});


// Boot
setButtonsEnabled(false);
setBulkButtonsEnabled(false);
btnSaveNote.disabled = true;
refreshQueue();
refreshRepeater();
refreshNotes();
loadPolicy();
