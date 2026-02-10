"use strict";

(function (exports) {

  function normalizeHeaders(headersArr) {
    const headers = {};
    for (const h of headersArr || []) {
      const name = (h.name || "").toLowerCase();
      if (!name) continue;
      headers[name] = h.value != null ? h.value : "";
    }
    return headers;
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

  function isStaticAssetUrl(url) {
    return /\.(?:css|js|mjs|map|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp4|mp3|wav|avi|mov|pdf)(?:\?|#|$)/i.test(url);
  }

  /**
   * Determine whether a request should be intercepted, given current policy.
   * Pure function: takes details + policy as parameters (no global state).
   */
  function shouldInterceptWith(details, policy) {
    if (policy.bypassOptions && details.method === "OPTIONS") return false;
    if (policy.bypassTypes && policy.bypassTypes.includes(details.type)) return false;
    if (policy.bypassStaticAssets && isStaticAssetUrl(details.url)) return false;

    if (policy.scopeMode === "OFF") return true;

    try {
      var u = new URL(details.url);
      var hostOk = policy.allowDomains && policy.allowDomains.length > 0 &&
        policy.allowDomains.some(function (r) { return hostMatchesWildcard(u.hostname, r); });

      var containsOk = !policy.allowUrlContains || policy.allowUrlContains.length === 0 ||
        policy.allowUrlContains.some(function (s) { return String(s) && details.url.includes(s); });

      return hostOk && containsOk;
    } catch (_) {
      return false;
    }
  }

  function parseHeadersJson(text) {
    if (!text || !text.trim()) return {};
    try {
      var obj = JSON.parse(text);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch (_) {}
    throw new Error('Invalid headers: please enter a JSON object, e.g. {"x-test":"1"}');
  }

  function bodyToEditor(body) {
    if (!body) return "";
    if (body.kind === "formData") {
      try { return JSON.stringify(body, null, 2); } catch (_) { return String(body); }
    }
    if (body.kind === "raw_base64" || body.kind === "raw_base64_truncated") {
      return body.bytesBase64;
    }
    if (body.kind === "text") return body.text || "";
    try { return JSON.stringify(body, null, 2); } catch (_) { return String(body); }
  }

  function escapeHtml(text) {
    if (!text || typeof text !== "string") return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlightJson(text) {
    if (!text || typeof text !== "string") return "";
    try {
      var parsed = JSON.parse(text);
      var pretty = JSON.stringify(parsed, null, 2);
      return escapeHtml(pretty).replace(
        /("(?:[^"\\]|\\.)*")\s*:/g,
        '<span class="json-key">$1</span>:'
      ).replace(
        /:\s*("(?:[^"\\]|\\.)*")/g,
        ': <span class="json-str">$1</span>'
      ).replace(
        /:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
        ': <span class="json-num">$1</span>'
      ).replace(
        /:\s*(true|false)/g,
        ': <span class="json-bool">$1</span>'
      ).replace(
        /:\s*(null)/g,
        ': <span class="json-null">$1</span>'
      );
    } catch (_) {
      return escapeHtml(text);
    }
  }

  exports.normalizeHeaders = normalizeHeaders;
  exports.hostMatchesWildcard = hostMatchesWildcard;
  exports.isStaticAssetUrl = isStaticAssetUrl;
  exports.shouldInterceptWith = shouldInterceptWith;
  exports.parseHeadersJson = parseHeadersJson;
  exports.bodyToEditor = bodyToEditor;
  exports.escapeHtml = escapeHtml;
  exports.highlightJson = highlightJson;

})(typeof module !== "undefined" && module.exports ? module.exports : (globalThis.MIUtils = globalThis.MIUtils || {}));
