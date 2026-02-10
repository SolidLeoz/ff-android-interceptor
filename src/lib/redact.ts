// Header names whose values must be masked in display/export contexts
export const SENSITIVE_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-token",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
];

// Body patterns: JSON keys whose string values should be masked
const BODY_REDACT_PATTERNS = [
  /("(?:token|access_token|refresh_token|id_token|password|secret|api_key|apikey|auth|session_id|sessionid|csrf|xsrf)")\s*:\s*"[^"]*"/gi,
];

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.includes(String(name).toLowerCase());
}

/**
 * Return a shallow copy of headers with sensitive values replaced by [REDACTED].
 */
export function redactHeaders(headers?: Record<string, string> | null): Record<string, string> {
  if (!headers || typeof headers !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = isSensitiveHeader(k) ? "[REDACTED]" : String(v);
  }
  return out;
}

/**
 * Mask known token/password patterns inside a body string.
 * Only applies to JSON and form-urlencoded content types.
 */
export function redactBody(bodyText: string | null | undefined, contentType?: string): string {
  if (!bodyText || typeof bodyText !== "string") return bodyText || "";
  const ct = String(contentType || "").toLowerCase();
  if (!/json|urlencoded/.test(ct)) return bodyText;
  let result = bodyText;
  for (const pat of BODY_REDACT_PATTERNS) {
    result = result.replace(pat, '$1:"[REDACTED]"');
  }
  return result;
}

/**
 * Strip query string from a URL for audit log privacy.
 * Returns the URL with query replaced by ?[REDACTED] if present.
 */
export function redactUrl(url: string | null | undefined): string {
  if (!url || typeof url !== "string") return "";
  try {
    const u = new URL(url);
    if (u.search) {
      return `${u.origin}${u.pathname}?[REDACTED]`;
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    // Fallback regex for malformed URLs
    return url.replace(/\?.*$/, "?[REDACTED]");
  }
}

/**
 * Trim array to maxLen, keeping the newest (last) entries.
 */
export function trimArray<T>(arr: T[] | null | undefined, maxLen: number): T[] {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= maxLen) return arr;
  return arr.slice(arr.length - maxLen);
}

export interface RateLimiter {
  canProceed: () => boolean;
  record: () => void;
}

/**
 * Create a simple rate limiter.
 * canProceed() returns false if called too soon or too often.
 * record() marks a successful call.
 */
export function createRateLimiter(minIntervalMs: number, maxPerMinute: number): RateLimiter {
  let lastTimestamp = 0;
  let minuteWindow: number[] = [];
  return {
    canProceed() {
      const now = Date.now();
      if (now - lastTimestamp < minIntervalMs) return false;
      minuteWindow = minuteWindow.filter((t) => now - t < 60000);
      if (minuteWindow.length >= maxPerMinute) return false;
      return true;
    },
    record() {
      const now = Date.now();
      lastTimestamp = now;
      minuteWindow.push(now);
    },
  };
}
