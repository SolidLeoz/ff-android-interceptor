/* background.js
 * Mobile Interceptor (PT) - Firefox Android
 * Pattern: cancel original request -> replay via fetch after user edits.
 *
 * Shared modules loaded before this file (via manifest.json):
 * - lib/redact.js  -> globalThis.MILib  (redactHeaders, redactBody, trimArray, createRateLimiter)
 * - lib/utils.js   -> globalThis.MIUtils (normalizeHeaders, hostMatchesWildcard, isStaticAssetUrl, shouldInterceptWith, parseHeadersJson, bodyToEditor)
 */

"use strict";

// --- Retention limits ---
const RETENTION = {
  notes: 200,
  repeater: 50,
  audit: 500
};

const OBSERVE_QUEUE_MAX = 100;

const state = {
  // "OFF" | "OBSERVE" | "INTERCEPT"
  interceptMode: "OFF",

  // Map requestId -> entry captured from webRequest
  pending: new Map(),

  // Queue of requestIds in arrival order
  queue: [],

  // Dashboard ports
  ports: new Set(),

  // TabIds that bypass interception temporarily (after Forward)
  passthrough: new Map(),

  // Timers for passthrough auto-cleanup
  passthroughTimers: new Map(),

  // Soft limits
  maxBodyCaptureBytes: 1024 * 256,
  maxResponseBytes: 1024 * 512
};

// --- Rate limiter for replay ---
const replayLimiter = MILib.createRateLimiter(200, 60);

// --- Interception Policy ---
const policy = {
  scopeMode: "ALLOWLIST",
  allowDomains: [],
  allowUrlContains: [],
  bypassStaticAssets: true,
  bypassTypes: ["image", "stylesheet", "font", "media"],
  bypassOptions: true
};

const POLICY_KEY = "interceptorPolicy";
const AUDIT_KEY = "interceptorAuditLog";

(async function loadPolicy() {
  try {
    const cur = await browser.storage.local.get(POLICY_KEY);
    if (cur && cur[POLICY_KEY]) Object.assign(policy, cur[POLICY_KEY]);
  } catch (e) { console.warn("[MI] loadPolicy failed:", e); }
})();

