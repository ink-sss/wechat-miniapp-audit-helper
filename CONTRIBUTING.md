# Contributing

Thanks for taking a look. This project touches a real review-submission flow, so changes should stay small and testable.

## Development

```bash
npm install
npm test
npm run test:ui
```

The extension is plain Manifest V3 JavaScript. There is no build step.

## Before opening a PR

- Run `npm test` and `npm run test:ui`.
- Keep the submission path conservative: no automatic retry after an ambiguous response.
- Preserve the serial queue and the identity/version checks before submission.
- Do not add cookie access, remote code, telemetry, or third-party uploads.
- Do not commit real console captures. Replace AppIDs with `wxTARGET`, names with `示例商城 A`, audit IDs with `900000001`, and QR scene values with `TARGET_SCENE`.
- Describe any change to the observed WeChat response schema in `docs/API-NOTES.md`.

## Code style

- Existing files use compact JavaScript; match the surrounding style.
- New user-facing strings should be Chinese, consistent with the side panel.
- Prefer explicit error codes over generic failures.
- Do not include request URLs or tokens in error messages shown to users.

## Reporting a security issue

See [SECURITY.md](SECURITY.md).
