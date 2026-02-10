import type { AuditEntry, HttpResponse, InterceptMode, NoteEntry, Policy, ReplayRequest, RepeaterItem, RequestEntry } from "../lib/types";
import { redactBody, redactHeaders, isSensitiveHeader } from "../lib/redact";
import { bodyToEditor, highlightJson, parseHeadersJson } from "../lib/utils";
import { port, sendMessage } from "./api";
import * as dom from "./dom";
import { uiState } from "./state";

const state = uiState;

// --- Redaction helpers ---
function displayHeaders(headers: Record<string, string> | null | undefined) {
  if (state.showSensitive) return headers;
  return redactHeaders(headers);
}

function displayBody(bodyText: string, contentType?: string) {
  if (state.showSensitive) return bodyText;
  return redactBody(bodyText, contentType);
}

// --- Flash helper ---
function flashButton(btn: HTMLElement, cls = "flash-ok") {
  btn.classList.remove(cls);
  void btn.offsetWidth;
  btn.classList.add(cls);
  btn.addEventListener("animationend", () => btn.classList.remove(cls), { once: true });
}

// --- Clear editor ---
function clearEditor(): void {
  state.currentId = null;
  state.currentEntry = null;
  dom.reqMethod.value = "";
  dom.reqUrl.value = "";
  dom.reqHeaders.value = "";
  dom.reqBody.value = "";
  dom.reqMethod.readOnly = false;
  dom.reqBody.readOnly = false;
  dom.editorReadonlyHint.style.display = "none";
  dom.editorHint.textContent = "Select a request from the Queue.";
  setButtonsEnabled(false);
}

// --- Render response to box (with JSON highlighting) ---
function renderResponseToBox(res: any): void {
  const text = formatResponse(res);
  // Check if response body is JSON for highlighting
  const r = (res && res.response) || res || {};
  const ct = (r.headers && (r.headers["content-type"] || "")) || "";
  if (/json/i.test(ct) && r.body && r.body.bytesBase64) {
    try {
      const decoded = atob(r.body.bytesBase64);
      JSON.parse(decoded); // validate it's JSON
      // Build the non-body part with textContent, then append highlighted body
      const bodyIdx = text.lastIndexOf("--- Response Body ---");
      if (bodyIdx !== -1) {
        const before = text.substring(0, bodyIdx + "--- Response Body ---".length) + "\n";
        const bodyText = displayBody(decoded, ct);
        dom.responseBox.textContent = "";
        const prePart = document.createTextNode(before);
        dom.responseBox.appendChild(prePart);
        const bodySpan = document.createElement("span");
        bodySpan.innerHTML = highlightJson(bodyText);
        dom.responseBox.appendChild(bodySpan);
        return;
      }
    } catch (_) {}
  }
  dom.responseBox.textContent = text;
}

// --- Queue filtering ---
function getFilteredQueue(): RequestEntry[] {
  const term = (dom.queueSearch.value || "").toLowerCase().trim();
  if (!term) return state.cachedQueue;
  return state.cachedQueue.filter(q =>
    (q.method || "").toLowerCase().includes(term) ||
    (q.url || "").toLowerCase().includes(term) ||
    (q.type || "").toLowerCase().includes(term)
  );
}

function renderFilteredQueue(): void {
  renderQueue(getFilteredQueue());
}

// --- Mode UI ---
function updateModeUI(mode: InterceptMode): void {
  state.currentMode = mode;
  dom.interceptModeSelect.value = mode;
  dom.topbar.classList.remove("armed", "observe");
  dom.armedBadge.classList.add("hidden");
  dom.armedBadge.classList.remove("observe-badge");

  if (mode === "INTERCEPT") {
    dom.topbar.classList.add("armed");
    dom.armedBadge.textContent = "ARMED";
    dom.armedBadge.classList.remove("hidden");
  } else if (mode === "OBSERVE") {
    dom.topbar.classList.add("observe");
    dom.armedBadge.textContent = "OBSERVE";
    dom.armedBadge.classList.remove("hidden");
    dom.armedBadge.classList.add("observe-badge");
  }
}

