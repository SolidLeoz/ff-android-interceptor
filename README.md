# Mobile Interceptor (PT)

HTTP request interceptor + repeater for **authorized penetration testing** on Firefox Android (Nightly).

Intercept, inspect, edit and replay HTTP requests directly from your mobile device. Designed as a lightweight, mobile-first alternative to desktop proxy tools like Burp Suite.

## Features

- **Three Interception Modes** — OFF (default), OBSERVE (read-only monitoring), INTERCEPT (ARMED — cancels and holds requests)
- **Request Interception** — Cancel and hold HTTP requests via `webRequest.onBeforeRequest` + `onBeforeSendHeaders`, capturing full headers and body
- **ARMED Indicator** — Topbar turns red (INTERCEPT) or orange (OBSERVE) with a pulsing badge to prevent accidental interception
- **Editor** — Modify method, URL, headers (JSON), and body before forwarding
- **Forward / Drop** — Replay the edited request via `fetch()` or drop it entirely
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

# Install and run (auto-reload on file changes)
web-ext run --target=firefox-android \
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

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json`

## Build

No bundlers, transpilers, or build tools — source files are shipped as-is.

```bash
# Only requirement: zip (infozip)
sudo apt-get install -y zip

# Build XPI
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
manifest.json          Extension manifest (Manifest V2, Gecko)
background.js          Background script: interception, replay, storage handlers
lib/
  redact.js            Shared: redaction, retention trimming, rate limiting
  utils.js             Shared: header normalization, scope matching, parsing
ui/
  dashboard.html       Dashboard UI
  dashboard.js         Dashboard logic: queue, editor, repeater, notes, audit
  dashboard.css        Dark theme, animations, responsive layout
icons/
  icon-48.png          Extension icon 48x48
  icon-96.png          Extension icon 96x96
tests/
  test.js              Unit tests (40 cases, Node.js assert)
build.sh               Build script (lint + zip -> .xpi)
```

## Architecture

```
webRequest.onBeforeRequest     webRequest.onBeforeSendHeaders
        |                               |
   capture body                   capture headers + cancel
        |                               |
        +-------> pending Map <----------+
                      |
                  queue[] (arrival order)
                      |
              dashboard.js (port)
                      |
            +---------+---------+
            |         |         |
         Forward    Drop     Repeater
         (fetch)  (discard)  (storage)
                      |
                    Notes
                  (storage)
```

- **Interception**: `onBeforeRequest` captures the body, `onBeforeSendHeaders` captures headers then cancels the request
- **Forward**: Replays via `fetch()` with user-edited parameters. Navigates the original tab for `main_frame` requests
- **Passthrough**: After forwarding, the tab gets a time-limited bypass to avoid re-intercepting sub-resources
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
| `POLICY_UPDATED` | BG -> UI | Policy changed |

## Limitations

- The original request is **cancelled**; "Forward" is a **replay** via `fetch()` — not a true MITM proxy
- Some headers are **forbidden** by the browser (Host, Cookie, some Origin/Referer)
- Multipart file uploads: raw file blobs are often **not available** via webRequest
- Body capture is capped at 256KB, response capture at 512KB
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
npm test     # Run 40 unit tests
npm run lint # Run web-ext lint
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