async function savePolicy() {
  try {
    await browser.storage.local.set({ [POLICY_KEY]: policy });
    return true;
  } catch (e) {
    console.warn("[MI] savePolicy failed:", e);
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function safeClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function genId() {
  return (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
}

function bufToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function denormalizeHeaders(headersObj) {
  const h = new Headers();
  for (const [k, v] of Object.entries(headersObj || {})) {
    try { h.set(k, String(v)); } catch (e) { console.debug("[MI] header set failed:", k, e); }
  }
  return h;
}

function mergeChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return merged.buffer;
}

function headersObjToArray(obj) {
  return Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
}

async function waitForCapturedResponse(entry, timeoutMs) {
  const start = Date.now();
  while (!entry.capturedResponse && (Date.now() - start) < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (!entry.capturedResponse) {
    return { ok: true, status: 0, note: "Response timed out or not captured" };
  }
  const bytes = new Uint8Array(entry.capturedResponse);
  const truncated = bytes.length > state.maxResponseBytes;
  const sliced = truncated ? bytes.slice(0, state.maxResponseBytes) : bytes;
  return {
    ok: true,
    status: entry.capturedStatus || 0,
    statusText: entry.capturedStatusText || "",
    headers: entry.capturedResponseHeaders || {},
    body: {
      kind: "raw_base64",
      bytesBase64: bufToBase64(sliced.buffer),
      originalBytes: bytes.length,
      capturedBytes: sliced.length,
      truncated
    },
    durationMs: Date.now() - new Date(entry.time).getTime()
  };
}

function setPassthrough(tabId, entry) {
  state.passthrough.set(tabId, entry);
  // Clear any existing timer for this tab
  const existing = state.passthroughTimers.get(tabId);
  if (existing) clearTimeout(existing);
  // Auto-delete after 35s
  const timer = setTimeout(() => {
    state.passthrough.delete(tabId);
    state.passthroughTimers.delete(tabId);
  }, 35000);
  state.passthroughTimers.set(tabId, timer);
}

/**
 * Capture request body from webRequest details.
 * @param {object} details - webRequest details
 * @param {number} maxBytes - max bytes to capture
 * @param {boolean} deferRaw - if true, return rawCopy/rawOrigLen for deferred processing
 * @returns {{ body: object|null, hint: string|null, rawCopy: Uint8Array|null, rawOrigLen: number }}
 */
function captureRequestBody(details, maxBytes, deferRaw) {
  var result = { body: null, hint: null, rawCopy: null, rawOrigLen: 0 };
  if (!details.requestBody) return result;
  try {
    if (details.requestBody.raw && details.requestBody.raw.length > 0) {
      var first = details.requestBody.raw[0]?.bytes;
      if (first) {
        var bytesLen = first.byteLength || 0;
        if (deferRaw) {
          result.rawOrigLen = bytesLen;
          result.rawCopy = new Uint8Array(first).slice(0, Math.min(bytesLen, maxBytes));
        } else if (bytesLen > maxBytes) {
          result.body = {
            kind: "raw_base64_truncated",
            bytesBase64: bufToBase64(first.slice(0, maxBytes)),
            originalBytes: bytesLen,
            capturedBytes: maxBytes
          };
          result.hint = "RAW body > cap (" + bytesLen + " bytes). Truncated to " + maxBytes + ".";
        } else {
          result.body = {
            kind: "raw_base64",
            bytesBase64: bufToBase64(first),
            originalBytes: bytesLen,
            capturedBytes: bytesLen
          };
          result.hint = "RAW body captured (" + bytesLen + " bytes).";
        }
      }
    } else if (details.requestBody.formData) {
      result.body = { kind: "formData", formData: safeClone(details.requestBody.formData) };
      result.hint = "formData captured (key/value). Multipart file parts are NOT available here.";
    }
  } catch (e) {
    result.hint = "Body capture error: " + String(e);
  }
  return result;
}

function broadcast(type, payload) {
  for (const p of state.ports) {
    try { p.postMessage({ type, payload }); } catch (e) { console.debug("[MI] port.postMessage failed:", e); }
  }
}

function broadcastQueue() {
  broadcast("QUEUE_UPDATED", {
    interceptMode: state.interceptMode,
    size: state.queue.length
  });
}

// --- Audit log ---
async function appendAuditLog(action, details) {
  try {
    const redacted = Object.assign({}, details);
    if (redacted.url) redacted.url = MILib.redactUrl(redacted.url);
    const cur = await browser.storage.local.get(AUDIT_KEY);
    let log = Array.isArray(cur[AUDIT_KEY]) ? cur[AUDIT_KEY] : [];
    log.push({ timestamp: nowIso(), action, ...redacted });
    log = MILib.trimArray(log, RETENTION.audit);
    await browser.storage.local.set({ [AUDIT_KEY]: log });
  } catch (e) { console.warn("[MI] appendAuditLog failed:", e); }
}

// Android-safe: open dashboard in a tab
async function openDashboardTab() {
  const url = browser.runtime.getURL("ui/dashboard.html");
  try {
    const tabs = await browser.tabs.query({});
    const existing = tabs.find(t => (t.url || "").startsWith(url));
    if (existing && existing.id) {
      await browser.tabs.update(existing.id, { active: true });
      return;
    }
  } catch (e) { console.warn("[MI] openDashboardTab query failed:", e); }
  await browser.tabs.create({ url });
}

// --- Capture body: onBeforeRequest ---
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!details.url.startsWith("http")) return {};
    if (details.originUrl && details.originUrl.startsWith("moz-extension://")) return {};

    const pt = state.passthrough.get(details.tabId);
    if (pt) {
      const elapsed = Date.now() - pt.time;
      // Safety: expire after 30s no matter what
      if (elapsed > 30000) {
        state.passthrough.delete(details.tabId);
      } else if (details.type === "main_frame") {
        // First main_frame for the forwarded URL -> let through, mark done
        if (!pt.mainFrameDone && details.url === pt.url) {
          pt.mainFrameDone = true;
          pt.mainFrameTime = Date.now();
          return {};
        }
        // Any other main_frame (different URL, or same URL again) -> intercept
        state.passthrough.delete(details.tabId);
      } else {
        // Sub-resource: let through only if main_frame loaded and within 10s
        if (pt.mainFrameDone && (Date.now() - pt.mainFrameTime) < 10000) {
          return {};
        }
        state.passthrough.delete(details.tabId);
      }
    }

    if (state.interceptMode === "OFF") return {};
    if (!MIUtils.shouldInterceptWith(details, policy)) return {};

    const isObserve = state.interceptMode === "OBSERVE";

    const entry = {
      id: details.requestId,
      time: nowIso(),
      tabId: details.tabId,
      frameId: details.frameId,
      type: details.type,
      method: details.method,
      url: details.url,
      requestBody: null,
      bodyHint: null,
      headers: null,
      observe: isObserve,
      capturedFrom: "onBeforeRequest",
      note: isObserve ? "Observed (read-only)" : "Intercepted; awaiting user action"
    };

    // --- INTERCEPT: HOLD via Promise (request stays pending until Forward/Drop) ---
    if (!isObserve) {
      const cap = captureRequestBody(details, state.maxBodyCaptureBytes, false);
      if (cap.body) entry.requestBody = cap.body;
      if (cap.hint) entry.bodyHint = cap.hint;

      // Set up response filter (captures response for dashboard, pass-through to page)
      try {
        const filter = browser.webRequest.filterResponseData(details.requestId);
        const responseChunks = [];
        filter.ondata = (event) => {
          responseChunks.push(new Uint8Array(event.data));
          filter.write(event.data); // pass-through to page
        };
        filter.onstop = () => {
          filter.close();
          const merged = mergeChunks(responseChunks);
          entry.capturedResponse = merged; // ArrayBuffer
          broadcast("RESPONSE_CAPTURED", { id: entry.id });
        };
        filter.onerror = () => {
          try { filter.close(); } catch (_) {}
        };
      } catch (e) {
        console.warn("[MI] filterResponseData not available:", e);
      }

      state.pending.set(details.requestId, entry);
      state.queue.push(details.requestId);

      // Enforce max queue size
      if (state.queue.length > OBSERVE_QUEUE_MAX) {
        const oldId = state.queue.shift();
        const oldEntry = state.pending.get(oldId);
        if (oldEntry && oldEntry.holdResolve) {
          if (oldEntry.holdTimer) clearTimeout(oldEntry.holdTimer);
          oldEntry.holdResolve({});
          oldEntry.holdResolve = null;
        }
        state.pending.delete(oldId);
      }

      // HOLD: return Promise, resolved by FORWARD/DROP handler
      return new Promise((resolve) => {
        entry.holdResolve = resolve;
        // Safety timeout: auto-forward after 60s
        entry.holdTimer = setTimeout(() => {
          if (entry.holdResolve) {
            entry.holdResolve({});
            entry.holdResolve = null;
          }
        }, 60000);

        // Deferred broadcast (notify dashboard)
        setTimeout(() => {
          console.log("[MI] HELD in onBeforeRequest", details.requestId, details.url);
          broadcastQueue();
          broadcast("REQUEST_INTERCEPTED", { entry: safeClone(entry) });
        }, 0);
      });
    }

    // --- OBSERVE: no timing pressure, process body normally ---
    const cap = captureRequestBody(details, state.maxBodyCaptureBytes, false);
    if (cap.body) entry.requestBody = cap.body;
    if (cap.hint) entry.bodyHint = cap.hint;

    state.pending.set(details.requestId, entry);
    state.queue.push(details.requestId);

    // Auto-trim OBSERVE queue
    if (state.queue.length > OBSERVE_QUEUE_MAX) {
      const oldId = state.queue.shift();
      state.pending.delete(oldId);
    }

    console.log("[MI] captured", details.requestId, details.method, details.url, "mode:", state.interceptMode, "OBSERVE");

    broadcastQueue();
    broadcast("REQUEST_INTERCEPTED", { entry });

    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestBody"]
);

// --- Capture headers (blocking: can modify headers for held requests) ---
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      const entry = state.pending.get(details.requestId);
      if (!entry) return {};
      // Capture original headers
      entry.headers = MIUtils.normalizeHeaders(details.requestHeaders);
      broadcast("REQUEST_UPDATED", { id: entry.id, patch: { headers: entry.headers } });
      // Apply edited headers if user modified them
      if (entry.editedHeaders) {
        return { requestHeaders: headersObjToArray(entry.editedHeaders) };
      }
      return {};
    } catch (e) {
      console.error("[MI] onBeforeSendHeaders error:", e);
      return {};
    }
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestHeaders"]
);

