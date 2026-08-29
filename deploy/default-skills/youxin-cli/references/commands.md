# Youxin CLI Command Reference

Use this reference when exact flags, payload shapes, or output formats matter.

## Local Private Profiles

Before asking for credentials or scanning source code, check for a local private profile:

```text
~/.config/youxin-cli/profiles.json
```

Suggested schema:

```json
{
  "defaultProfile": "example",
  "profiles": {
    "example": {
      "displayName": "中文租户名称",
      "aliases": ["中文简称", "example"],
      "key": "YOUR_OPENAPI_KEY",
      "secret": "YOUR_OPENAPI_SECRET",
      "appId": "YOUR_APP_ID",
      "userId": "YOUR_USER_ID",
      "accountId": "OPTIONAL_ACCOUNT_ID"
    }
  }
}
```

Profile fields map to CLI/env inputs:

| Profile field | CLI/env meaning |
| --- | --- |
| `displayName` | Human-facing tenant name for agent/user matching. |
| `aliases` | Alternate profile names, including Chinese abbreviations. |
| `key` | `YOUXIN_OPENAPI_KEY` |
| `secret` | `YOUXIN_OPENAPI_SECRET` |
| `token` | `YOUXIN_ACCESS_TOKEN` |
| `refreshToken` | `YOUXIN_REFRESH_TOKEN` |
| `appId` | `YOUXIN_APP_ID` |
| `userId` | `YOUXIN_USER_ID` |
| `accountId` | `YOUXIN_ACCOUNT_ID` |

Selection rules:

1. If the user names a profile key, use that profile.
2. If the user mentions a tenant name, match exact `displayName`.
3. If no display name matches, match exact entries in `aliases`.
4. Otherwise use `defaultProfile`.
5. If there is exactly one profile and no `defaultProfile`, use that one.
6. If multiple profiles match or no default is clear, ask the user which one to use.

Usage rules:

- Never print profile secrets.
- Pass profile values to `youxin-cli` through environment variables (or stdin JSON with `--stdin-json`).
- Do not create or edit the profile unless the user explicitly asks.
- If no profile exists, suggest creating one to save future tokens and avoid rediscovering credentials/context.
- If no profile exists and source discovery is needed, ask for permission before inspecting tracked source files. Report candidate tenant/profile names, not secret values.

## Shared Inputs

### Credentials And Context

Credentials are resolved in this order:

1. Flags
2. Environment variables
3. Stdin JSON when `--stdin-json` is present

Supported credential inputs:

| Purpose | Flag | Environment variable | Stdin JSON key |
| --- | --- | --- | --- |
| OpenAPI key | `--key` | `YOUXIN_OPENAPI_KEY` | `credentials.key`, `key`, `openapiKey` |
| OpenAPI secret | `--secret` | `YOUXIN_OPENAPI_SECRET` | `credentials.secret`, `secret`, `openapiSecret` |
| Access token | `--token` | `YOUXIN_ACCESS_TOKEN` | `credentials.token`, `token`, `accessToken` |
| Refresh token | `--refresh-token` | `YOUXIN_REFRESH_TOKEN` | `credentials.refreshToken`, `refreshToken` |

If an access token is provided, the CLI uses it directly and does not fetch a new one. Otherwise, commands that call business APIs require an OpenAPI key and secret; the CLI fetches one access token per command invocation. The CLI does not refresh tokens during business commands — fetch a new one with `auth token` when the old one expires.

Request context inputs (`appId` and `userId` required for business commands; `accountId` optional):

| Purpose | Flag | Environment variable | Stdin JSON key |
| --- | --- | --- | --- |
| App ID | `--app-id` | `YOUXIN_APP_ID` | `context.appId`, `appId` |
| User ID | `--user-id` | `YOUXIN_USER_ID` | `context.userId`, `userId` |
| Account ID | `--account-id` | `YOUXIN_ACCOUNT_ID` | `context.accountId`, `accountId` |

Prefer environment variables or stdin JSON over command-line flags for secrets; flags can appear in shell history and process listings.

### Payload Input

Commands that accept request bodies support three payload modes.

Inline JSON:

```bash
youxin-cli object query \
  --form-code Account__s \
  --body '{"page":1,"num":10}'
```

JSON file:

```bash
youxin-cli object query \
  --form-code Account__s \
  --body-file ./query.json
```

Stdin JSON (requires the global `--stdin-json` flag):

```bash
printf '%s\n' '{"body":{"page":1,"num":10}}' |
  youxin-cli --stdin-json object query --form-code Account__s
```

With `--stdin-json`, the CLI uses `body` first, then `param`. If stdin JSON does not look like a credential/context envelope, the whole stdin object is treated as the request body. An example envelope:

```json
{
  "credentials": {
    "key": "YOUR_OPENAPI_KEY",
    "secret": "YOUR_OPENAPI_SECRET"
  },
  "context": {
    "appId": "YOUR_APP_ID",
    "userId": "YOUR_USER_ID"
  },
  "body": {
    "page": 1,
    "num": 10
  }
}
```

### Stdin Is Opt-In

`youxin-cli` does not consume stdin unless the global `--stdin-json` flag is present, so `help`, field inspection, and `--body-file` commands never wait on an unrelated open pipe. When `--stdin-json` is present, stdin is read until EOF — always provide a finite producer that closes stdin, such as `printf` or a heredoc.

## Commands

### `auth token`

Fetch an OpenAPI access token from an OpenAPI key and secret.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--key` | Yes unless provided by env/`--stdin-json` | OpenAPI key. |
| `--secret` | Yes unless provided by env/`--stdin-json` | OpenAPI secret. |
| `--refresh-token` | No | Refresh token. If provided, the wrapper uses refresh-token grant mode. |

Output:

```json
{
  "accessToken": "ACCESS_TOKEN",
  "expiresIn": 7200,
  "refreshToken": "REFRESH_TOKEN"
}
```

This command prints secrets. Redirect or store output carefully, and do not print token values back to the user.

Example with env vars:

```bash
export YOUXIN_OPENAPI_KEY='YOUR_OPENAPI_KEY'
export YOUXIN_OPENAPI_SECRET='YOUR_OPENAPI_SECRET'

youxin-cli auth token
```

### `auth resolve-token`

Resolve a Youxin login-state token into user and tenant information.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--login-token` | Yes unless provided by `--stdin-json` | Youxin platform login-state token. |

Output:

```json
{
  "companyId": 123,
  "companyName": "Example Company",
  "userId": 456,
  "memberId": 789,
  "appId": 1000,
  "phone": "13800000000",
  "name": "User Name"
}
```

Example:

```bash
youxin-cli auth resolve-token --login-token 'YOUXIN_LOGIN_TOKEN'
```

### `object fields`

Fetch object field metadata for a `formCode`.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--form-code` | Yes | Target object/form code, such as `Account__s`. |
| `--format` | No | Output format: `json`, `table`, or `csv`. Defaults to `json`. |
| `--useful` | No | Filter out noisy fields. See below. |
| Credentials | Yes | Access token or OpenAPI key/secret. |
| Context | Yes | `appId` and `userId`. |

What `--useful` filters out:

- Fields with an empty `fieldName`.
- Known system/audit field IDs: `CreatedBy`, `CreatedAt`, `UpdatedBy`, `UpdatedAt`, `OwnerId`, `OwnerDeptId`, `Deleted`, `Version`, `TenantId`, `CompanyId`.
- Field IDs starting with `_` or ending with `__r` (reverse relation fields).
- Fields named 创建人, 创建时间, 修改人, 修改时间, 负责人, 所属部门.

`--useful` only affects the `object fields` listing. Query results can still contain system fields such as `CreatorId`, `OrgId`, `sort`, and `app_id` — to get clean query output, pass an explicit `externalFields` list in `object query`.

Output with `--format json`:

```json
{
  "data": [
    {
      "fieldId": "Name",
      "fieldName": "名称",
      "fieldType": "文本",
      "fieldDescription": "Display name",
      "refObjectId": "OtherObject__c",
      "fieldOptions": [
        {
          "optionId": "open",
          "optionName": "Open"
        }
      ]
    }
  ]
}
```

Output with `--format table`:

```markdown
| Field ID | Name | Type | Ref Object | Options | Description |
| --- | --- | --- | --- | --- | --- |
| Name | 名称 | 文本 |  |  | Display name |
```

Output with `--format csv`:

```csv
Field ID,Name,Type,Ref Object,Options,Description
Name,名称,文本,,,Display name
```

Examples:

```bash
youxin-cli object fields --form-code Account__s --format table --useful
youxin-cli object fields --form-code Account__s --format json --useful
```

### `object query`

Query object records.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--form-code` | Yes | Target object/form code. This value overwrites any `formCode` in the body. |
| `--body` | No | Inline JSON query body. |
| `--body-file` | No | Path to a JSON query body file. |
| stdin JSON with `--stdin-json` | No | Query body or envelope. |
| Credentials | Yes | Access token or OpenAPI key/secret. |
| Context | Yes | `appId` and `userId`. |

Body fields:

