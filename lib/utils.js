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
    throw new Error('Headers non validi: inserisci un JSON object, es: {"x-test":"1"}');
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

  exports.normalizeHeaders = normalizeHeaders;
  exports.hostMatchesWildcard = hostMatchesWildcard;
  exports.isStaticAssetUrl = isStaticAssetUrl;
  exports.shouldInterceptWith = shouldInterceptWith;
  exports.parseHeadersJson = parseHeadersJson;
  exports.bodyToEditor = bodyToEditor;

})(typeof module !== "undefined" && module.exports ? module.exports : (globalThis.MIUtils = globalThis.MIUtils || {}));