// --- Capture response status and headers ---
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    const entry = state.pending.get(details.requestId);
    if (!entry) return;
    entry.capturedStatus = details.statusCode;
    entry.capturedStatusText = details.statusLine;
    entry.capturedResponseHeaders = MIUtils.normalizeHeaders(details.responseHeaders);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Auto-forward held requests when their tab is closed
browser.tabs.onRemoved.addListener((tabId) => {
  for (const [id, entry] of state.pending.entries()) {
    if (entry.tabId === tabId && entry.holdResolve) {
      if (entry.holdTimer) clearTimeout(entry.holdTimer);
      entry.holdResolve({});
      entry.holdResolve = null;
      state.pending.delete(id);
      state.queue = state.queue.filter(x => x !== id);
    }
  }
  broadcastQueue();
});

// Browser action opens dashboard
if (browser.browserAction && browser.browserAction.onClicked) {
  browser.browserAction.onClicked.addListener(() => {
    openDashboardTab().catch(e => console.log("[MI] openDashboardTab error:", e));
  });
}

// Port connection from dashboard
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "dashboard") return;

  state.ports.add(port);
  port.onDisconnect.addListener(() => state.ports.delete(port));

  port.postMessage({
    type: "INIT",
    payload: {
      interceptMode: state.interceptMode,
      queue: state.queue.map((id) => state.pending.get(id)).filter(Boolean),
      policy
    }
  });
});

