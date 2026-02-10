import type { HttpResponse, RequestEntry } from "../lib/types";
import { normalizeHeaders, shouldInterceptWith } from "../lib/utils";
import { appendAuditLog } from "./audit";
import { broadcastQueue, broadcastRequestIntercepted, broadcastRequestUpdated, broadcastResponseCaptured } from "./ports";
import { policy } from "./policy";
import { state, OBSERVE_QUEUE_MAX } from "./state";
import { bufToBase64, headersObjToArray, mergeChunks, nowIso, safeClone } from "./helpers";

function setPassthrough(tabId: number, entry: { url: string; time: number; mainFrameDone?: boolean; mainFrameTime?: number }): void {
  state.passthrough.set(tabId, entry);
  const existing = state.passthroughTimers.get(tabId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    state.passthrough.delete(tabId);
    state.passthroughTimers.delete(tabId);
  }, 35000);
  state.passthroughTimers.set(tabId, timer);
}

interface CaptureResult {
  body: RequestEntry["requestBody"];
  hint: string | null;
  rawCopy: Uint8Array | null;
  rawOrigLen: number;
}

/**
 * Capture request body from webRequest details.
 */
function captureRequestBody(details: any, maxBytes: number, deferRaw: boolean): CaptureResult {
  const result: CaptureResult = { body: null, hint: null, rawCopy: null, rawOrigLen: 0 };
  if (!details.requestBody) return result;
  try {
    if (details.requestBody.raw && details.requestBody.raw.length > 0) {
      const first = details.requestBody.raw[0]?.bytes;
      if (first) {
        const bytesLen = first.byteLength || 0;
        if (deferRaw) {
          result.rawOrigLen = bytesLen;
          result.rawCopy = new Uint8Array(first).slice(0, Math.min(bytesLen, maxBytes));
        } else if (bytesLen > maxBytes) {
          result.body = {
            kind: "raw_base64_truncated",
            bytesBase64: bufToBase64(first.slice(0, maxBytes)),
            originalBytes: bytesLen,
            capturedBytes: maxBytes,
          };
          result.hint = `RAW body > cap (${bytesLen} bytes). Truncated to ${maxBytes}.`;
        } else {
          result.body = {
            kind: "raw_base64",
            bytesBase64: bufToBase64(first),
            originalBytes: bytesLen,
            capturedBytes: bytesLen,
          };
          result.hint = `RAW body captured (${bytesLen} bytes).`;
        }
      }
    } else if (details.requestBody.formData) {
      result.body = { kind: "formData", formData: safeClone(details.requestBody.formData) } as RequestEntry["requestBody"];
      result.hint = "formData captured (key/value). Multipart file parts are NOT available here.";
    }
  } catch (e) {
    result.hint = `Body capture error: ${String(e)}`;
  }
  return result;
}

export async function waitForCapturedResponse(entry: RequestEntry, timeoutMs: number): Promise<HttpResponse> {
  const start = Date.now();
  while (!entry.capturedResponse && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!entry.capturedResponse) {
    return { ok: true, status: 0, note: "Response timed out or not captured", durationMs: 0 };
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
      truncated,
    },
    durationMs: Date.now() - new Date(entry.time).getTime(),
  };
}