// --- Policy ---
function policyToForm(p: Policy): void {
  dom.scopeMode.value = p.scopeMode || "ALLOWLIST";
  dom.bypassStatic.value = String(!!p.bypassStaticAssets);
  dom.allowDomains.value = (p.allowDomains || []).join("\n");
  dom.allowUrlContains.value = (p.allowUrlContains || []).join("\n");
}

function formToPolicy(): Partial<Policy> {
  return {
    scopeMode: dom.scopeMode.value,
    bypassStaticAssets: dom.bypassStatic.value === "true",
    allowDomains: dom.allowDomains.value.split("\n").map(s => s.trim()).filter(Boolean),
    allowUrlContains: dom.allowUrlContains.value.split("\n").map(s => s.trim()).filter(Boolean)
  };
}

async function loadPolicy(): Promise<void> {
  const res = await sendMessage({ type: "GET_POLICY" });
  if (res?.ok) policyToForm(res.policy);
}

async function savePolicy(): Promise<void> {
  const p = formToPolicy();
  const res = await sendMessage({ type: "SET_POLICY", policy: p });
  dom.responseBox.textContent = pretty(res);
}

function setButtonsEnabled(enabled: boolean): void {
  dom.btnForward.disabled = !enabled;
  dom.btnDrop.disabled = !enabled;
  dom.btnSaveRepeater.disabled = !enabled;
}

function setBulkButtonsEnabled(enabled: boolean): void {
  dom.btnForwardAll.disabled = !enabled;
  dom.btnDropAll.disabled = !enabled;
}

