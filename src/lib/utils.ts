import { Policy, RequestBody } from "./types";

export function normalizeHeaders(headersArr?: browser.webRequest.HttpHeader[] | null): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of headersArr || []) {
    const name = (h.name || "").toLowerCase();
    if (!name) continue;
    headers[name] = h.value != null ? String(h.value) : "";
  }
  return headers;
}

export function hostMatchesWildcard(host: string | null | undefined, rule: string | null | undefined): boolean {
  const r = String(rule || "").toLowerCase().trim();
  const h = String(host || "").toLowerCase().trim();
  if (!r || !h) return false;
  if (r.startsWith("*.")) {
    const base = r.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === r;
}

export function isStaticAssetUrl(url: string): boolean {
  return /\.(?:css|js|mjs|map|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp4|mp3|wav|avi|mov|pdf)(?:\?|#|$)/i.test(
    url,
  );
}

/**
 * Determine whether a request should be intercepted, given current policy.
 * Pure function: takes details + policy as parameters (no global state).
 */
export function shouldInterceptWith(
  details: { method: string; type: string; url: string },
  policy: Policy,
): boolean {
  if (policy.bypassOptions && details.method === "OPTIONS") return false;
  if (policy.bypassTypes && policy.bypassTypes.includes(details.type)) return false;
  if (policy.bypassStaticAssets && isStaticAssetUrl(details.url)) return false;

  if (policy.scopeMode === "OFF") return true;

  try {
    const u = new URL(details.url);
    const hostOk =
      policy.allowDomains &&
      policy.allowDomains.length > 0 &&
      policy.allowDomains.some((r) => hostMatchesWildcard(u.hostname, r));

    const containsOk =
      !policy.allowUrlContains ||
      policy.allowUrlContains.length === 0 ||
      policy.allowUrlContains.some((s) => String(s) && details.url.includes(s));

    return hostOk && containsOk;
  } catch {
    return false;
  }
}

export function parseHeadersJson(text: string | null | undefined): Record<string, string> {
  if (!text || !text.trim()) return {};
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, string>;
  } catch {
    // fall through to error
  }
  throw new Error('Invalid headers: please enter a JSON object, e.g. {"x-test":"1"}');
}

export function bodyToEditor(body: RequestBody | null | undefined): string {
  if (!body) return "";
  if (body.kind === "formData") {
    try {
      return JSON.stringify(body, null, 2);
    } catch {
      return String(body);
    }
  }
  if (body.kind === "raw_base64" || body.kind === "raw_base64_truncated") {
    return body.bytesBase64;
  }
  if (body.kind === "text") return body.text || "";
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

export function escapeHtml(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlightJson(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";
  try {
    const parsed = JSON.parse(text);
    const pretty = JSON.stringify(parsed, null, 2);
    return escapeHtml(pretty)
      .replace(/("(?:[^"\\]|\\.)*")\s*:/g, '<span class="json-key">$1</span>:')
      .replace(/:\s*("(?:[^"\\]|\\.)*")/g, ': <span class="json-str">$1</span>')
      .replace(/:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, ': <span class="json-num">$1</span>')
      .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
      .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');
  } catch {
    return escapeHtml(text);
  }
}
