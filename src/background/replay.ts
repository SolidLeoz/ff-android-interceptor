import type { HttpResponse, ReplayRequest } from "../lib/types";
import { createRateLimiter } from "../lib/redact";
import { base64ToBuf, bufToBase64, denormalizeHeaders } from "./helpers";
import { state } from "./state";

const replayLimiter = createRateLimiter(200, 60);

export async function replayRequest(req: ReplayRequest): Promise<HttpResponse> {
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

  let body: BodyInit | undefined = undefined;
  if (req.body && method !== "GET" && method !== "HEAD") {
    const b = req.body;

    if (b.kind === "raw_base64" || b.kind === "raw_base64_truncated") {
      body = base64ToBuf(b.bytesBase64);
    } else if (b.kind === "text") {
      body = b.text;
    } else if (b.kind === "formData") {
      const usp = new URLSearchParams();
      for (const [k, vals] of Object.entries(b.formData || {})) {
        for (const v of vals || []) usp.append(k, v);
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
      signal: controller.signal,
    });

    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });

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
        truncated,
      },
      durationMs: Date.now() - startedAt,
    };
  } catch (e) {
    return { ok: false, error: String(e), durationMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}