function pretty(obj: unknown): string {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

function formatResponse(res: any): string {
  if (!res) return "No response";
  if (!res.ok && res.error) return `Error: ${res.error}\nDuration: ${res.durationMs}ms`;

  const r = res.response || res;
  if (!r.status) return pretty(res);

  let out = `HTTP ${r.status} ${r.statusText || ""}\n`;
  out += `URL: ${r.url || ""}\n`;
  out += `Duration: ${r.durationMs}ms\n`;

  // Show request headers (contains cookie/authorization → redaction visible here)
  if (state.lastForwardedRequest && state.lastForwardedRequest.headers && Object.keys(state.lastForwardedRequest.headers).length) {
    out += "\n--- Request Headers (sent) ---\n";
    const drh = displayHeaders(state.lastForwardedRequest.headers);
    for (const [k, v] of Object.entries(drh)) out += `${k}: ${v}\n`;
    const reqRedacted = Object.keys(state.lastForwardedRequest.headers).filter(k => isSensitiveHeader(k)).length;
    if (reqRedacted > 0 && !state.showSensitive) out += `(${reqRedacted} header redacted)\n`;
  }

  if (r.headers) {
    out += "\n--- Response Headers ---\n";
    const dh = displayHeaders(r.headers);
    for (const [k, v] of Object.entries(dh)) {
      out += `${k}: ${v}\n`;
    }
    const respRedacted = Object.keys(r.headers).filter(k => isSensitiveHeader(k)).length;
    if (respRedacted > 0 && !state.showSensitive) out += `(${respRedacted} header redacted)\n`;
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
function showCtxMenu(x: number, y: number, entry: RequestEntry): void {
  state.ctxTarget = entry;
  dom.ctxMenu.style.left = x + "px";
  dom.ctxMenu.style.top = y + "px";
  dom.ctxMenu.classList.remove("hidden");
}

function hideCtxMenu(): void {
  dom.ctxMenu.classList.add("hidden");
  state.ctxTarget = null;
}

document.addEventListener("click", (e) => {
  const target = e.target as Node | null;
  if (target && !dom.ctxMenu.contains(target)) hideCtxMenu();
});

dom.ctxAddScope.addEventListener("click", async () => {
  if (!state.ctxTarget || !state.ctxTarget.url) return;
  try {
    const hostname = new URL(state.ctxTarget.url).hostname;
    const current = dom.allowDomains.value.split("\n").map(s => s.trim()).filter(Boolean);
    if (!current.includes(hostname)) {
      current.push(hostname);
      dom.allowDomains.value = current.join("\n");
      await savePolicy();
      flashButton(dom.ctxAddScope, "flash-ok");
    }
  } catch (_) {}
  hideCtxMenu();
});

// --- Queue ---
function renderQueue(queue: RequestEntry[]): void {
  dom.queueSize.textContent = String(state.cachedQueue.length);
  // Only enable bulk actions for non-observe intercepted items
  const hasIntercepted = state.cachedQueue.some(q => !q.observe);
  setBulkButtonsEnabled(hasIntercepted);
  dom.queueList.replaceChildren();

  if (!queue.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "Queue empty.";
    dom.queueList.appendChild(d);
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
    let longPressTimer: number | null = null;
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

    dom.queueList.appendChild(item);
  }
}

function selectEntry(entry: RequestEntry) {
  if (entry.observe) return;
  state.currentId = entry.id;
  state.currentEntry = entry;

  dom.reqMethod.value = entry.method || "GET";
  dom.reqUrl.value = entry.url || "";
  dom.reqHeaders.value = pretty(entry.headers || {});
  dom.reqBody.value = bodyToEditor(entry.requestBody);

  // In INTERCEPT mode: method and body are read-only (hold model)
  dom.reqMethod.readOnly = true;
  dom.reqBody.readOnly = true;
  dom.editorReadonlyHint.style.display = "block";

  dom.editorHint.textContent = `Selected: ${entry.method} ${entry.url}`;
  setButtonsEnabled(true);
}

async function refreshQueue(): Promise<void> {
  const res = await sendMessage({ type: "GET_QUEUE" });
  if (res?.ok) {
    updateModeUI(res.interceptMode || "OFF");
    state.cachedQueue = res.queue || [];
    renderFilteredQueue();
  }
}

// --- Repeater ---
async function refreshRepeater(): Promise<void> {
  const res = await sendMessage({ type: "LIST_REPEATER_ITEMS" });
  dom.repeaterList.replaceChildren();

  const items: RepeaterItem[] = res && res.ok ? res.items : [];
  if (!items.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "Repeater empty.";
    dom.repeaterList.appendChild(d);
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
      dom.responseBox.textContent = "Running...";
      const r = await sendMessage({ type: "RUN_REPEATER_ITEM", request: it.request });
      state.lastForwardedRequest = it.request;
      state.lastForwardedResponse = r;
      renderResponseToBox(r);
      dom.btnSaveNote.disabled = false;
      flashButton(run, "flash-ok");
    });

    const load = document.createElement("button");
    load.textContent = "Load to Editor";
    load.addEventListener("click", () => {
      const req = it.request || {};
      state.currentId = null;
      state.currentEntry = null;
      dom.reqMethod.value = req.method || "GET";
      dom.reqUrl.value = req.url || "";
      dom.reqHeaders.value = pretty(req.headers || {});
      dom.reqBody.value = bodyToEditor(req.body);
      dom.editorHint.textContent = `Loaded from Repeater: ${it.name || "Unnamed"}`;
      setButtonsEnabled(false);
    });

    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await sendMessage({ type: "DELETE_REPEATER_ITEM", id: it.id });
      flashButton(del, "flash-danger");
      await refreshRepeater();
    });

    actions.appendChild(run);
    actions.appendChild(load);
    actions.appendChild(del);

    box.appendChild(top);
    box.appendChild(mid);
    box.appendChild(actions);
    dom.repeaterList.appendChild(box);
  }
}

// --- Notes ---
function decodeBodyForNote(body: any): string {
  if (!body) return "";
  if (body.kind === "text") return body.text || "";
  if ((body.kind === "raw_base64" || body.kind === "raw_base64_truncated") && body.bytesBase64) {
    try { return atob(body.bytesBase64); } catch (_) { return body.bytesBase64; }
  }
  if (body.kind === "formData") return pretty(body.formData);
  return pretty(body);
}