// --- Messages from UI ---
browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg || !msg.type) return { ok: false, error: "Missing msg.type" };

  switch (msg.type) {
    case "OPEN_DASHBOARD": {
      await openDashboardTab();
      return { ok: true };
    }

    case "TOGGLE_INTERCEPT": {
      // Support new mode string or legacy boolean
      if (msg.mode) {
        state.interceptMode = msg.mode;
      } else {
        state.interceptMode = msg.enabled ? "INTERCEPT" : "OFF";
      }
      if (state.interceptMode !== "INTERCEPT") {
        // Auto-forward all held requests
        for (const entry of state.pending.values()) {
          if (entry.holdResolve) {
            if (entry.holdTimer) clearTimeout(entry.holdTimer);
            entry.holdResolve({});
            entry.holdResolve = null;
          }
        }
        state.pending.clear();
        state.queue = [];
      }
      broadcastQueue();
      appendAuditLog("TOGGLE_INTERCEPT", { mode: state.interceptMode });
      return { ok: true, interceptMode: state.interceptMode };
    }

    case "GET_QUEUE": {
      const queueEntries = state.queue.map((id) => state.pending.get(id)).filter(Boolean);
      return { ok: true, interceptMode: state.interceptMode, queue: queueEntries };
    }

    case "DROP_REQUEST": {
      const id = msg.id;
      const entry = state.pending.get(id);

      if (entry && entry.holdResolve) {
        if (entry.holdTimer) clearTimeout(entry.holdTimer);
        entry.holdResolve({ cancel: true });
        entry.holdResolve = null;
      }

      state.pending.delete(id);
      state.queue = state.queue.filter((x) => x !== id);
      broadcastQueue();

      if (entry && entry.tabId > 0 && entry.type === "main_frame") {
        const now = Date.now();
        setPassthrough(entry.tabId, { url: "about:blank", time: now, mainFrameDone: true, mainFrameTime: now });
        try { await browser.tabs.update(entry.tabId, { url: "about:blank" }); } catch (e) { console.debug("[MI] tabs.update failed:", e); }
      }

      appendAuditLog("DROP", { requestId: id, method: entry?.method, url: entry?.url });
      return { ok: true };
    }

    case "FORWARD_REQUEST": {
      const id = msg.id;
      const edited = msg.edited;
      const entry = state.pending.get(id);
      if (!entry || !entry.holdResolve) {
        return { ok: false, error: "Request not held" };
      }

      // Store edited headers for onBeforeSendHeaders
      if (edited.headers) entry.editedHeaders = edited.headers;

      // Clear safety timer
      if (entry.holdTimer) clearTimeout(entry.holdTimer);

      // Resolve the held promise
      if (edited.url && edited.url !== entry.url) {
        entry.holdResolve({ redirectUrl: edited.url });
      } else {
        entry.holdResolve({});
      }
      entry.holdResolve = null;

      // If main_frame, set passthrough for sub-resources
      if (entry.tabId > 0 && entry.type === "main_frame") {
        setPassthrough(entry.tabId, {
          url: edited.url || entry.url,
          time: Date.now(),
          mainFrameDone: true,
          mainFrameTime: Date.now()
        });
      }

      state.queue = state.queue.filter((x) => x !== id);
      broadcastQueue();

      // Wait for response capture (filterResponseData)
      const resp = await waitForCapturedResponse(entry, 30000);
      state.pending.delete(id);

      appendAuditLog("FORWARD", { requestId: id, method: entry.method, url: edited.url || entry.url });
      return { ok: true, response: resp };
    }

    case "SAVE_REPEATER_ITEM": {
      try {
        const item = msg.item;
        const key = "repeaterItems";
        const cur = await browser.storage.local.get(key);
        let arr = Array.isArray(cur[key]) ? cur[key] : [];
        arr.push({ ...item, savedAt: nowIso(), id: genId() });
        arr = MILib.trimArray(arr, RETENTION.repeater);
        await browser.storage.local.set({ [key]: arr });
        return { ok: true, count: arr.length };
      } catch (e) { return { ok: false, error: String(e) }; }
    }

    case "LIST_REPEATER_ITEMS": {
      const key = "repeaterItems";
      const cur = await browser.storage.local.get(key);
      return { ok: true, items: Array.isArray(cur[key]) ? cur[key] : [] };
    }

    case "RUN_REPEATER_ITEM": {
      const request = msg.request;
      const resp = await replayRequest(request);
      return { ok: true, response: resp };
    }

    case "DELETE_REPEATER_ITEM": {
      try {
        const key = "repeaterItems";
        const cur = await browser.storage.local.get(key);
        const arr = Array.isArray(cur[key]) ? cur[key] : [];
        const next = arr.filter((x) => x.id !== msg.id);
        await browser.storage.local.set({ [key]: next });
        return { ok: true, count: next.length };
      } catch (e) { return { ok: false, error: String(e) }; }
    }

    case "GET_POLICY": {
      return { ok: true, policy };
    }

    case "SET_POLICY": {
      const POLICY_KEYS = ["scopeMode", "allowDomains", "allowUrlContains", "bypassStaticAssets", "bypassTypes", "bypassOptions"];
      const incoming = msg.policy || {};
      for (const k of POLICY_KEYS) {
        if (k in incoming) policy[k] = incoming[k];
      }
      await savePolicy();
      broadcast("POLICY_UPDATED", { policy });
      appendAuditLog("POLICY_CHANGE", { scopeMode: policy.scopeMode, domainCount: policy.allowDomains.length });
      return { ok: true, policy };
    }

    case "DROP_ALL": {
      const count = state.queue.length;
      for (const id of state.queue) {
        const entry = state.pending.get(id);
        if (!entry) continue;
        // Resolve held promise with cancel
        if (entry.holdResolve) {
          if (entry.holdTimer) clearTimeout(entry.holdTimer);
          entry.holdResolve({ cancel: true });
          entry.holdResolve = null;
        }
        if (entry.tabId > 0 && entry.type === "main_frame") {
          const now = Date.now();
          setPassthrough(entry.tabId, { url: "about:blank", time: now, mainFrameDone: true, mainFrameTime: now });
          try { await browser.tabs.update(entry.tabId, { url: "about:blank" }); } catch (e) { console.debug("[MI] tabs.update failed:", e); }
        }
      }
      state.pending.clear();
      state.queue = [];
      broadcastQueue();
      appendAuditLog("DROP_ALL", { count });
      return { ok: true };
    }

    case "FORWARD_ALL": {
      let succeeded = 0;
      const ids = [...state.queue];
      const forwardedIds = [];
      for (const id of ids) {
        const entry = state.pending.get(id);
        if (!entry) continue;

        // Resolve held promise (proceed without edits)
        if (entry.holdResolve) {
          if (entry.holdTimer) clearTimeout(entry.holdTimer);
          entry.holdResolve({});
          entry.holdResolve = null;
        }

        if (entry.tabId > 0 && entry.type === "main_frame") {
          setPassthrough(entry.tabId, {
            url: entry.url,
            time: Date.now(),
            mainFrameDone: true,
            mainFrameTime: Date.now()
          });
        }

        forwardedIds.push(id);
        succeeded++;
      }
      // Clear queue immediately for UI, but keep entries in pending
      // so onBeforeSendHeaders / onHeadersReceived / filterResponseData
      // can still find them. Deferred cleanup after 35s.
      state.queue = [];
      broadcastQueue();
      setTimeout(() => {
        for (const id of forwardedIds) state.pending.delete(id);
      }, 35000);
      appendAuditLog("FORWARD_ALL", { count: succeeded });
      return { ok: true, forwarded: succeeded, failed: 0 };
    }

    case "SAVE_NOTE": {
      try {
        const noteKey = "interceptorNotes";
        const cur = await browser.storage.local.get(noteKey);
        let arr = Array.isArray(cur[noteKey]) ? cur[noteKey] : [];
        arr.push({
          id: genId(),
          timestamp: nowIso(),
          memo: msg.memo || "",
          request: msg.request || null,
          response: msg.response || null
        });
        arr = MILib.trimArray(arr, RETENTION.notes);
        await browser.storage.local.set({ [noteKey]: arr });
        return { ok: true, count: arr.length };
      } catch (e) { return { ok: false, error: String(e) }; }
    }

    case "LIST_NOTES": {
      const noteKey = "interceptorNotes";
      const cur = await browser.storage.local.get(noteKey);
      return { ok: true, notes: Array.isArray(cur[noteKey]) ? cur[noteKey] : [] };
    }

    case "DELETE_NOTE": {
      try {
        const noteKey = "interceptorNotes";
        const cur = await browser.storage.local.get(noteKey);
        const arr = Array.isArray(cur[noteKey]) ? cur[noteKey] : [];
        const next = arr.filter((x) => x.id !== msg.id);
        await browser.storage.local.set({ [noteKey]: next });
        return { ok: true, count: next.length };
      } catch (e) { return { ok: false, error: String(e) }; }
    }

    case "CLEAR_NOTES": {
      try {
        await browser.storage.local.set({ interceptorNotes: [] });
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    }

    case "LIST_AUDIT_LOG": {
      const cur = await browser.storage.local.get(AUDIT_KEY);
      return { ok: true, log: Array.isArray(cur[AUDIT_KEY]) ? cur[AUDIT_KEY] : [] };
    }

    case "CLEAR_AUDIT_LOG": {
      try {
        await browser.storage.local.set({ [AUDIT_KEY]: [] });
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    }

    default:
      return { ok: false, error: "Unknown message type" };
  }
});

