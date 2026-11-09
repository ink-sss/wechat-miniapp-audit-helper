# API notes

These are the web-console endpoints used by the extension. They are not a public or documented API. Paths, field names, and response envelopes can change without notice.

All requests are same-origin to `https://mp.weixin.qq.com`, include the console session via `credentials: 'include'`, and append:

```text
token=<current page token>
lang=zh_CN
random=<random number>
```

The engine rejects any request whose path does not start with `/wxamp/cgi/`.

## Endpoints

| Purpose | Request | Notes |
| --- | --- | --- |
| List mini programs | `GET /wxamp/cgi/getWxaList` | Response field is `wax_list` (not `wxa_list`). Each item has `app_name`, `appid`, `username`. |
| Switch account | `POST /wxamp/cgi/switchAccount` | Form body `appid=<target>`. Response contains a new `token`. The page URL is updated with `history.replaceState`; no navigation. |
| Current identity | `GET /wxamp/cgi/route?path=/wxopen/basicprofile?action=index&f=json...` | Uses `setting_info.original_appid` and `setting_info.nickname`. |
| Development versions | `GET /wxamp/cgi/route?path=/wxopen/wacodepage?action=getcodepage&f=json...` | `code_data` is a JSON string. Contains `develop_info.info_list`, `experience_info.basic_info`, and `online_info.basic_info`. |
| Review form metadata | `GET /wxamp/cgi/route?path=/wxopen/wadevelopcode?action=get_class&openid=<open_id>&user_name=<nick>&f=json...` | `class_info` and `public_key_info` are JSON strings. `public_key_info.auto_id` is required in the submit body. |
| Privacy metadata | `GET /wxamp/cgi/version/getMpPrivacyMetaMsg?version_openid=<open_id>` | Requires `data.ret === 0`, `success === true`, `needFill === 0`, `checkRet === 0`, and `ackNoPrivacy` in `{0,1}`. |
| Apply privacy choice | `GET /wxamp/cgi/version/updatePrivacyCollectMgr?is_not_collect=<0|1>&version_openid=<open_id>` | Uses the existing `ackNoPrivacy` value. |
| Submit review | `POST /wxamp/cgi/route?path=/wxopen/wadevelopcode?action=submit_check&f=json...` | Form body includes `ticket=qrcheckTicket`, `openid`, `auto_id`, `version_desc`, `order_path`, `preview_info`, and empty optional fields. |

## Response checks

Every response is checked for:

```js
data.ret === 0
data.base_resp?.ret === 0   // when present
```

A non-zero value stops the current item. The engine does not guess or repair an error response.

## Audit state

`experience_info.basic_info` is treated as “under review” when:

```js
audit_id != null && Number(audit_status) === 1
```

A successful submission is confirmed only when a subsequent read shows:

- the same `open_id` and `version` as the prepared development package;
- a new `audit_id` different from the pre-submit `audit_id`;
- `time >= submitStart - 15` seconds.

This prevents an old review record from being mistaken for a new submission.

## Submit body shape

The current implementation sends:

```text
ticket=qrcheckTicket
openid=<development package open_id>
auto_id=<public_key_info.auto_id>
version_desc=<description or 完善功能>
speedup_audit=0
speedup_type=<class_info.speedup_type or 修复漏洞>
speedup_desc=
encrypted_username=
encrypted_password=
remark=<task remark or class_info.remark>
order_path=<existing path, empty, or custom>
feedback_info=
feedback_status=1
only_run_wxwork=0
argue_item=
preview_info={"pic_id_list":[],"video_id_list":[]}
feedback_stuff=
```

The extension does not add screenshots or videos, does not fill test accounts, and stops when the console reports those flows as required.

## Capturing new traffic

If WeChat changes the schema:

1. Capture a successful manual submission from a test account.
2. Remove cookies, tokens, AppIDs, company names, account nicknames, audit IDs, and QR scene values.
3. Keep only the field shape needed by `engine.js`.
4. Add a sanitized fixture under `tests/fixtures.json`.
5. Update the relevant test and this document.

Never commit a raw HAR file. HAR files contain cookies, tokens, and full account data.