function formatNoteForExport(note: NoteEntry): string {
  const ts = new Date(note.timestamp).toLocaleString("sv-SE");
  const req = note.request || {};
  const res = note.response || {};
  const resp = res.response || res;

  let out = "\u2550".repeat(50) + "\n";
  out += `[${ts}] ${req.method || "?"} ${req.url || "?"}\n`;
  if (note.memo) out += `Memo: ${note.memo}\n`;
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

async function refreshNotes(): Promise<void> {
  const res = await sendMessage({ type: "LIST_NOTES" });
  dom.notesList.replaceChildren();
  const notes: NoteEntry[] = res && res.ok ? res.notes : [];

  if (!notes.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No saved notes.";
    dom.notesList.appendChild(d);
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

    if (note.memo) {
      const memoDiv = document.createElement("div");
      memoDiv.className = "small";
      memoDiv.style.fontStyle = "italic";
      memoDiv.style.color = "var(--accent)";
      memoDiv.textContent = "Memo: " + note.memo;
      card.appendChild(memoDiv);
    }

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
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      await sendMessage({ type: "DELETE_NOTE", id: note.id });
      flashButton(delBtn, "flash-danger");
      await refreshNotes();
    });
    actions.appendChild(delBtn);
    card.appendChild(actions);

    dom.notesList.appendChild(card);
  }
}

// --- Audit Log ---
async function refreshAuditLog(): Promise<void> {
  const res = await sendMessage({ type: "LIST_AUDIT_LOG" });
  dom.auditList.replaceChildren();
  const entries: AuditEntry[] = res && res.ok ? res.log : [];

  if (!entries.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "No audit entries.";
    dom.auditList.appendChild(d);
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

    dom.auditList.appendChild(item);
  }
}

// --- Realtime updates ---
port.onMessage.addListener((m: any) => {
  if (!m || !m.type) return;

  if (m.type === "INIT") {
    updateModeUI(m.payload.interceptMode || "OFF");
    state.cachedQueue = m.payload.queue || [];
    renderFilteredQueue();
    dom.queueSize.textContent = String(state.cachedQueue.length);
    if (m.payload.policy) policyToForm(m.payload.policy);
  }

  if (m.type === "QUEUE_UPDATED") {
    updateModeUI(m.payload.interceptMode || "OFF");
    dom.queueSize.textContent = String(m.payload.size ?? 0);
    refreshQueue();
  }

  if (m.type === "REQUEST_INTERCEPTED") {
    refreshQueue();
  }

  if (m.type === "REQUEST_UPDATED") {
    refreshQueue();
  }

  if (m.type === "RESPONSE_CAPTURED") {
    // Response captured via filterResponseData — could update UI if needed
  }

  if (m.type === "POLICY_UPDATED") {
    policyToForm(m.payload.policy);
  }
});

// --- Mode selector ---
dom.interceptModeSelect.addEventListener("change", async () => {
  const mode = dom.interceptModeSelect.value as InterceptMode;
  await sendMessage({ type: "TOGGLE_INTERCEPT", mode });
  updateModeUI(mode);
  await refreshQueue();
});

// --- Forward / Drop ---
dom.btnDrop.addEventListener("click", async () => {
  if (!state.currentId) return;
  await sendMessage({ type: "DROP_REQUEST", id: state.currentId });
  flashButton(dom.btnDrop, "flash-danger");
  state.currentId = null;
  state.currentEntry = null;
  dom.editorHint.textContent = "Dropped. Select a request from the Queue.";
  setButtonsEnabled(false);
  await refreshQueue();
});

