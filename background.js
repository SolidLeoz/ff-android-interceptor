/* background.js
 * Mobile Interceptor (PT) - Firefox Android
 * Pattern: cancel original request -> replay via fetch after user edits.
 *
 * CRITICAL POINTS / ENDPOINTS (runtime messages):
 * - TOGGLE_INTERCEPT (enables/disables interception)
 * - GET_QUEUE (dashboard polling)
 * - DROP_REQUEST / FORWARD_REQUEST (queue actions)
 * - SAVE/LIST/RUN/DELETE_REPEATER_ITEM (repeater storage + replay)
 * - GET_POLICY / SET_POLICY (scope + bypass configuration)
 *
 * CRITICAL HOOKS:
 * - webRequest.onBeforeRequest (cancel original + capture body)
 * - webRequest.onBeforeSendHeaders (capture headers)
 */

"use strict";

const state = {
  interceptEnabled: false,

  // Map requestId -> entry captured from webRequest
  pending: new Map(),

  // Queue of requestIds in arrival order
  queue: [],

  // Dashboard ports
  ports: new Set(),

  // TabIds that bypass interception temporarily (after Forward)
  // Map<tabId, expiryTimestamp>
  passthrough: new Map(),

  // Soft limits
  maxBodyCaptureBytes: 1024 * 256,   // 256KB capture cap for display/edit
  maxResponseBytes: 1024 * 512       // 512KB response cap
};

// --- Interception Policy (CRITICAL) ---
const policy = {
  scopeMode: "ALLOWLIST",              // "OFF" = intercept all, "ALLOWLIST" = intercept only allowDomains
  allowDomains: [],                  // ["example.com", "*.example.com"]
  allowUrlContains: [],              // ["/api/", "/graphql"]
  bypassStaticAssets: true,
  bypassTypes: ["image", "stylesheet", "font", "media"],
  bypassOptions: true
};

const POLICY_KEY = "interceptorPolicy";

(async function loadPolicy() {
  try {
    const cur = await browser.storage.local.get(POLICY_KEY);
    if (cur && cur[POLICY_KEY]) Object.assign(policy, cur[POLICY_KEY]);
  } catch (_) {
    // ignore; defaults are fine
  }
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

function normalizeHeaders(headersArr) {
  const headers = {};
  for (const h of headersArr || []) {
    const name = (h.name || "").toLowerCase();
    if (!name) continue;
    headers[name] = h.value ?? "";
  }
  return headers;
}

function denormalizeHeaders(headersObj) {
  const h = new Headers();
  for (const [k, v] of Object.entries(headersObj || {})) {
    try { h.set(k, String(v)); } catch (_) {}
  }
  return h;
}

function broadcast(type, payload) {
  for (const p of state.ports) {
    try { p.postMessage({ type, payload }); } catch (_) {}
  }
}

// Android-safe: open dashboard in a tab (do not rely on options_ui entry)
async function openDashboardTab() {
  const url = browser.runtime.getURL("ui/dashboard.html");

  try {
    const tabs = await browser.tabs.query({});
    const existing = tabs.find(t => (t.url || "").startsWith(url));
    if (existing && existing.id) {
      await browser.tabs.update(existing.id, { active: true });
      return;
    }
  } catch (_) {}

  await browser.tabs.create({ url });
}

function isStaticAssetUrl(url) {
  return /\.(?:css|js|mjs|map|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp4|mp3|wav|avi|mov|pdf)(?:\?|#|$)/i.test(url);
}

function hostMatchesWildcard(host, rule) {
  rule = String(rule || "").toLowerCase().trim();
  host = String(host || "").toLowerCase().trim();
  if (!rule || !host) return false;
  if (rule.startsWith("*.")) {
    const base = rule.slice(2);
    return host === base || host.endsWith("." + base);
  }
  return host === rule;
}

function shouldIntercept(details) {
  // Bypass first
  if (policy.bypassOptions && details.method === "OPTIONS") return false;
  if (policy.bypassTypes.includes(details.type)) return false;
  if (policy.bypassStaticAssets && isStaticAssetUrl(details.url)) return false;

  // Scope
  if (policy.scopeMode === "OFF") return true;

  // ALLOWLIST: if empty -> intercept nothing (safe default)
  try {
    const u = new URL(details.url);
    const hostOk = policy.allowDomains.length > 0 &&
      policy.allowDomains.some(r => hostMatchesWildcard(u.hostname, r));

    const containsOk = policy.allowUrlContains.length === 0 ||
      policy.allowUrlContains.some(s => String(s) && details.url.includes(s));

    return hostOk && containsOk;
  } catch (_) {
    return false;
  }
}

// --- Capture body: onBeforeRequest (CRITICAL) ---
// Body is captured here; cancellation happens in onBeforeSendHeaders so headers are also captured.
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Only http/https
    if (!details.url.startsWith("http")) return {};

    // Skip extension internal pages
    if (details.originUrl && details.originUrl.startsWith("moz-extension://")) return {};

    // Passthrough: let forwarded-tab requests through for a time window
    const ptExpiry = state.passthrough.get(details.tabId);
    if (ptExpiry) {
      if (Date.now() < ptExpiry) return {};
      state.passthrough.delete(details.tabId);
    }

    if (!state.interceptEnabled) return {};
    if (!shouldIntercept(details)) return {};

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
      headers: null,     // filled by onBeforeSendHeaders before cancel
      capturedFrom: "onBeforeRequest",
      note: "Intercepted; awaiting user action"
    };

    // Capture body if present (requires ["blocking","requestBody"])
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

    // Notify UI
    broadcast("QUEUE_UPDATED", { interceptEnabled: state.interceptEnabled, size: state.queue.length });
    broadcast("REQUEST_INTERCEPTED", { entry });

    // Do NOT cancel here — onBeforeSendHeaders will capture headers then cancel
    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestBody"]
);

// --- Capture headers + cancel: onBeforeSendHeaders (CRITICAL) ---
// This fires AFTER onBeforeRequest, so headers are available. We cancel here.
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const entry = state.pending.get(details.requestId);
    if (!entry) return {};

    // Capture headers
    entry.headers = normalizeHeaders(details.requestHeaders);

    broadcast("REQUEST_UPDATED", { id: entry.id, patch: { headers: entry.headers } });

    // NOW cancel the request (after headers are captured)
    return { cancel: true };
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestHeaders"]
);

