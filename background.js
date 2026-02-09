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
  await browser.storage.local.set({ [POLICY_KEY]: policy });
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
    const cur = await browser.storage.local.get(AUDIT_KEY);
    let log = Array.isArray(cur[AUDIT_KEY]) ? cur[AUDIT_KEY] : [];
    log.push({ timestamp: nowIso(), action, ...details });
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

    // --- INTERCEPT: cancel IMMEDIATELY, defer all I/O ---
    if (!isObserve) {
      // Copy body bytes synchronously (ArrayBuffer may be GC'd after return)
      let rawCopy = null;
      let rawOrigLen = 0;
      if (details.requestBody) {
        try {
          if (details.requestBody.raw && details.requestBody.raw.length > 0) {
            const first = details.requestBody.raw[0]?.bytes;
            if (first) {
              rawOrigLen = first.byteLength || 0;
              rawCopy = new Uint8Array(first).slice(0, Math.min(rawOrigLen, state.maxBodyCaptureBytes));
            }
          } else if (details.requestBody.formData) {
            entry.requestBody = { kind: "formData", formData: safeClone(details.requestBody.formData) };
          }
        } catch (e) { entry.bodyHint = "Body capture error: " + String(e); }
      }

      state.pending.set(details.requestId, entry);
      state.queue.push(details.requestId);

      // CANCEL IMMEDIATELY — no I/O before this point
      const cancelResponse = { cancel: true };

      // Heavy work AFTER the return via setTimeout
      setTimeout(() => {
        if (rawCopy) {
          entry.requestBody = {
            kind: rawCopy.length < rawOrigLen ? "raw_base64_truncated" : "raw_base64",
            bytesBase64: bufToBase64(rawCopy.buffer),
            originalBytes: rawOrigLen,
            capturedBytes: rawCopy.length
          };
          entry.bodyHint = rawCopy.length < rawOrigLen
            ? `RAW body > cap (${rawOrigLen} bytes). Truncated to ${rawCopy.length}.`
            : `RAW body captured (${rawOrigLen} bytes).`;
        }
        console.log("[MI] BLOCKED in onBeforeRequest", details.requestId, details.url);
        broadcastQueue();
        broadcast("REQUEST_INTERCEPTED", { entry });
      }, 0);

      return cancelResponse;
    }

    // --- OBSERVE: no timing pressure, process body normally ---
    if (details.requestBody) {
      try {
        if (details.requestBody.raw && details.requestBody.raw.length > 0) {
          const first = details.requestBody.raw[0]?.bytes;
          if (first) {
            const bytesLen = first.byteLength || 0;
            if (bytesLen > state.maxBodyCaptureBytes) {
              entry.requestBody = {
                kind: "raw_base64_truncated",
                bytesBase64: bufToBase64(first.slice(0, state.maxBodyCaptureBytes)),
                originalBytes: bytesLen,
                capturedBytes: state.maxBodyCaptureBytes
              };
              entry.bodyHint = `RAW body > cap (${bytesLen} bytes). Truncated to ${state.maxBodyCaptureBytes}.`;
            } else {
              entry.requestBody = {
                kind: "raw_base64",
                bytesBase64: bufToBase64(first),
                originalBytes: bytesLen,
                capturedBytes: bytesLen
              };
              entry.bodyHint = `RAW body captured (${bytesLen} bytes).`;
            }
          }
        } else if (details.requestBody.formData) {
          entry.requestBody = { kind: "formData", formData: safeClone(details.requestBody.formData) };
          entry.bodyHint = "formData captured (key/value). Multipart file parts are NOT available here.";
        }
      } catch (e) {
        entry.bodyHint = `Body capture error: ${String(e)}`;
      }
    }

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

