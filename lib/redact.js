"use strict";

(function (exports) {

  // Header names whose values must be masked in display/export contexts
  const SENSITIVE_HEADERS = [
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

  function isSensitiveHeader(name) {
    return SENSITIVE_HEADERS.includes(String(name).toLowerCase());
  }

  /**
   * Return a shallow copy of headers with sensitive values replaced by [REDACTED].
   */
  function redactHeaders(headers) {
    if (!headers || typeof headers !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = isSensitiveHeader(k) ? "[REDACTED]" : v;
    }
    return out;
  }

  /**
   * Mask known token/password patterns inside a body string.
   * Only applies to JSON and form-urlencoded content types.
   */
  function redactBody(bodyText, contentType) {
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
   * Trim array to maxLen, keeping the newest (last) entries.
   */
  function trimArray(arr, maxLen) {
    if (!Array.isArray(arr)) return [];
    if (arr.length <= maxLen) return arr;
    return arr.slice(arr.length - maxLen);
  }

  /**
   * Create a simple rate limiter.
   * canProceed() returns false if called too soon or too often.
   * record() marks a successful call.
   */
  function createRateLimiter(minIntervalMs, maxPerMinute) {
    let lastTimestamp = 0;
    let minuteWindow = [];
    return {
      canProceed() {
        const now = Date.now();
        if (now - lastTimestamp < minIntervalMs) return false;
        minuteWindow = minuteWindow.filter(function (t) { return now - t < 60000; });
        if (minuteWindow.length >= maxPerMinute) return false;
        return true;
      },
      record() {
        const now = Date.now();
        lastTimestamp = now;
        minuteWindow.push(now);
      }
    };
  }

  exports.SENSITIVE_HEADERS = SENSITIVE_HEADERS;
  exports.isSensitiveHeader = isSensitiveHeader;
  exports.redactHeaders = redactHeaders;
  exports.redactBody = redactBody;
  exports.trimArray = trimArray;
  exports.createRateLimiter = createRateLimiter;

})(typeof module !== "undefined" && module.exports ? module.exports : (globalThis.MILib = globalThis.MILib || {}));
