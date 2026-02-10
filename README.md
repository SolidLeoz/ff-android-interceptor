# Mobile Interceptor (PT)

HTTP request interceptor + repeater for **authorized penetration testing** on Firefox Android (Nightly).

Intercept, inspect, edit and replay HTTP requests directly from your mobile device. Designed as a lightweight, mobile-first alternative to desktop proxy tools like Burp Suite.

## Features

- **Three Interception Modes** — OFF (default), OBSERVE (read-only monitoring), INTERCEPT (ARMED — holds requests via blocking Promise)
- **Hold & Release** — INTERCEPT mode holds requests in-flight; Forward releases them to the server and the page receives the real response. No more broken tabs
- **Response Capture** — Uses `filterResponseData()` to capture the response stream for dashboard display while passing it through to the page
- **ARMED Indicator** — Topbar turns red (INTERCEPT) or orange (OBSERVE) with a pulsing badge to prevent accidental interception
- **Editor** — Modify URL and headers before forwarding. Method and body are read-only (use Repeater for full editing)
- **Forward / Drop** — Forward releases the held request (with optional URL redirect and header edits); Drop cancels it
- **Drop All / Forward All** — Bulk actions to clear or forward the entire queue at once
- **Scope Policy** — Allowlist mode with domain patterns (`example.com`, `*.example.com`) and URL-contains filters (`/api/`, `/graphql`). Bypass static assets and OPTIONS requests
- **Long-press Context Menu** — Long-press (mobile) or right-click (desktop) on a queue item to add its domain to the scope
- **Repeater** — Save requests and re-run them on demand, useful for testing variations
- **Notes** — Save request+response pairs as notes with collapsible headers/body. Export all notes as a formatted `.txt` file
- **Automatic Redaction** — Sensitive headers and body fields are masked in display/export (toggle to reveal)
- **Audit Log** — Tracks all user actions with timestamps (max 500 entries)
- **Rate Limiting** — Replay throttling (200ms min interval, 60/min cap) to prevent accidental abuse
- **Visual Feedback** — Button press animations (scale + glow), green/red flash on success/failure, fade-in for new queue items
- **PANIC Button** — Instantly disable interception if something goes wrong

## Screenshots

*Coming soon*

## Installation

### Firefox Nightly (Android) via web-ext

Prerequisites: `adb`, `web-ext` (npm), USB debugging enabled on the device.

```bash
# Check device is connected
adb devices -l

# Build dist
npm install
npm run build

# Install and run (auto-reload on file changes)
web-ext run --target=firefox-android --source-dir=dist \
  --android-device=<DEVICE_ID> \
  --firefox-apk=org.mozilla.fenix \
  --adb-remove-old-artifacts
```

### Manual XPI install

```bash
# Build the XPI
./build.sh

# Push to device and open in Firefox
adb push mobile-interceptor.xpi /sdcard/Download/
# Then open file:///sdcard/Download/mobile-interceptor.xpi in Firefox
```

### Firefox Desktop (for development)

1. Run `npm install && npm run build`
2. Open `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Select `dist/manifest.json`

## Build

TypeScript + esbuild are used to produce a `dist/` package for MV3.

```bash
# Requirements: zip (infozip) + Node.js
sudo apt-get install -y zip
npm install

# Build dist + XPI
./build.sh
# Output: mobile-interceptor.xpi
```

## Security Guardrails

See [SECURITY.md](SECURITY.md) for the full threat model.

| Guardrail | Description |
|---|---|
| Default-deny scope | Allowlist mode — only explicitly listed domains are intercepted |
| OBSERVE mode | Read-only monitoring without cancelling requests |
| ARMED indicator | Visual warning when INTERCEPT mode is active |
| Sensitive data redaction | Auto-masks Authorization, Cookie, tokens in display/export |
| Rate limiting | 200ms min interval, 60/min cap on replays |
| Retention limits | 200 notes, 50 repeater items, 500 audit entries |
| Audit log | All actions logged with timestamps |
| No telemetry | Zero network calls except user-initiated replays |

## Project Structure

```
manifest.json          Extension manifest (Manifest V3, Gecko)
src/
  background/          Service worker modules (interception, replay, storage)
  lib/                 Shared utilities (redaction, policy helpers)
  ui/                  Dashboard UI (TS + HTML/CSS)
dist/                  Build output (packaged)
background.js          Legacy JS (kept for reference; build uses src/)
lib/                   Legacy JS (kept for reference; build uses src/)
ui/                    Legacy JS (kept for reference; build uses src/)
icons/
  icon-48.png          Extension icon 48x48
  icon-96.png          Extension icon 96x96
tests/
  test.js              Unit tests (Node.js assert)