// --- Capture headers (non-blocking, fires only for OBSERVE / passthrough) ---
// In INTERCEPT mode, requests are cancelled in onBeforeRequest so this never fires.
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    try {
      const entry = state.pending.get(details.requestId);
      if (!entry) return;
      entry.headers = MIUtils.normalizeHeaders(details.requestHeaders);
      broadcast("REQUEST_UPDATED", { id: entry.id, patch: { headers: entry.headers } });
    } catch (e) {
      console.error("[MI] onBeforeSendHeaders error:", e);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

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
      state.pending.delete(id);
      state.queue = state.queue.filter((x) => x !== id);
      broadcastQueue();

      if (entry && entry.tabId > 0 && entry.type === "main_frame") {
        const now = Date.now();
        state.passthrough.set(entry.tabId, { url: "about:blank", time: now, mainFrameDone: true, mainFrameTime: now });
        try { await browser.tabs.update(entry.tabId, { url: "about:blank" }); } catch (e) { console.debug("[MI] tabs.update failed:", e); }
      }

      appendAuditLog("DROP", { requestId: id, method: entry?.method, url: entry?.url });
      return { ok: true };
    }

    case "FORWARD_REQUEST": {
      const id = msg.id;
      const edited = msg.edited;
      const entry = state.pending.get(id);
      const resp = await replayRequest(edited);

      state.pending.delete(id);
      state.queue = state.queue.filter((x) => x !== id);
      broadcastQueue();

      if (entry && entry.tabId > 0 && entry.type === "main_frame") {
        state.passthrough.set(entry.tabId, { url: edited.url, time: Date.now(), mainFrameDone: false, mainFrameTime: 0 });
        try { await browser.tabs.update(entry.tabId, { url: edited.url }); } catch (e) { console.debug("[MI] tabs.update failed:", e); }
      }

      appendAuditLog("FORWARD", { requestId: id, method: edited.method, url: edited.url });
      return { ok: true, response: resp };
    }

    case "SAVE_REPEATER_ITEM": {
      const item = msg.item;
      const key = "repeaterItems";
      const cur = await browser.storage.local.get(key);
      let arr = Array.isArray(cur[key]) ? cur[key] : [];
      arr.push({ ...item, savedAt: nowIso(), id: genId() });
      arr = MILib.trimArray(arr, RETENTION.repeater);
      await browser.storage.local.set({ [key]: arr });
      return { ok: true, count: arr.length };
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
      const key = "repeaterItems";
      const cur = await browser.storage.local.get(key);
      const arr = Array.isArray(cur[key]) ? cur[key] : [];
      const next = arr.filter((x) => x.id !== msg.id);
      await browser.storage.local.set({ [key]: next });
      return { ok: true, count: next.length };
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
        if (entry && entry.tabId > 0 && entry.type === "main_frame") {
          const now = Date.now();
          state.passthrough.set(entry.tabId, { url: "about:blank", time: now, mainFrameDone: true, mainFrameTime: now });
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
      const count = state.queue.length;
      const results = [];
      for (const id of state.queue) {
        const entry = state.pending.get(id);
        if (!entry) continue;
        const edited = {
          method: entry.method || "GET",
          url: entry.url,
          headers: entry.headers || {},
          body: entry.requestBody
        };
        const resp = await replayRequest(edited);
        results.push({ id, resp });

        if (entry.tabId > 0 && entry.type === "main_frame") {
          state.passthrough.set(entry.tabId, { url: entry.url, time: Date.now(), mainFrameDone: false, mainFrameTime: 0 });
          try { await browser.tabs.update(entry.tabId, { url: entry.url }); } catch (e) { console.debug("[MI] tabs.update failed:", e); }
        }
        state.pending.delete(id);

        // Rate-limit delay between forwards
        await new Promise(r => setTimeout(r, 100));
      }
      state.queue = [];
      broadcastQueue();
      appendAuditLog("FORWARD_ALL", { count: results.length });
      return { ok: true, forwarded: results.length };
    }

    case "SAVE_NOTE": {
      const noteKey = "interceptorNotes";
      const cur = await browser.storage.local.get(noteKey);
      let arr = Array.isArray(cur[noteKey]) ? cur[noteKey] : [];
      arr.push({
        id: genId(),
        timestamp: nowIso(),
        request: msg.request || null,
        response: msg.response || null
      });
      arr = MILib.trimArray(arr, RETENTION.notes);
      await browser.storage.local.set({ [noteKey]: arr });
      return { ok: true, count: arr.length };
    }

    case "LIST_NOTES": {
      const noteKey = "interceptorNotes";
      const cur = await browser.storage.local.get(noteKey);
      return { ok: true, notes: Array.isArray(cur[noteKey]) ? cur[noteKey] : [] };
    }

    case "DELETE_NOTE": {
      const noteKey = "interceptorNotes";
      const cur = await browser.storage.local.get(noteKey);
      const arr = Array.isArray(cur[noteKey]) ? cur[noteKey] : [];
      const next = arr.filter((x) => x.id !== msg.id);
      await browser.storage.local.set({ [noteKey]: next });
      return { ok: true, count: next.length };
    }

    case "CLEAR_NOTES": {
      await browser.storage.local.set({ interceptorNotes: [] });
      return { ok: true };
    }

    case "LIST_AUDIT_LOG": {
      const cur = await browser.storage.local.get(AUDIT_KEY);
      return { ok: true, log: Array.isArray(cur[AUDIT_KEY]) ? cur[AUDIT_KEY] : [] };
    }

    case "CLEAR_AUDIT_LOG": {
      await browser.storage.local.set({ [AUDIT_KEY]: [] });
      return { ok: true };
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
