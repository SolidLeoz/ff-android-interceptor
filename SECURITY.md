# Security Threat Model — Mobile Interceptor (PT)

This document identifies the primary threats associated with running a request interceptor as a browser extension and describes the mitigations implemented in this project.

## Threat 1: Accidental interception of unintended traffic

**Risk**: The user forgets interception is active, causing requests to be cancelled or queued silently, breaking normal browsing.

**Mitigations**:
- Default mode is **OFF** — interception must be explicitly enabled
- **OBSERVE** mode allows monitoring without cancelling requests
- **ARMED indicator**: topbar turns red with a pulsing "ARMED" badge when INTERCEPT is active
- **PANIC button**: one-tap to disable interception immediately
- **Scope allowlist** (default-deny): only explicitly listed domains are intercepted

## Threat 2: Exposure of sensitive data in storage/export

**Risk**: Credentials, tokens, and session IDs captured in headers or bodies could be leaked via Notes export, screen sharing, or device theft.

**Mitigations**:
- **Automatic header redaction**: `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, and other sensitive headers are replaced with `[REDACTED]` in display and export
- **Automatic body redaction**: JSON keys like `token`, `password`, `api_key`, `session_id` are masked in display/export
- Redaction applies to: Response viewer, Notes display, Notes export
- "Show sensitive" toggle (default OFF) lets the tester reveal values when needed
- Editor textarea is intentionally unredacted (required for pen testing workflow)

## Threat 3: Replay abuse (accidental or malicious)

**Risk**: Rapid-fire replaying of requests could trigger rate limits, account lockouts, or unintended state changes on the target server.

**Mitigations**:
- **Rate limiter**: minimum 200ms between replays, maximum 60 replays per minute
- **Forward All**: includes 100ms delay between iterations
- Rate-limited requests return an error message instead of silently failing

## Threat 4: Unbounded storage growth

**Risk**: Extended testing sessions could fill device storage with captured requests, notes, and audit entries.

**Mitigations**:
- **Hard retention limits**: 200 notes, 50 repeater items, 500 audit entries
- **FIFO trimming**: oldest entries are removed when limits are reached (`trimArray`)
- **OBSERVE queue**: capped at 100 entries
- **Body capture**: capped at 256KB per request, 512KB per response

## Threat 5: Data exfiltration

**Risk**: A compromised or malicious version of the extension could send captured data to a remote server.

**Mitigations**:
- **No network calls** except user-initiated `fetch()` replays to the target
- **No telemetry, analytics, or beacons** of any kind
- All storage is local (`browser.storage.local`)
- Source code is readable JavaScript (no minification, no bundling)
- Open-source: full audit trail on GitHub

## Threat 6: Unauthorized use

**Risk**: The extension could be used for unauthorized interception of traffic the user does not own.

**Mitigations**:
- Legal disclaimer in README and dashboard
- Extension name and description clearly state "authorized penetration testing"
- Allowlist-based scope requires explicit domain entry
- Audit log records all interception actions with timestamps

## Permissions justification

| Permission | Required for | Alternative considered |
|---|---|---|
| `webRequest` | Observing HTTP requests | None — core functionality |
| `webRequestBlocking` | Cancelling requests in INTERCEPT mode | Non-blocking would prevent interception |
| `<all_urls>` | Intercepting any target domain | Per-domain permissions would require manifest changes per target |
| `storage` | Persisting notes, repeater, audit, policy | None — required for data persistence |
| `tabs` | Navigating tab after forward | None — required for main_frame replay |
