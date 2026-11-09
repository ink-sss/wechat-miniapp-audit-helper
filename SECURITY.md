# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.x | Yes |
| < 1.0 | No |

## Reporting a vulnerability

Please use GitHub private vulnerability reporting if it is enabled for this repository:

<https://github.com/ink-sss/wechat-miniapp-audit-helper/security/advisories/new>

If that page is unavailable, open an issue asking for a private contact channel. Do not include secrets in the issue.

Do not open a public issue containing tokens, cookies, AppSecrets, full console responses, audit IDs, QR scene values, or account names.

## Security model

- The extension requests only `sidePanel`, `storage`, and `scripting`, plus host access to `https://mp.weixin.qq.com/*`.
- It does not request the `cookies` permission and does not read cookie values.
- The page token is read from the current console URL and kept in the page executor's memory. It is not written to `chrome.storage`, logs, history, or exports.
- Requests use `credentials: 'include'` so the browser supplies the existing console session.
- Start commands are accepted only from extension pages. Messages from the page or content script cannot start a review batch.
- A cross-tab `navigator.locks` queue prevents two tabs from submitting at the same time.
- Ambiguous submission responses are not retried. The executor only queries whether a new review record exists.

## Fixtures

All test fixtures are sanitized. Contributors must not commit real AppIDs, company names, account nicknames, audit IDs, tokens, cookies, or QR scene values.