| Body field | Description |
| --- | --- |
| `page` | Page number. Defaults to `1`. |
| `num` | Page size. Defaults to `10`. |
| `recordIds` | Numeric record IDs to fetch. |
| `externalFields` | Fields to return. Supports dot-path drilldown where the API supports it. |
| `fieldSorts` | Sort descriptors, for example `{ "fieldKey": "CreatedAt", "sortBy": "desc" }`. |
| `queryCriteria` | Exact-match criteria object keyed by field ID. |
| `search` | OR filter array. |
| `filter` | AND filter array. |

Filter conditions include:

```text
equal, unEqual, greater, smaller, greaterEqual, smallerEqual, in, notIn,
contains, notContains, like, isNull, isNotNull, begin_with, end_with
```

Output:

```json
{
  "page": {
    "total": 29,
    "pages": 3
  },
  "data": [
    {
      "recordId": 123,
      "fieldData": {
        "Name": "Example"
      }
    }
  ]
}
```

Minimal example:

```bash
youxin-cli object query \
  --form-code Account__s \
  --body '{"page":1,"num":10}'
```

Non-trivial filters:

```bash
youxin-cli object query \
  --form-code Account__s \
  --body-file ./query.json
```

```bash
cat > /tmp/query.json <<'JSON'
{
  "page": 1,
  "num": 10,
  "externalFields": ["Name", "OwnerId.Name"],
  "queryCriteria": {
    "Status__c": "open"
  }
}
JSON

youxin-cli object query --form-code Account__s --body-file /tmp/query.json
```

Summarize result counts and selected fields. Avoid dumping large record sets unless the user asks.

### `object upsert`

Insert or update object records.

This is a mutating command and requires `--yes`.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--form-code` | Yes | Target object/form code. This value overwrites any `formCode` in the body. |
| `--body` | No | Inline JSON upsert body. |
| `--body-file` | No | Path to JSON upsert body file. |
| stdin JSON with `--stdin-json` | No | Upsert body or envelope. |
| `--yes` | Yes | Required mutation confirmation. |
| Credentials | Yes | Access token or OpenAPI key/secret. |
| Context | Yes | `appId` and `userId`. |

Body fields:

| Body field | Required | Description |
| --- | --- | --- |
| `fieldDatas` | Yes for useful mutation | Array of field-data objects to insert/update. If omitted, v1 sends an empty array. To update an existing record, include its `recordId` in the field-data object; a partial-field update with `recordId` returns `state: "Update"`. |
| `autoNumberSettable` | No | Whether to manually set auto-number fields. |
| `bizRuleCloseable` | No | Whether to bypass business-rule checks. |
| `processCloseable` | No | Whether to bypass trigger/process execution. |
| `clearExistedSubRecord` | No | Whether to clear existing child records when updating with child data. |
| `subFormCodes` | No | Child form codes to clear when `clearExistedSubRecord` is true. |

Output:

```json
{
  "data": [
    {
      "successOrNot": true,
      "recordId": 123,
      "failMsg": null,
      "successMsg": "success",
      "state": "Insert",
      "formCode": "Account__s",
      "uniqKv": null,
      "importNo": "IMPORT_NO",
      "parentUniqKv": null,
      "parentRecordId": null,
      "parentFormCode": null,
      "parentImportNo": null
    }
  ]
}
```

Example:

```bash
cat > /tmp/upsert.json <<'JSON'
{
  "fieldDatas": [
    {
      "Name": "Example Account",
      "Status__c": {
        "name": "Open",
        "value": "open"
      }
    }
  ]
}
JSON

youxin-cli object upsert \
  --form-code Account__s \
  --body-file /tmp/upsert.json \
  --yes
```

Without `--yes`, the CLI exits with code `2` before sending a request and prints a dry-run summary.

### `object delete`

Delete object records by record ID.

This is a mutating command and requires `--yes`.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--form-code` | Yes | Target object/form code. |
| `--record-ids` | Yes | Comma-separated numeric record IDs, such as `123,456`. |
| `--yes` | Yes | Required mutation confirmation. |
| Credentials | Yes | Access token or OpenAPI key/secret. |
| Context | Yes | `appId` and `userId`. |

Output:

```json
{
  "data": [
    {
      "successOrNot": true,
      "recordId": 123,
      "failMsg": null,
      "successMsg": "success",
      "state": "Delete",
      "formCode": "Account__s"
    }
  ]
}
```

Example:

```bash
youxin-cli object delete \
  --form-code Account__s \
  --record-ids 123,456 \
  --yes
```

### `file upload`

Upload a local file to Youxin Cloud.

