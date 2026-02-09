# Privacy Policy — Mobile Interceptor (PT)

**Last updated:** 2025-06-01

Mobile Interceptor is a penetration-testing tool designed for **authorized security assessments only**. This document describes how it handles data.

## Data accessed

The extension intercepts HTTP request and response data (URL, method, headers, body) **exclusively from domains the user has explicitly added** to the allowlist (Scope section). No data is collected from domains outside the scope.

## Data storage

- All data is stored **locally** on the device using `browser.storage.local`.
- **No data is transmitted** to any remote server, analytics service, or third party.
- There is no telemetry, tracking, beacons, or phone-home behaviour of any kind.

## Retention limits

To prevent unbounded storage growth, the extension enforces hard caps:

| Data type     | Max entries |
|---------------|-------------|
| Notes         | 200         |
| Repeater tabs | 50          |
| Audit log     | 500         |

Older entries are automatically removed (FIFO) when the limit is reached.

## Sensitive data handling

- Headers commonly carrying credentials (`Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, etc.) are **automatically redacted** (`[REDACTED]`) in the Response viewer, Notes display, and Notes export.
- The request Editor keeps values unredacted so the tester can modify them — this is intentional for the pen-testing workflow.
- A "Show sensitive" toggle lets the user temporarily reveal redacted values.

## Data export

- Notes can be exported as a `.txt` file. This action is **user-initiated only**.
- Exported notes apply the same automatic redaction described above.

## Permissions

| Permission            | Reason                                              |
|-----------------------|-----------------------------------------------------|
| `webRequest`          | Observe HTTP requests                               |
| `webRequestBlocking`  | Pause/cancel requests in INTERCEPT mode             |
| `<all_urls>`          | Scope filtering is handled at the application level |
| `storage`             | Persist notes, repeater items, audit log, policy    |
| `tabs`                | Open the dashboard in a new tab                     |

## Contact

For questions or concerns, open an issue at:
https://github.com/SolidLeoz/ff-android-interceptor/issues
