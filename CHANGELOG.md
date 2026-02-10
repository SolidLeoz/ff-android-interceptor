# Changelog

## [0.3.1] - 2026-02-10

### Changed
- **Hold & Release model**: INTERCEPT mode now **holds** requests via a blocking Promise instead of cancelling them. When the user presses Forward, the original request proceeds to the server and the page receives the real response — no more broken tabs
- **Response capture**: Uses `browser.webRequest.filterResponseData()` to intercept the response stream (pass-through to page + buffer for dashboard display)
- **Editable fields in INTERCEPT**: URL and headers are editable; method and body are read-only (use Repeater for full editing)
- **`onBeforeSendHeaders` is now blocking**: Applies user-edited headers before the request reaches the server
- **`onHeadersReceived` listener**: Captures response status code and headers for dashboard display
- **Forward resolves with `{redirectUrl}`** when URL is edited, enabling transparent URL rewriting
- **Drop resolves with `{cancel: true}`**: Properly cancels the held request
- **FORWARD_ALL**: Resolves all held promises without waiting for responses; deferred cleanup preserves entries for webRequest listeners
- **Auto-forward on mode change**: Switching away from INTERCEPT auto-forwards all pending held requests
- **Auto-forward on tab close**: `tabs.onRemoved` releases held requests for closed tabs
- **Safety timeout**: Held requests auto-forward after 60 seconds without user action
- **Dashboard**: Method/body fields shown as read-only with hint; Forward sends only URL + headers

## [0.2.0] - 2025-06-01

### Added
- **OBSERVE mode**: Read-only interception — captures requests to the queue without cancelling them. Three modes: OFF / OBSERVE / INTERCEPT
- **ARMED indicator**: Topbar changes color (red for INTERCEPT, orange for OBSERVE) with a pulsing badge to prevent accidental interception
- **Automatic redaction**: Sensitive headers (Authorization, Cookie, Set-Cookie, X-Api-Key, etc.) are masked as `[REDACTED]` in Response viewer, Notes display, and Notes export. Toggle "Show sensitive" to reveal
- **Body redaction**: JSON keys like `token`, `password`, `api_key`, `session_id` are auto-masked in display/export contexts
- **Audit log**: Tracks all user actions (toggle mode, forward, drop, policy changes) with timestamps. Max 500 entries FIFO
- **Rate limiting**: Replay requests are throttled (200ms min interval, 60/min cap) to prevent accidental abuse
- **Retention policy**: Hard caps on stored data — 200 notes, 50 repeater items, 500 audit entries
- **Shared modules**: Extracted pure functions into `lib/redact.js` and `lib/utils.js` for testability
- **Unit tests**: 40 tests covering redaction, utils, retention, and rate limiting (`npm test`)
- **Privacy policy** (`PRIVACY.md`): Documents data handling for AMO compliance
- **Security threat model** (`SECURITY.md`): Identifies threats and mitigations
- **MIT License** (`LICENSE`)
- **CI/CD**: GitHub Actions workflow for lint + test on push/PR

### Changed
- Removed unused `cookies` permission from manifest
- Bumped version to 0.2.0
- `build.sh` now includes `lib/` directory and runs `web-ext lint` before building

## [0.1.0] - 2025-05-01

### Added
- Initial release
- Request interception via `webRequest.onBeforeRequest` + `onBeforeSendHeaders`
- Request editor (method, URL, headers, body)
- Forward (replay via fetch) and Drop actions
- Drop All / Forward All bulk actions
- Scope policy with allowlist, wildcard domains, URL-contains filters, static asset bypass
- Long-press context menu to add domain to scope
- Repeater (save and re-run requests)
- Notes (save request+response pairs, export as .txt)
- Visual feedback (button animations, flash effects, fade-in)
- PANIC button to instantly disable interception
- Dark theme, mobile-first responsive UI