This is treated as a mutating command and requires `--yes`.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--file` | Yes | Local file path to upload. |
| `--operate-type` | Yes | Upload type: `image`, `audio`, `video`, or `file`. |
| `--file-name` | No | File name to send to the API. If omitted, no explicit `fileName` query parameter is sent. |
| `--yes` | Yes | Required mutation confirmation. |
| Credentials | Yes | Access token or OpenAPI key/secret. |
| Context | Yes | `appId` and `userId`. |

Output:

```json
{
  "url": "https://..."
}
```

Example:

```bash
youxin-cli file upload \
  --file ./example.pdf \
  --file-name example.pdf \
  --operate-type file \
  --yes
```

### `invoke`

Advanced raw OpenAPI caller. Use this when a wrapper is not yet exposed as a first-class CLI command; prefer first-class commands when available.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--method` | Yes | HTTP method, such as `POST`, `GET`, or `DELETE`. The CLI uppercases the value. |
| `--path` | Yes | OpenAPI path, such as `/openapi/object/record/page`. |
| `--body` | No | Inline JSON body. |
| `--body-file` | No | Path to JSON body file. |
| stdin JSON with `--stdin-json` | No | Body or envelope. |
| `--read-only` | Required for intentionally read-only non-`GET`/`HEAD` calls | Allows a `POST` read request without `--yes`. Useful because many Youxin read APIs use `POST`. |
| `--yes` | Required for mutations | Required for non-`GET`/`HEAD` requests unless `--read-only` is present. |
| Credentials | Yes | Access token or OpenAPI key/secret. |
| Context | Yes | `appId` and `userId`; `accountId` is passed through when supplied. |

Output is the raw normalized OpenAPI response:

```json
{
  "code": 0,
  "msg": "success",
  "page": {
    "total": 29,
    "pages": 3
  },
  "data": []
}
```

Read-only `POST` example:

```bash
youxin-cli invoke \
  --method POST \
  --path /openapi/object/record/page \
  --body '{"formCode":"Account__s","page":1,"num":1}' \
  --read-only
```

Mutating raw request example:

```bash
youxin-cli invoke \
  --method POST \
  --path /openapi/object/record/delete \
  --body '{"formCode":"Account__s","recordIds":[123]}' \
  --yes
```

## Field Value Shapes & Filter Value Rules

Never guess what a field's value looks like. Field values differ by `fieldType`, and the shape used for reading (query results), writing (upsert), and filtering is often different.

### Golden Rule: Resolve Value Domains Before Filtering Or Writing

- **Single/multi-select fields**: run `object fields` first and use `fieldOptions[].optionId` as the filter/written value — never the option name. Filtering by option name silently matches nothing.
- **Lookup fields**: query the referenced object first to obtain the target `recordId`, then filter the lookup field by that numeric `recordId`.

### Per-Type Value Shapes

| fieldType | Query result (`fieldData[...]`) | Upsert write value | Filter `value` |
| --- | --- | --- | --- |
| 文本 | String | String | String |
| 数值 | Number | Number | Number |
| 日期 | String `"yyyy-MM-dd HH:mm:ss"` | String `"yyyy-MM-dd HH:mm:ss"` | Same string format |
| 单选 | `{ "name": "供应商", "value": "supplier" }` | `{ "name": "...", "value": "<optionId>" }` | optionId string |
| 查找 | `[{ "recordId": 259541, "formCode": "fml__Port__c", "rowData": { ... } }]` | `[{ "recordId": 259541, "formCode": "fml__Port__c" }]` — same shape as read, minus `rowData` | Numeric `recordId` of the referenced record |
| 附件 | `[{ "url": "...", "fileName": "...", "ext": ".pdf", "size": 123 }]` | Inspect a sample record before writing | Inspect a sample record before filtering |

Notes on each shape:

- **单选**: the query result is an object with `name` (display) and `value` (optionId). Filter and `queryCriteria` match the optionId only. When writing via upsert, pass the full `{ name, value }` object.
- **查找**: the query result is an array (even for single-value lookups) of `{ recordId, formCode }`; when the field is requested via a dot path in `externalFields`, each item also carries `rowData` with the referenced record's fields. System fields like `CreatorId` and `OwnerId` use the same lookup shape pointing at `User__s`. Writing a lookup takes the same array shape without `rowData`: `[{"recordId": 259541, "formCode": "fml__Port__c"}]`.
- **多选**: read/write/filter shapes vary — inspect a sample record and the field's `fieldOptions` before writing.
- The raw query response also mixes in system fields (`recordId`, `OrgId`, `app_id`, `RecordType`, `sort`, `CreatorId`, ...). Pass an explicit `externalFields` list to keep output clean.

### Filter Condition Semantics

