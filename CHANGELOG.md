# Changelog

## 1.0.2 — 2026-09-28

- Side panel can reconnect and replace an older page executor without refreshing the WeChat console.
- Versioned bridge and engine epoch checks prevent a stale executor from sending new requests.
- Unfinished batches survive extension reload and can be resumed from local history.
- Sent-but-unconfirmed items are only re-queried after reconnect; they are never automatically resubmitted.
- Added submission checkpoints so a reconnect can distinguish a new review record from an old one.
- Added 100 Node tests, including hot reconnect, queue serialization, pause, interruption, recovery, and message-origin checks.

## 1.0.0 — 2026-09-28

- Initial public release.
- Interface-based batch review submission for Chrome Manifest V3.
- Serial account switching, per-item progress, precheck mode, pause, history, and JSON export.