// --- Replay logic ---
async function replayRequest(req) {
  if (!replayLimiter.canProceed()) {
    return { ok: false, error: "Rate limited. Wait before replaying.", durationMs: 0 };
  }
  replayLimiter.record();

  const method = (req.method || "GET").toUpperCase();
  const url = req.url;

  if (typeof url !== "string" || !(url.startsWith("http://") || url.startsWith("https://"))) {
    return { ok: false, error: "Invalid URL scheme. Only http:// and https:// are allowed.", durationMs: 0 };
  }

  const headersObj = req.headers || {};
  const headers = denormalizeHeaders(headersObj);

  let body = undefined;
  if (req.body && method !== "GET" && method !== "HEAD") {
    const b = req.body;

    if (b.kind === "raw_base64" || b.kind === "raw_base64_truncated") {
      body = base64ToBuf(b.bytesBase64);
    } else if (b.kind === "text") {
      body = b.text;
    } else if (b.kind === "formData") {
      const usp = new URLSearchParams();
      for (const [k, vals] of Object.entries(b.formData || {})) {
        for (const v of (vals || [])) usp.append(k, v);
      }
      body = usp.toString();
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
      }
    }
  }

  const controller = new AbortController();
  const timeoutMs = 30_000;
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      credentials: "include",
      signal: controller.signal
    });

    const respHeaders = {};
    res.headers.forEach((v, k) => { respHeaders[k] = v; });

    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    const truncated = bytes.length > state.maxResponseBytes;
    const sliced = truncated ? bytes.slice(0, state.maxResponseBytes) : bytes;
    const respB64 = bufToBase64(sliced.buffer);

    return {
      ok: true,
      url: res.url,
      status: res.status,
      statusText: res.statusText,
      headers: respHeaders,
      body: {
        kind: "raw_base64",
        bytesBase64: respB64,
        originalBytes: bytes.length,
        capturedBytes: sliced.length,
        truncated
      },
      durationMs: Date.now() - startedAt
    };

  } catch (e) {
    return { ok: false, error: String(e), durationMs: Date.now() - startedAt };

  } finally {
    clearTimeout(timer);
  }
}