| Condition | Value form | Example |
| --- | --- | --- |
| `contains` | Bare string | `{"key":"Name__c","condition":"contains","value":"码头"}` |
| `like` | Requires `%` wildcards; a bare value matches nothing | `{"key":"Name__c","condition":"like","value":"%码头%"}` |
| `in` / `notIn` | Array of values | `{"key":"recordId","condition":"in","value":[259772,259771]}` |
| `isNull` / `isNotNull` | Omit `value` | `{"key":"File__c","condition":"isNull"}` |

### Filtering Lookup Fields — Two Working Forms

Given a lookup field `Portid__c` (查找 → `fml__Port__c`), both forms work:

```json
{ "key": "Portid__c", "condition": "equal", "value": 259541 }
```

```json
{ "key": "Portid__c.Name__c", "condition": "equal", "value": "大仓" }
```

The first filters by the referenced record's ID; the second filters by a field of the referenced record via a dot-path key.

### Caveats

- `in` with an array value works on text and numeric fields, but on single-select fields it fails with a `服务繁忙` server error. Prefer `equal` on the optionId, or multiple `filter` entries (AND) / `search` entries (OR).
- Dot-path `externalFields` (e.g. `Portid__c.Name__c`) returns the value nested in the lookup array's `rowData`, not flattened.
- `like` without `%` wildcards silently matches nothing — use `contains` for substring matching.



Use this section when the user asks for useful fields, display fields, export field paths, sync field paths, comma-separated field IDs, or lookup drilldowns.

### Detect Lookup Fields

Start with JSON field metadata:

```bash
youxin-cli object fields --form-code ROOT_FORM_CODE --format json --useful
```

A lookup candidate is usually a field where:

- `fieldType` is `查找`, or otherwise clearly means lookup/reference in the tenant language.
- `refObjectId` is present and names the referenced object/form code.

### Fetch Referenced Fields

Fetch referenced fields only when the lookup field itself is not enough for the user's task:

```bash
youxin-cli object fields --form-code REF_OBJECT_ID --format json --useful
```

Do not recursively fetch every lookup. Fetch only references that are likely to produce a better display value.

### Prefer Human-Meaningful Paths

Construct dot paths by joining the lookup field ID and a useful referenced field ID:

```text
LookupField__c.DisplayField__c
```

Prefer referenced fields with names or IDs suggesting:

- name
- code / number
- title
- status
- user name
- currency name
- payment method name
- customer/supplier/vendor name

Examples:

```text
fml__Currency__c.Name__c
fml__PaymentMethod__c.Name__c
Reviewer__c.UserId.Name
```

### Depth Rules

- Use one-level drilldown when it gives a readable value.
- Use multi-level drilldown only when the first target is another wrapper/lookup and the deeper field is clearly better.
- Stop at a reasonable display field. Do not explore arbitrary relationship graphs.
- If multiple candidate display fields exist, include the most stable field first, usually name/title/code before status/description.

### Output Rules

For a requested comma-separated list, return only a copyable code block:

```text
Name,fml__Currency__c.Name__c,fml__PaymentMethod__c.Name__c,Reviewer__c.UserId.Name
```

For a field review, include a compact table with:

```text
Field Path, Label, Source Field, Type, Reason
```

Keep curation task-focused. Avoid exposing noisy audit/system fields unless the user asks for them.

## Error Behavior

On success, the CLI writes output to stdout and exits with code `0`.

On error, the CLI writes a concise error to stderr and exits non-zero:

- Exit code `2` is used for CLI usage errors and safety refusals.
- Exit code `1` is used for unexpected failures, including upstream API errors such as `服务繁忙` (the CLI retries such transient errors once before failing).

The error formatter redacts obvious secret-like text in error messages, including JSON fields named `key`, `secret`, `token`, `authorization`, and `refreshToken`, plus bearer tokens.

## Practical Patterns

### Use Env Vars For Repeated Work

```bash
export YOUXIN_OPENAPI_KEY='YOUR_OPENAPI_KEY'
export YOUXIN_OPENAPI_SECRET='YOUR_OPENAPI_SECRET'
export YOUXIN_APP_ID='YOUR_APP_ID'
export YOUXIN_USER_ID='YOUR_USER_ID'

youxin-cli object fields --form-code Account__s --format table --useful
```

### Reuse A Token Explicitly

```bash
youxin-cli auth token > /tmp/youxin-token.json

export YOUXIN_ACCESS_TOKEN="$(jq -r '.accessToken' /tmp/youxin-token.json)"
export YOUXIN_APP_ID='YOUR_APP_ID'
export YOUXIN_USER_ID='YOUR_USER_ID'

youxin-cli object fields --form-code Account__s --format json
```