scripts/
  build.js             Build pipeline (esbuild)
build.sh               Build script (lint + zip -> .xpi)
```

## Architecture

```
webRequest.onBeforeRequest      onBeforeSendHeaders (blocking)
        |                               |
   capture body                   capture/edit headers
   return Promise (HOLD)                |
        |                               |
        +-------> pending Map <---------+
                      |
                  queue[] (arrival order)
                      |
              dashboard.js (port)
                      |
            +---------+---------+
            |         |         |
         Forward    Drop     Repeater
       (resolve)  (cancel)  (fetch replay)
            |                     |
   filterResponseData          Notes
   (capture + pass-through)  (storage)
```

- **Hold model**: `onBeforeRequest` returns a Promise that holds the request. Forward resolves with `{}` or `{redirectUrl}`. Drop resolves with `{cancel: true}`
- **Header editing**: `onBeforeSendHeaders` (blocking) applies user-edited headers before the request reaches the server
- **Response capture**: `filterResponseData()` captures the response stream for the dashboard while passing it through to the page
- **Passthrough**: After forwarding a `main_frame`, sub-resources get a time-limited bypass to avoid re-interception
- **Safety**: Auto-forward after 60s timeout, on tab close, or on mode change
- **Repeater**: Uses `fetch()` replay for full editing (method, body, headers, URL)
- **Storage**: Repeater items and Notes are persisted in `browser.storage.local`

## Message Protocol

| Message Type | Direction | Description |
|---|---|---|
| `TOGGLE_INTERCEPT` | UI -> BG | Set mode (OFF/OBSERVE/INTERCEPT) |
| `GET_QUEUE` | UI -> BG | Get current queue entries |
| `DROP_REQUEST` | UI -> BG | Drop a single request |
| `FORWARD_REQUEST` | UI -> BG | Forward with edited params |
| `DROP_ALL` | UI -> BG | Drop all queued requests |
| `FORWARD_ALL` | UI -> BG | Forward all with original params |
| `SAVE/LIST/RUN/DELETE_REPEATER_ITEM` | UI -> BG | Repeater CRUD + replay |
| `SAVE/LIST/DELETE/CLEAR_NOTES` | UI -> BG | Notes CRUD |
| `LIST/CLEAR_AUDIT_LOG` | UI -> BG | Audit log read/clear |
| `GET/SET_POLICY` | UI -> BG | Scope policy |
| `QUEUE_UPDATED` | BG -> UI | Broadcast queue size + mode |
| `REQUEST_INTERCEPTED` | BG -> UI | New request captured |
| `RESPONSE_CAPTURED` | BG -> UI | Response captured via filterResponseData |
| `POLICY_UPDATED` | BG -> UI | Policy changed |

## Limitations

- **Method and body are read-only** in INTERCEPT mode (webRequest limitation) — use Repeater for full editing
- Some headers are **forbidden** by the browser (Host, Cookie, some Origin/Referer) even in blocking mode
- Multipart file uploads: raw file blobs are often **not available** via webRequest
- Body capture is capped at 256KB, response capture at 512KB
- Held requests auto-forward after **60 seconds** without user action
- Temporary add-on: removed when Firefox restarts (unless using a custom AMO collection)

## Permissions

| Permission | Reason |
|---|---|
| `webRequest` + `webRequestBlocking` | Intercept and cancel requests |
| `<all_urls>` | Intercept on any domain (scope filtering at app level) |
| `storage` | Persist policy, repeater items, notes, audit log |
| `tabs` | Navigate tabs after forward/drop |

## Testing

```bash
npm test     # Run 49 unit tests
npm run lint # Run web-ext lint
npm run typecheck # TypeScript type check
```

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — Version history
- [SECURITY.md](SECURITY.md) — Threat model and mitigations
- [PRIVACY.md](PRIVACY.md) — Privacy policy (AMO compliance)
- [LICENSE](LICENSE) — MIT License

## Legal Disclaimer

This tool is intended **exclusively** for:
- **Personal lab environments** — testing on your own devices and networks
- **Educational purposes** — learning about HTTP traffic, web security, and penetration testing techniques
- **Authorized penetration testing** — with explicit written permission from the system owner (e.g., bug bounty programs, contracted pentests, CTF challenges)

**You must NOT** use this tool to intercept, modify, or replay traffic on systems you do not own or do not have explicit written authorization to test. Unauthorized interception of network traffic may violate computer fraud and abuse laws in your jurisdiction.

The developers assume no liability for misuse of this tool. By installing and using this extension, you accept full responsibility for ensuring your use complies with all applicable laws and regulations.

## License

MIT — see [LICENSE](LICENSE)