dom.btnForward.addEventListener("click", async () => {
  if (!state.currentId) return;

  let headers: Record<string, string>;
  try {
    headers = parseHeadersJson(dom.reqHeaders.value);
  } catch (e) {
    dom.responseBox.textContent = String(e);
    return;
  }

  dom.responseBox.textContent = "Forwarding...";
  // Hold model: only URL and headers are editable; method/body go through unchanged
  const edited = {
    url: dom.reqUrl.value.trim(),
    headers
  };

  const res = await sendMessage({ type: "FORWARD_REQUEST", id: state.currentId, edited });
  state.lastForwardedRequest = {
    method: state.currentEntry?.method || dom.reqMethod.value.trim() || "GET",
    url: edited.url,
    headers
  };
  state.lastForwardedResponse = res;
  renderResponseToBox(res);
  flashButton(dom.btnForward, "flash-ok");
  dom.btnSaveNote.disabled = false;

  setButtonsEnabled(false);
  clearEditor();
  await refreshQueue();
});

// --- Drop All / Forward All ---
dom.btnDropAll.addEventListener("click", async () => {
  await sendMessage({ type: "DROP_ALL" });
  flashButton(dom.btnDropAll, "flash-danger");
  clearEditor();
  await refreshQueue();
});

dom.btnForwardAll.addEventListener("click", async () => {
  dom.responseBox.textContent = "Forwarding all...";
  const res = await sendMessage({ type: "FORWARD_ALL" });
  const fwd = res && res.ok ? res.forwarded : 0;
  const fail = res && res.ok ? res.failed : 0;
  dom.responseBox.textContent = fail > 0
    ? `Forwarded ${fwd}, failed ${fail}.`
    : `Forwarded ${fwd} requests.`;
  flashButton(dom.btnForwardAll, "flash-ok");
  clearEditor();
  await refreshQueue();
});

// --- Save to Repeater ---
dom.btnSaveRepeater.addEventListener("click", async () => {
  if (!state.currentEntry) return;

  let headers: Record<string, string>;
  try { headers = parseHeadersJson(dom.reqHeaders.value); }
  catch (e) { dom.responseBox.textContent = String(e); return; }

  const name = `${dom.reqMethod.value.toUpperCase()} ${new URL(dom.reqUrl.value).pathname}`.slice(0, 80);
  const bodyText = dom.reqBody.value || "";
  let body: ReplayRequest["body"] | null = null;
  if (bodyText.trim()) {
    try {
      const obj = JSON.parse(bodyText);
      body = (obj && obj.kind) ? obj : { kind: "text", text: bodyText };
    } catch (_) {
      body = { kind: "raw_base64", bytesBase64: bodyText.trim() };
    }
  }

  const item: RepeaterItem = {
    name,
    request: { method: dom.reqMethod.value.trim() || "GET", url: dom.reqUrl.value.trim(), headers, body }
  };

  const res = await sendMessage({ type: "SAVE_REPEATER_ITEM", item });
  dom.responseBox.textContent = pretty(res);
  flashButton(dom.btnSaveRepeater, "flash-ok");
  await refreshRepeater();
});

// --- Save to Notes ---
dom.btnSaveNote.addEventListener("click", async () => {
  if (!state.lastForwardedRequest && !state.lastForwardedResponse) return;
  await sendMessage({
    type: "SAVE_NOTE",
    memo: dom.noteMemo.value.trim(),
    request: state.lastForwardedRequest,
    response: state.lastForwardedResponse
  });
  flashButton(dom.btnSaveNote, "flash-ok");
  dom.btnSaveNote.disabled = true;
  dom.noteMemo.value = "";
  state.lastForwardedRequest = null;
  state.lastForwardedResponse = null;
  await refreshNotes();
});