export function initWebRequestListeners(): void {
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!details.url.startsWith("http")) return {};
      if (details.originUrl && details.originUrl.startsWith("moz-extension://")) return {};

      const pt = state.passthrough.get(details.tabId);
      if (pt) {
        const elapsed = Date.now() - pt.time;
        if (elapsed > 30000) {
          state.passthrough.delete(details.tabId);
        } else if (details.type === "main_frame") {
          if (!pt.mainFrameDone && details.url === pt.url) {
            pt.mainFrameDone = true;
            pt.mainFrameTime = Date.now();
            return {};
          }
          state.passthrough.delete(details.tabId);
        } else {
          if (pt.mainFrameDone && pt.mainFrameTime && Date.now() - pt.mainFrameTime < 10000) {
            return {};
          }
          state.passthrough.delete(details.tabId);
        }
      }

      if (state.interceptMode === "OFF") return {};
      if (!shouldInterceptWith(details, policy)) return {};

      const isObserve = state.interceptMode === "OBSERVE";

      const entry: RequestEntry = {
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
        note: isObserve ? "Observed (read-only)" : "Intercepted; awaiting user action",
      };

      if (!isObserve) {
        const cap = captureRequestBody(details, state.maxBodyCaptureBytes, false);
        if (cap.body) entry.requestBody = cap.body;
        if (cap.hint) entry.bodyHint = cap.hint;

        try {
          const filter = browser.webRequest.filterResponseData(details.requestId);
          const responseChunks: Uint8Array[] = [];
          filter.ondata = (event) => {
            responseChunks.push(new Uint8Array(event.data));
            filter.write(event.data);
          };
          filter.onstop = () => {
            filter.close();
            const merged = mergeChunks(responseChunks);
            entry.capturedResponse = merged;
            broadcastResponseCaptured(entry.id);
          };
          filter.onerror = () => {
            try {
              filter.close();
            } catch {
              // ignore
            }
          };
        } catch (e) {
          console.warn("[MI] filterResponseData not available:", e);
        }

        state.pending.set(details.requestId, entry);
        state.queue.push(details.requestId);

        if (state.queue.length > OBSERVE_QUEUE_MAX) {
          const oldId = state.queue.shift();
          if (oldId) {
            const oldEntry = state.pending.get(oldId);
            if (oldEntry && oldEntry.holdResolve) {
              if (oldEntry.holdTimer) clearTimeout(oldEntry.holdTimer);
              oldEntry.holdResolve({});
              oldEntry.holdResolve = undefined;
            }
            state.pending.delete(oldId);
          }
        }

        return new Promise<browser.webRequest.BlockingResponse>((resolve) => {
          entry.holdResolve = resolve;
          entry.holdTimer = setTimeout(() => {
            if (entry.holdResolve) {
              entry.holdResolve({});
              entry.holdResolve = undefined;
            }
          }, 60000);

          setTimeout(() => {
            console.log("[MI] HELD in onBeforeRequest", details.requestId, details.url);
            broadcastQueue();
            broadcastRequestIntercepted(entry);
          }, 0);
        });
      }

      const cap = captureRequestBody(details, state.maxBodyCaptureBytes, false);
      if (cap.body) entry.requestBody = cap.body;
      if (cap.hint) entry.bodyHint = cap.hint;

      state.pending.set(details.requestId, entry);
      state.queue.push(details.requestId);

      if (state.queue.length > OBSERVE_QUEUE_MAX) {
        const oldId = state.queue.shift();
        if (oldId) state.pending.delete(oldId);
      }

      console.log("[MI] captured", details.requestId, details.method, details.url, "mode:", state.interceptMode, "OBSERVE");

      broadcastQueue();
      broadcastRequestIntercepted(entry);

      return {};
    },
    { urls: ["<all_urls>"] },
    ["blocking", "requestBody"],
  );

  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        const entry = state.pending.get(details.requestId);
        if (!entry) return {};
        entry.headers = normalizeHeaders(details.requestHeaders);
        broadcastRequestUpdated(entry.id, { headers: entry.headers });
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
    ["blocking", "requestHeaders"],
  );

  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      const entry = state.pending.get(details.requestId);
      if (!entry) return;
      entry.capturedStatus = details.statusCode;
      entry.capturedStatusText = details.statusLine;
      entry.capturedResponseHeaders = normalizeHeaders(details.responseHeaders);
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"],
  );

  browser.tabs.onRemoved.addListener((tabId) => {
    for (const [id, entry] of state.pending.entries()) {
      if (entry.tabId === tabId && entry.holdResolve) {
        if (entry.holdTimer) clearTimeout(entry.holdTimer);
        entry.holdResolve({});
        entry.holdResolve = undefined;
        state.pending.delete(id);
        state.queue = state.queue.filter((x) => x !== id);
      }
    }
    broadcastQueue();
  });
}