// Browser action opens dashboard (Android-friendly)
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
      interceptEnabled: state.interceptEnabled,
      queue: state.queue.map((id) => state.pending.get(id)).filter(Boolean),
      policy
    }
  });
});

// Messages from UI (CRITICAL)
browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg || !msg.type) return { ok: false, error: "Missing msg.type" };

  switch (msg.type) {
    case "OPEN_DASHBOARD": {
      await openDashboardTab();
      return { ok: true };
    }

    case "TOGGLE_INTERCEPT": {
      state.interceptEnabled = !!msg.enabled;
      // console.log("[MI] TOGGLE_INTERCEPT:", state.interceptEnabled);
      broadcast("QUEUE_UPDATED", { interceptEnabled: state.interceptEnabled, size: state.queue.length });
      return { ok: true, interceptEnabled: state.interceptEnabled };
    }

    case "GET_QUEUE": {
      const queueEntries = state.queue.map((id) => state.pending.get(id)).filter(Boolean);
      return { ok: true, interceptEnabled: state.interceptEnabled, queue: queueEntries };
    }

    case "DROP_REQUEST": {
      const id = msg.id;
      const entry = state.pending.get(id);
      state.pending.delete(id);
      state.queue = state.queue.filter((x) => x !== id);
      broadcast("QUEUE_UPDATED", { interceptEnabled: state.interceptEnabled, size: state.queue.length });

      // Navigate tab to about:blank so it doesn't stay frozen
      if (entry && entry.tabId > 0 && entry.type === "main_frame") {
        state.passthrough.set(entry.tabId, Date.now() + 3000);
        try { await browser.tabs.update(entry.tabId, { url: "about:blank" }); } catch (_) {}
      }

      return { ok: true };
    }

    case "FORWARD_REQUEST": {
      const id = msg.id;
      const edited = msg.edited; // {method,url,headers,body}
      const entry = state.pending.get(id);
      const resp = await replayRequest(edited);

      state.pending.delete(id);
      state.queue = state.queue.filter((x) => x !== id);
      broadcast("QUEUE_UPDATED", { interceptEnabled: state.interceptEnabled, size: state.queue.length });

      // Navigate the original tab so it doesn't stay blank (main_frame only)
      // Give 10 seconds for the page + sub-resources to load without interception
      if (entry && entry.tabId > 0 && entry.type === "main_frame") {
        state.passthrough.set(entry.tabId, Date.now() + 10000);
        try { await browser.tabs.update(entry.tabId, { url: edited.url }); } catch (_) {}
      }

      return { ok: true, response: resp };
    }

    case "SAVE_REPEATER_ITEM": {
      const item = msg.item; // {name, request: {...}}
      const key = "repeaterItems";
      const cur = await browser.storage.local.get(key);
      const arr = Array.isArray(cur[key]) ? cur[key] : [];

      const rid = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
      arr.push({ ...item, savedAt: nowIso(), id: rid });

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
      Object.assign(policy, msg.policy || {});
      await savePolicy();
      broadcast("POLICY_UPDATED", { policy });
      return { ok: true, policy };
    }

    case "DROP_ALL": {
      // Navigate main_frame tabs to about:blank with passthrough, then clear queue
      for (const id of state.queue) {
        const entry = state.pending.get(id);
        if (entry && entry.tabId > 0 && entry.type === "main_frame") {
          state.passthrough.set(entry.tabId, Date.now() + 3000);
          try { await browser.tabs.update(entry.tabId, { url: "about:blank" }); } catch (_) {}
        }
      }
      state.pending.clear();
      state.queue = [];
      broadcast("QUEUE_UPDATED", { interceptEnabled: state.interceptEnabled, size: 0 });
      return { ok: true };
    }

    case "FORWARD_ALL": {
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
          state.passthrough.set(entry.tabId, Date.now() + 10000);
          try { await browser.tabs.update(entry.tabId, { url: entry.url }); } catch (_) {}
        }
        state.pending.delete(id);
      }
      state.queue = [];
      broadcast("QUEUE_UPDATED", { interceptEnabled: state.interceptEnabled, size: 0 });
      return { ok: true, forwarded: results.length };
    }

    case "SAVE_NOTE": {
      const noteKey = "interceptorNotes";
      const cur = await browser.storage.local.get(noteKey);
      const arr = Array.isArray(cur[noteKey]) ? cur[noteKey] : [];
      const nid = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random().toString(16).slice(2);
      arr.push({
        id: nid,
        timestamp: nowIso(),
        request: msg.request || null,
        response: msg.response || null
      });
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

    default:
      return { ok: false, error: "Unknown message type" };
  }
});

// --- Replay logic (CRITICAL) ---
async function replayRequest(req) {
  const method = (req.method || "GET").toUpperCase();
  const url = req.url;

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