// --- Export Notes ---
dom.btnExportNotes.addEventListener("click", async () => {
  const res = await sendMessage({ type: "LIST_NOTES" });
  const notes: NoteEntry[] = res && res.ok ? res.notes : [];
  if (!notes.length) {
    dom.responseBox.textContent = "No notes to export.";
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
  flashButton(dom.btnExportNotes, "flash-ok");
});

// --- Clear Notes ---
dom.btnClearNotes.addEventListener("click", async () => {
  await sendMessage({ type: "CLEAR_NOTES" });
  flashButton(dom.btnClearNotes, "flash-danger");
  await refreshNotes();
});

// --- Show sensitive toggle ---
dom.toggleSensitive.addEventListener("change", () => {
  state.showSensitive = dom.toggleSensitive.checked;
  const label = dom.toggleSensitive.parentElement?.querySelector("span");
  if (label) {
    label.textContent = state.showSensitive ? "Sensitive: VISIBLE" : "Sensitive: HIDDEN";
  }
  refreshNotes();
  // Re-render response box if we have cached response
  if (state.lastForwardedResponse) {
    renderResponseToBox(state.lastForwardedResponse);
  }
});

// --- Audit log buttons ---
dom.btnRefreshAudit.addEventListener("click", refreshAuditLog);
dom.btnClearAudit.addEventListener("click", async () => {
  await sendMessage({ type: "CLEAR_AUDIT_LOG" });
  flashButton(dom.btnClearAudit, "flash-danger");
  await refreshAuditLog();
});

// --- Other button handlers ---
dom.btnRefreshRepeater.addEventListener("click", refreshRepeater);
dom.btnLoadPolicy.addEventListener("click", loadPolicy);
dom.btnSavePolicy.addEventListener("click", savePolicy);

dom.btnPanicOff.addEventListener("click", async () => {
  dom.interceptModeSelect.value = "OFF";
  await sendMessage({ type: "TOGGLE_INTERCEPT", mode: "OFF" });
  updateModeUI("OFF");
  dom.responseBox.textContent = "PANIC: Intercept disabled.";
  flashButton(dom.btnPanicOff, "flash-danger");
  await refreshQueue();
});

// --- Disclaimer ---
(async function initDisclaimer() {
  const disclaimerEl = dom.disclaimerEl;
  const btnDismiss = dom.btnDismissDisclaimer;
  if (!disclaimerEl || !btnDismiss) return;
  try {
    const stored = await browser.storage.local.get("disclaimerDismissed");
    if (!stored.disclaimerDismissed) disclaimerEl.classList.remove("hidden");
  } catch (e) {
    disclaimerEl.classList.remove("hidden");
  }
  btnDismiss.addEventListener("click", async () => {
    disclaimerEl.classList.add("hidden");
    try {
      await browser.storage.local.set({ disclaimerDismissed: true });
    } catch (e) {
      console.debug("[MI] disclaimer storage write:", e);
    }
  });
})();

// --- Queue search ---
dom.queueSearch.addEventListener("input", renderFilteredQueue);

// --- Export Repeater ---
dom.btnExportRepeater.addEventListener("click", async () => {
  const res = await sendMessage({ type: "LIST_REPEATER_ITEMS" });
  const items: RepeaterItem[] = res && res.ok ? res.items : [];
  if (!items.length) {
    dom.responseBox.textContent = "No repeater items to export.";
    return;
  }
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "repeater-export-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(url);
  flashButton(dom.btnExportRepeater, "flash-ok");
});

// --- Import Repeater ---
dom.btnImportRepeater.addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement | null;
  const file = input?.files && input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const items = JSON.parse(text);
    if (!Array.isArray(items)) throw new Error("Expected JSON array");
    let imported = 0;
    for (const it of items) {
      if (!it.request) continue;
      await sendMessage({ type: "SAVE_REPEATER_ITEM", item: it });
      imported++;
    }
    dom.responseBox.textContent = `Imported ${imported} repeater items.`;
    await refreshRepeater();
  } catch (err) {
    dom.responseBox.textContent = "Import error: " + String(err);
  }
  dom.btnImportRepeater.value = "";
});

// --- Boot ---
setButtonsEnabled(false);
setBulkButtonsEnabled(false);
dom.btnSaveNote.disabled = true;
refreshQueue();
refreshRepeater();
refreshNotes();
refreshAuditLog();
loadPolicy();