export async function dropRequest(id: string): Promise<void> {
  const entry = state.pending.get(id);

  if (entry && entry.holdResolve) {
    if (entry.holdTimer) clearTimeout(entry.holdTimer);
    entry.holdResolve({ cancel: true });
    entry.holdResolve = undefined;
  }

  state.pending.delete(id);
  state.queue = state.queue.filter((x) => x !== id);
  broadcastQueue();

  if (entry && entry.tabId > 0 && entry.type === "main_frame") {
    const now = Date.now();
    setPassthrough(entry.tabId, { url: "about:blank", time: now, mainFrameDone: true, mainFrameTime: now });
    try {
      await browser.tabs.update(entry.tabId, { url: "about:blank" });
    } catch (e) {
      console.debug("[MI] tabs.update failed:", e);
    }
  }

  await appendAuditLog("DROP", { requestId: id, method: entry?.method, url: entry?.url });
}

export async function forwardRequest(
  id: string,
  edited: { url?: string; headers?: Record<string, string> },
): Promise<{ ok: true; response: HttpResponse } | { ok: false; error: string }> {
  const entry = state.pending.get(id);
  if (!entry || !entry.holdResolve) {
    return { ok: false, error: "Request not held" };
  }

  if (edited.headers) entry.editedHeaders = edited.headers;

  if (entry.holdTimer) clearTimeout(entry.holdTimer);

  if (edited.url && edited.url !== entry.url) {
    entry.holdResolve({ redirectUrl: edited.url });
  } else {
    entry.holdResolve({});
  }
  entry.holdResolve = undefined;

  if (entry.tabId > 0 && entry.type === "main_frame") {
    setPassthrough(entry.tabId, {
      url: edited.url || entry.url,
      time: Date.now(),
      mainFrameDone: true,
      mainFrameTime: Date.now(),
    });
  }

  state.queue = state.queue.filter((x) => x !== id);
  broadcastQueue();

  const resp = await waitForCapturedResponse(entry, 30000);
  state.pending.delete(id);

  await appendAuditLog("FORWARD", { requestId: id, method: entry.method, url: edited.url || entry.url });
  return { ok: true, response: resp };
}

export async function dropAll(): Promise<number> {
  const count = state.queue.length;
  for (const id of state.queue) {
    const entry = state.pending.get(id);
    if (!entry) continue;
    if (entry.holdResolve) {
      if (entry.holdTimer) clearTimeout(entry.holdTimer);
      entry.holdResolve({ cancel: true });
      entry.holdResolve = undefined;
    }
    if (entry.tabId > 0 && entry.type === "main_frame") {
      const now = Date.now();
      setPassthrough(entry.tabId, { url: "about:blank", time: now, mainFrameDone: true, mainFrameTime: now });
      try {
        await browser.tabs.update(entry.tabId, { url: "about:blank" });
      } catch (e) {
        console.debug("[MI] tabs.update failed:", e);
      }
    }
  }
  state.pending.clear();
  state.queue = [];
  broadcastQueue();
  await appendAuditLog("DROP_ALL", { count });
  return count;
}

export async function forwardAll(): Promise<{ forwarded: number; failed: number }> {
  let succeeded = 0;
  const ids = [...state.queue];
  const forwardedIds: string[] = [];
  for (const id of ids) {
    const entry = state.pending.get(id);
    if (!entry) continue;

    if (entry.holdResolve) {
      if (entry.holdTimer) clearTimeout(entry.holdTimer);
      entry.holdResolve({});
      entry.holdResolve = undefined;
    }

    if (entry.tabId > 0 && entry.type === "main_frame") {
      setPassthrough(entry.tabId, {
        url: entry.url,
        time: Date.now(),
        mainFrameDone: true,
        mainFrameTime: Date.now(),
      });
    }

    forwardedIds.push(id);
    succeeded++;
  }

  state.queue = [];
  broadcastQueue();
  setTimeout(() => {
    for (const id of forwardedIds) state.pending.delete(id);
  }, 35000);
  await appendAuditLog("FORWARD_ALL", { count: succeeded });
  return { forwarded: succeeded, failed: 0 };
}
