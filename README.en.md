# WeChat Mini Program Audit Helper

A Chrome Manifest V3 side-panel extension for batch-submitting WeChat Mini Programs for review through the `mp.weixin.qq.com` web console APIs.

It does **not** click through the UI. It runs inside an already-authenticated WeChat console tab and calls the same web endpoints used by the console: list mini programs, switch accounts, read development versions and review metadata, submit for review, then verify that a new review record exists.

> **Read before use**
>
> - Unofficial project; not affiliated with Tencent or WeChat.
> - Uses undocumented web-console endpoints, not the official third-party platform API. Endpoints may change without notice.
> - "Start review" submits a real review request. It does not publish, withdraw, or delete a version.
> - Use only with accounts you own or are authorized to manage. Test on one mini program first.
> - No warranty. See [LICENSE](LICENSE).

[中文说明](README.md)

## Highlights

- Reads the mini program list from the current logged-in account.
- Serial account switching with fresh token handling.
- Per-item progress: 20% → 40% → 60% → 80% → 100%.
- Skips items already under review; never withdraws or deletes.
- Verifies a new audit record after submission.
- Never retries a submission with an uncertain response; it only queries state.
- Pause-after-current, resume pending items, retry explicit failures.
- Keeps the last 10 batches locally and exports JSON.
- No cookie permission, no token persistence, no telemetry, no remote code.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `extension` directory (the one containing `manifest.json`).
6. Pin **小程序提审助手** to the toolbar.

Chrome 116+ is required. No build step.

## Usage

1. Sign in at `https://mp.weixin.qq.com/` and open a mini program console. The URL must contain a `token=` parameter.
2. Click the extension icon to open the side panel.
3. Select mini programs, enter the development version (for example `1.2.4`).
4. Run **Only precheck** first. It switches accounts and reads metadata without submitting.
5. Run **Start review** when ready.

## Safety model

- Host permission is limited to `https://mp.weixin.qq.com/*`.
- The page token stays in memory; it is never written to extension storage.
- A cross-tab `navigator.locks` queue prevents concurrent submissions.
- Identity, version, and audit state are re-checked immediately before submission.
- Ambiguous transport errors are never retried; the extension only queries whether a review record was created.
- Special flows (test accounts, extra declarations, QR steps, screenshots/videos) stop with an explanation.

## Development

```bash
npm install
npm test
npm run test:ui
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/API-NOTES.md](docs/API-NOTES.md).

## License

MIT
