# Mobile Interceptor (PT)

HTTP request interceptor + repeater for **authorized penetration testing** on Firefox Android (Nightly).

Intercept, inspect, edit and replay HTTP requests directly from your mobile device. Designed as a lightweight, mobile-first alternative to desktop proxy tools like Burp Suite.

## Features

- **Request Interception** — Cancel and hold HTTP requests via `webRequest.onBeforeRequest` + `onBeforeSendHeaders`, capturing full headers and body
- **Editor** — Modify method, URL, headers (JSON), and body before forwarding
- **Forward / Drop** — Replay the edited request via `fetch()` or drop it entirely
- **Drop All / Forward All** — Bulk actions to clear or forward the entire queue at once
- **Scope Policy** — Allowlist mode with domain patterns (`example.com`, `*.example.com`) and URL-contains filters (`/api/`, `/graphql`). Bypass static assets and OPTIONS requests
- **Long-press Context Menu** — Long-press (mobile) or right-click (desktop) on a queue item to add its domain to the scope
- **Repeater** — Save requests and re-run them on demand, useful for testing variations
- **Notes** — Save request+response pairs as notes with collapsible headers/body. Export all notes as a formatted `.txt` file
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

## Project Structure

```
manifest.json          Extension manifest (Manifest V2, Gecko)
background.js          Background script: interception, replay, storage handlers
ui/
  dashboard.html       Dashboard UI
  dashboard.js         Dashboard logic: queue, editor, repeater, notes, context menu
  dashboard.css        Dark theme, animations, responsive layout
icons/
  icon-48.png          Extension icon 48x48
  icon-96.png          Extension icon 96x96
build.sh               Build script (zip -> .xpi)
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
| `TOGGLE_INTERCEPT` | UI -> BG | Enable/disable interception |
| `GET_QUEUE` | UI -> BG | Get current queue entries |
| `DROP_REQUEST` | UI -> BG | Drop a single request |
| `FORWARD_REQUEST` | UI -> BG | Forward with edited params |
| `DROP_ALL` | UI -> BG | Drop all queued requests |
| `FORWARD_ALL` | UI -> BG | Forward all with original params |
| `SAVE/LIST/RUN/DELETE_REPEATER_ITEM` | UI -> BG | Repeater CRUD + replay |
| `SAVE/LIST/DELETE/CLEAR_NOTES` | UI -> BG | Notes CRUD |
| `GET/SET_POLICY` | UI -> BG | Scope policy |
| `QUEUE_UPDATED` | BG -> UI | Broadcast queue size change |
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
| `<all_urls>` | Intercept on any domain |
| `storage` | Persist policy, repeater items, notes |
| `tabs` | Navigate tabs after forward/drop |
| `cookies` | Include credentials in replayed requests |

## Legal

This tool is intended **exclusively** for authorized security testing (penetration testing with written authorization, CTF challenges, bug bounty programs, security research on your own assets).

**Do not** use this tool to intercept, modify, or inspect traffic without explicit authorization from the system owner.

## License

MIT
