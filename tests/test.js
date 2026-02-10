"use strict";

const assert = require("assert");
const MILib = require("../dist/lib/redact.cjs");
const MIUtils = require("../dist/lib/utils.cjs");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \u2717 ${name}`);
    console.log(`    ${e.message}`);
  }
}

// ─── Redaction: redactHeaders ───────────────────────────────────────

console.log("\nredactHeaders");

test("masks authorization, cookie, set-cookie, x-api-key", () => {
  const h = {
    Authorization: "Bearer secret",
    Cookie: "sid=abc",
    "Set-Cookie": "sid=abc; Path=/",
    "X-Api-Key": "key123",
    "Content-Type": "application/json",
  };
  const r = MILib.redactHeaders(h);
  assert.strictEqual(r.Authorization, "[REDACTED]");
  assert.strictEqual(r.Cookie, "[REDACTED]");
  assert.strictEqual(r["Set-Cookie"], "[REDACTED]");
  assert.strictEqual(r["X-Api-Key"], "[REDACTED]");
  assert.strictEqual(r["Content-Type"], "application/json");
});

test("preserves non-sensitive headers unchanged", () => {
  const h = { Accept: "text/html", "Cache-Control": "no-cache" };
  const r = MILib.redactHeaders(h);
  assert.strictEqual(r.Accept, "text/html");
  assert.strictEqual(r["Cache-Control"], "no-cache");
});

test("handles null, undefined, empty object", () => {
  assert.deepStrictEqual(MILib.redactHeaders(null), {});
  assert.deepStrictEqual(MILib.redactHeaders(undefined), {});
  assert.deepStrictEqual(MILib.redactHeaders({}), {});
});

test("masks proxy-authorization, x-token, x-auth-token, x-csrf-token, x-xsrf-token", () => {
  const h = {
    "Proxy-Authorization": "Basic abc",
    "X-Token": "tok",
    "X-Auth-Token": "atok",
    "X-Csrf-Token": "csrf",
    "X-Xsrf-Token": "xsrf",
  };
  const r = MILib.redactHeaders(h);
  for (const k of Object.keys(h)) {
    assert.strictEqual(r[k], "[REDACTED]", `expected ${k} to be redacted`);
  }
});

// ─── Redaction: redactBody ──────────────────────────────────────────

console.log("\nredactBody");

test("masks token, password, api_key in JSON body", () => {
  const body = '{"token":"secret","password":"pw","api_key":"k"}';
  const r = MILib.redactBody(body, "application/json");
  assert.ok(!r.includes("secret"), "token not redacted");
  assert.ok(!r.includes('"pw"'), "password not redacted");
  assert.ok(r.includes("[REDACTED]"));
});

test("does NOT redact if content-type is not JSON/urlencoded", () => {
  const body = '{"token":"secret"}';
  const r = MILib.redactBody(body, "text/plain");
  assert.strictEqual(r, body);
});

test("handles empty/null input", () => {
  assert.strictEqual(MILib.redactBody("", "application/json"), "");
  assert.strictEqual(MILib.redactBody(null, "application/json"), "");
  assert.strictEqual(MILib.redactBody(undefined, "application/json"), "");
});

test("masks access_token, refresh_token, session_id, csrf in JSON", () => {
  const body = '{"access_token":"a","refresh_token":"r","session_id":"s","csrf":"c"}';
  const r = MILib.redactBody(body, "application/json");
  assert.ok(!r.includes('"a"'), "access_token not redacted");
  assert.ok(!r.includes('"r"'), "refresh_token not redacted");
  assert.ok(!r.includes('"s"'), "session_id not redacted");
  assert.ok(!r.includes('"c"'), "csrf not redacted");
});

test("works with urlencoded content-type", () => {
  const body = '{"token":"secret"}';
  const r = MILib.redactBody(body, "application/x-www-form-urlencoded");
  assert.ok(r.includes("[REDACTED]"));
});

// ─── Utils: normalizeHeaders ────────────────────────────────────────

console.log("\nnormalizeHeaders");

test("lowercases header names from array format", () => {
  const arr = [
    { name: "Content-Type", value: "text/html" },
    { name: "X-Custom", value: "val" },
  ];
  const r = MIUtils.normalizeHeaders(arr);
  assert.strictEqual(r["content-type"], "text/html");
  assert.strictEqual(r["x-custom"], "val");
});

test("handles null/empty input", () => {
  assert.deepStrictEqual(MIUtils.normalizeHeaders(null), {});
  assert.deepStrictEqual(MIUtils.normalizeHeaders([]), {});
});

// ─── Utils: hostMatchesWildcard ─────────────────────────────────────

console.log("\nhostMatchesWildcard");

test("exact match", () => {
  assert.ok(MIUtils.hostMatchesWildcard("example.com", "example.com"));
});

test("wildcard *.example.com matches sub.example.com", () => {
  assert.ok(MIUtils.hostMatchesWildcard("sub.example.com", "*.example.com"));
});

test("wildcard *.example.com matches example.com (base)", () => {
  assert.ok(MIUtils.hostMatchesWildcard("example.com", "*.example.com"));
});

test("no match for different domains", () => {
  assert.ok(!MIUtils.hostMatchesWildcard("other.com", "example.com"));
  assert.ok(!MIUtils.hostMatchesWildcard("other.com", "*.example.com"));
});

test("handles empty/null inputs", () => {
  assert.ok(!MIUtils.hostMatchesWildcard("", "example.com"));
  assert.ok(!MIUtils.hostMatchesWildcard("example.com", ""));
  assert.ok(!MIUtils.hostMatchesWildcard(null, null));
});

// ─── Utils: isStaticAssetUrl ────────────────────────────────────────

console.log("\nisStaticAssetUrl");

test("detects .css, .png, .js, .woff2", () => {
  assert.ok(MIUtils.isStaticAssetUrl("https://cdn.example.com/style.css"));
  assert.ok(MIUtils.isStaticAssetUrl("https://cdn.example.com/img.png"));
  assert.ok(MIUtils.isStaticAssetUrl("https://cdn.example.com/app.js"));
  assert.ok(MIUtils.isStaticAssetUrl("https://cdn.example.com/font.woff2"));
});

test("does not flag API endpoints", () => {
  assert.ok(!MIUtils.isStaticAssetUrl("https://api.example.com/v1/data"));
  assert.ok(!MIUtils.isStaticAssetUrl("https://api.example.com/graphql"));
});

// ─── Utils: shouldInterceptWith ─────────────────────────────────────

console.log("\nshouldInterceptWith");

test("empty allowDomains → does not intercept (ALLOWLIST mode)", () => {
  const policy = { scopeMode: "ALLOWLIST", allowDomains: [], bypassStaticAssets: false };
  const details = { url: "https://example.com/api", method: "GET", type: "xmlhttprequest" };
  assert.ok(!MIUtils.shouldInterceptWith(details, policy));
});

test("bypasses OPTIONS requests when bypassOptions is true", () => {
  const policy = { scopeMode: "OFF", bypassOptions: true };
  const details = { url: "https://example.com/api", method: "OPTIONS", type: "xmlhttprequest" };
  assert.ok(!MIUtils.shouldInterceptWith(details, policy));
});

test("intercepts matching domain in ALLOWLIST", () => {
  const policy = { scopeMode: "ALLOWLIST", allowDomains: ["example.com"], bypassStaticAssets: false };
  const details = { url: "https://example.com/api/data", method: "GET", type: "xmlhttprequest" };
  assert.ok(MIUtils.shouldInterceptWith(details, policy));
});

test("scope OFF intercepts everything", () => {
  const policy = { scopeMode: "OFF", bypassStaticAssets: false };
  const details = { url: "https://anything.com/test", method: "POST", type: "xmlhttprequest" };
  assert.ok(MIUtils.shouldInterceptWith(details, policy));
});

test("bypasses static assets when bypassStaticAssets is true", () => {
  const policy = { scopeMode: "OFF", bypassStaticAssets: true };
  const details = { url: "https://cdn.example.com/style.css", method: "GET", type: "stylesheet" };
  assert.ok(!MIUtils.shouldInterceptWith(details, policy));
});

// ─── Utils: parseHeadersJson ────────────────────────────────────────

console.log("\nparseHeadersJson");

test("parses valid JSON object", () => {
  const r = MIUtils.parseHeadersJson('{"Content-Type":"application/json"}');
  assert.deepStrictEqual(r, { "Content-Type": "application/json" });
});

test("returns empty object for empty input", () => {
  assert.deepStrictEqual(MIUtils.parseHeadersJson(""), {});
  assert.deepStrictEqual(MIUtils.parseHeadersJson(null), {});
});

test("throws on invalid JSON", () => {
  assert.throws(() => MIUtils.parseHeadersJson("{bad}"), /Invalid headers/);
});

test("throws on JSON array (not object)", () => {
  assert.throws(() => MIUtils.parseHeadersJson("[1,2,3]"), /Invalid headers/);
});

test("error message is in English", () => {
  try {
    MIUtils.parseHeadersJson("{bad}");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e.message.includes("Invalid headers"), "error should be in English");
    assert.ok(e.message.includes("JSON object"), "should mention JSON object");
  }
});

// ─── Utils: bodyToEditor ────────────────────────────────────────────

console.log("\nbodyToEditor");

test("formData returns JSON string", () => {
  const body = { kind: "formData", data: { key: ["val"] } };
  const r = MIUtils.bodyToEditor(body);
  assert.ok(r.includes("formData"));
});

test("raw_base64 returns bytesBase64", () => {
  const body = { kind: "raw_base64", bytesBase64: "SGVsbG8=" };
  assert.strictEqual(MIUtils.bodyToEditor(body), "SGVsbG8=");
});

test("text returns text content", () => {
  const body = { kind: "text", text: "hello world" };
  assert.strictEqual(MIUtils.bodyToEditor(body), "hello world");
});

test("null returns empty string", () => {
  assert.strictEqual(MIUtils.bodyToEditor(null), "");
  assert.strictEqual(MIUtils.bodyToEditor(undefined), "");
});

// ─── Retention: trimArray ───────────────────────────────────────────

console.log("\ntrimArray");

test("trims and keeps newest entries", () => {
  const arr = [1, 2, 3, 4, 5];
  const r = MILib.trimArray(arr, 3);
  assert.deepStrictEqual(r, [3, 4, 5]);
});

test("noop if under limit", () => {
  const arr = [1, 2];
  const r = MILib.trimArray(arr, 5);
  assert.deepStrictEqual(r, [1, 2]);
});

test("handles null/non-array", () => {
  assert.deepStrictEqual(MILib.trimArray(null, 5), []);
  assert.deepStrictEqual(MILib.trimArray("not array", 5), []);
});

test("handles exact limit", () => {
  const arr = [1, 2, 3];
  const r = MILib.trimArray(arr, 3);
  assert.deepStrictEqual(r, [1, 2, 3]);
});

// ─── Rate limiter ───────────────────────────────────────────────────

console.log("\ncreateRateLimiter");

test("allows first call", () => {
  const rl = MILib.createRateLimiter(200, 60);
  assert.ok(rl.canProceed());
});

test("blocks call within minInterval", () => {
  const rl = MILib.createRateLimiter(10000, 60);
  rl.record();
  assert.ok(!rl.canProceed());
});

test("allows after minInterval elapses", (done) => {
  const rl = MILib.createRateLimiter(5, 60);
  rl.record();
  // Wait slightly more than minInterval
  const start = Date.now();
  while (Date.now() - start < 10) { /* busy wait */ }
  assert.ok(rl.canProceed());
});

// ─── isSensitiveHeader ──────────────────────────────────────────────

console.log("\nisSensitiveHeader");

test("case-insensitive match", () => {
  assert.ok(MILib.isSensitiveHeader("AUTHORIZATION"));
  assert.ok(MILib.isSensitiveHeader("Cookie"));
  assert.ok(MILib.isSensitiveHeader("x-api-key"));
});

test("returns false for non-sensitive headers", () => {
  assert.ok(!MILib.isSensitiveHeader("Content-Type"));
  assert.ok(!MILib.isSensitiveHeader("Accept"));
});

// ─── Redaction: redactUrl ────────────────────────────────────────────

console.log("\nredactUrl");

test("strips query params", () => {
  const r = MILib.redactUrl("https://example.com/api/data?token=secret&id=5");
  assert.strictEqual(r, "https://example.com/api/data?[REDACTED]");
});

test("preserves URL without query", () => {
  const r = MILib.redactUrl("https://example.com/api/data");
  assert.strictEqual(r, "https://example.com/api/data");
});

test("handles null/empty", () => {
  assert.strictEqual(MILib.redactUrl(null), "");
  assert.strictEqual(MILib.redactUrl(""), "");
  assert.strictEqual(MILib.redactUrl(undefined), "");
});

test("fallback regex on malformed URL", () => {
  const r = MILib.redactUrl("not-a-url?secret=123");
  assert.strictEqual(r, "not-a-url?[REDACTED]");
});

// ─── Utils: escapeHtml ──────────────────────────────────────────────

console.log("\nescapeHtml");

test("escapes &, <, >", () => {
  const r = MIUtils.escapeHtml('<script>alert("xss")&</script>');
  assert.ok(r.includes("&lt;"));
  assert.ok(r.includes("&gt;"));
  assert.ok(r.includes("&amp;"));
  assert.ok(!r.includes("<script>"));
});

// ─── Utils: highlightJson ───────────────────────────────────────────

console.log("\nhighlightJson");

test("highlights key/string/number/boolean/null", () => {
  const json = '{"name":"test","count":42,"active":true,"data":null}';
  const r = MIUtils.highlightJson(json);
  assert.ok(r.includes('class="json-key"'), "should have json-key class");
  assert.ok(r.includes('class="json-str"'), "should have json-str class");
  assert.ok(r.includes('class="json-num"'), "should have json-num class");
  assert.ok(r.includes('class="json-bool"'), "should have json-bool class");
  assert.ok(r.includes('class="json-null"'), "should have json-null class");
});

test("non-JSON returns escaped HTML", () => {
  const r = MIUtils.highlightJson("not json <b>bold</b>");
  assert.ok(r.includes("&lt;b&gt;"));
  assert.ok(!r.includes("<b>"));
});

test("null/empty returns empty string", () => {
  assert.strictEqual(MIUtils.highlightJson(null), "");
  assert.strictEqual(MIUtils.highlightJson(""), "");
});

// ─────────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
