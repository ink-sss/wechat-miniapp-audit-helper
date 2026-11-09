# Architecture

## Overview

The extension has four runtime parts:

```text
panel.html / panel.js
        │ chrome.runtime.sendMessage
        ▼
background.js (service worker)
        │ chrome.scripting.executeScript
        ▼
content.js + engine.js (isolated world in mp.weixin.qq.com)
        │ fetch(credentials: include)
        ▼
mp.weixin.qq.com web-console endpoints
```

## Components

### Side panel

- Reads state from the service worker with `STATE`.
- Renders the mini program list, per-item progress, history, and settings.
- Sends only `START`, `PAUSE`, `REFRESH`, `OPEN_CURRENT`, and `STATE` messages.
- Saves UI preferences and the last selected set in `chrome.storage.session`.
- Never runs fetch and never sees the page token.

### Service worker

- Finds a valid `https://mp.weixin.qq.com/*` tab whose URL contains a numeric `token`.
- Injects `shared.js`, `engine.js`, and `content.js` into the page's isolated world when needed.
- Uses a versioned bridge (`__auditBridgeV2`) and protocol number to avoid stale executors.
- Uses `navigator.locks` (`wechat-audit-serial-v1`) to serialize work across tabs.
- Persists the active batch, per-window view, and last 10 completed batches.
- On reconnect, only re-queries the current mini program. It never switches or resubmits automatically.

### Page executor (`content.js`)

- Owns the batch state machine and publishes progress to the service worker.
- Runs one task at a time.
- Stops the queue on an uncertain result.
- Rejects `START` if the account list signature changed since the list was read.
- Accepts commands only through the versioned bridge, not through a second `runtime.onMessage` listener.

### Interface engine (`engine.js`)

- Reads the token from the current URL into memory.
- Provides `inspect`, `process`, `observeAudit`, `openCurrent`, and `stop`.
- Restricts requests to `/wxamp/cgi/` on the current origin.
- Adds `token`, `lang=zh_CN`, and a random query parameter to every request.
- Uses a 30-second `AbortController` timeout.
- Throws typed errors (`LOGIN_REQUIRED`, `SCHEMA_CHANGED`, `TRANSPORT_UNCERTAIN`, etc.) instead of returning raw responses.

### Shared model (`shared.js`)

- Stage names and progress percentages.
- Task validation (1–200 items, unique AppID, version length, description length).
- Job creation, progress updates, result mapping, interruption, and counts.
- Terminal statuses: `success`, `skipped`, `failed`, `uncertain`, `ready`.

## Batch lifecycle

```text
waiting
  └─ switching (0%)       switchAccount
       └─ reading (20%)    getcodepage / get_class / privacy
            ├─ skipped     already under review
            └─ prepared (40%)
                 ├─ ready (40%)          precheck only
                 └─ submitting (60%)     submit_check
                      └─ verifying (80%) verify new audit record
                           ├─ success (100%)
                           ├─ uncertain       response lost; query only
                           └─ failed          explicit error
```

`uncertain` is not a failure that can be retried blindly. It means the request may have reached WeChat. The user must check the console before running that item again.

## Safety invariants

1. **One submission at a time.** The page executor has a `busy` flag and the service worker holds a cross-tab lock.
2. **Fresh token per switch.** `switchAccount` returns a new token; the engine updates the in-memory token and the visible URL via `history.replaceState`.
3. **Identity is re-checked before writing.** The engine verifies the current account name and AppID both before preparing and immediately before `submit_check`.
4. **Version is re-checked before writing.** The development package's `open_id`, `version`, and `time` must still match.
5. **Existing audit is re-checked.** If the audit record changes between precheck and submit, the item stops with `AUDIT_CHANGED`.
6. **Ambiguous responses are not retried.** A lost response triggers a read-only verification loop; if no new audit record appears, the item stops as `SUBMISSION_UNCONFIRMED`.
7. **Reconnect is read-only.** A reconnect can mark an `uncertain` item successful if a new audit record matches the checkpoint, but it cannot start a submission.
8. **No secrets in storage.** The token is memory-only. History stores task metadata, status, audit ID, and timestamps, not request headers or cookies.

## Extension reload behavior

`engine.js` embeds `runtimeVersion = "1.0.2"` and `protocolVersion = 2`. On reload:

- The service worker checks the page bridge's version and protocol.
- If the bridge is missing, old, or disconnected, it tries to replace it.
- A stale executor's `__auditEngineEpochV2` no longer matches and its requests fail with `ENGINE_REPLACED`.
- The old executor is stopped before the new one is injected.

This is why the console tab does not need to be refreshed after updating the extension.

## Failure handling

| Code | Meaning | Queue behavior |
| --- | --- | --- |
| `LOGIN_REQUIRED` | No token in the URL | Stop |
| `SCHEMA_CHANGED` | Expected response field missing | Stop |
| `IDENTITY_MISMATCH` | Account changed unexpectedly | Stop |
| `VERSION_NOT_FOUND` | No development package for the version | Continue to next item |
| `AMBIGUOUS_VERSION` | Multiple developers have the same version | Continue; UI offers choices |
| `SKIP_REVIEWING` | Already under review | Continue |
| `PRIVACY_NEEDS_INPUT` | Privacy guide requires manual input | Continue |
| `TEST_ACCOUNT_REQUIRED` | Test account flow | Continue |
| `EXTRA_FLOW_REQUIRED` | QR/declaration flow | Continue |
| `TRANSPORT_UNCERTAIN` | Network failure during submit | Stop; query only |
| `SUBMISSION_UNCONFIRMED` | Submit may have landed but no record found | Stop; manual check |
| `BUSY` | Another tab holds the lock | Stop |
