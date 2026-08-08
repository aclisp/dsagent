# Youxin CLI Command Reference

Use this reference when exact flags, payload shapes, or output formats matter.

## Shared Inputs

### Stdin JSON

`youxin-cli` does not consume stdin unless the global `--stdin-json` flag is present. This keeps
commands such as `help`, field inspection, and commands using `--body-file` from waiting on an open
pipe. With `--stdin-json`, stdin is read until EOF, so provide a finite producer that closes stdin:

```bash
printf '%s\n' '{"body":{"page":1,"num":10}}' | youxin-cli --stdin-json object query --form-code Account__s
```

Use profiles or environment variables for secrets instead of embedding them in the producer
command. Omit `--stdin-json` when using flags, profiles, environment variables, or `--body-file`.


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
- Prefer passing profile values to `youxin-cli` through env vars or stdin JSON with `--stdin-json`.
- Do not create or edit the profile unless the user explicitly asks.
- If no profile exists, suggest creating one to save future tokens and avoid rediscovering credentials/context.
- If no profile exists and source discovery is needed, ask for permission before inspecting tracked source files. Report candidate tenant/profile names, not secret values.

Example stdin envelope produced from a profile:

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

Credentials:

| Purpose | Flag | Environment variable | Stdin JSON key |
| --- | --- | --- | --- |
| OpenAPI key | `--key` | `YOUXIN_OPENAPI_KEY` | `credentials.key`, `key`, `openapiKey` |
| OpenAPI secret | `--secret` | `YOUXIN_OPENAPI_SECRET` | `credentials.secret`, `secret`, `openapiSecret` |
| Access token | `--token` | `YOUXIN_ACCESS_TOKEN` | `credentials.token`, `token`, `accessToken` |
| Refresh token | `--refresh-token` | `YOUXIN_REFRESH_TOKEN` | `credentials.refreshToken`, `refreshToken` |

Context:

| Purpose | Flag | Environment variable | Stdin JSON key |
| --- | --- | --- | --- |
| App ID | `--app-id` | `YOUXIN_APP_ID` | `context.appId`, `appId` |
| User ID | `--user-id` | `YOUXIN_USER_ID` | `context.userId`, `userId` |
| Account ID | `--account-id` | `YOUXIN_ACCOUNT_ID` | `context.accountId`, `accountId` |

Payloads:

- `--body '{"page":1,"num":10}'`
- `--body-file ./payload.json`
- stdin JSON with `--stdin-json` and a finite producer that closes stdin

## Commands

### `auth token`

Fetch an OpenAPI access token.

```bash
youxin-cli auth token
```

Output:

```json
{
  "accessToken": "ACCESS_TOKEN",
  "expiresIn": 7200,
  "refreshToken": "REFRESH_TOKEN"
}
```

Do not print token values back to the user.

### `auth resolve-token`

Resolve a Youxin login-state token.

```bash
youxin-cli auth resolve-token --login-token YOUXIN_LOGIN_TOKEN
```

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

### `object fields`

Fetch object field metadata.

```bash
youxin-cli object fields --form-code Account__s --format json|table|csv --useful
```

Arguments:

- `--form-code`: required.
- `--format`: optional, defaults to `json`.
- `--useful`: optional deterministic filter for noisy system/internal fields.

JSON output:

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

Table output columns:

```text
Field ID, Name, Type, Ref Object, Options, Description
```

## Lookup Drilldown Curation

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

### `object query`

Query object records.

```bash
youxin-cli object query --form-code Account__s --body-file ./query.json
```

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

### `object upsert`

Insert or update object records. Requires user confirmation and `--yes`.

```bash
youxin-cli object upsert --form-code Account__s --body-file ./upsert.json --yes
```

Body fields:

- `fieldDatas`: array of field-data objects.
- `autoNumberSettable`
- `bizRuleCloseable`
- `processCloseable`
- `clearExistedSubRecord`
- `subFormCodes`

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

### `object delete`

Delete object records by record ID. Requires user confirmation and `--yes`.

```bash
youxin-cli object delete --form-code Account__s --record-ids 123,456 --yes
```

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

### `file upload`

Upload a local file. Requires user confirmation and `--yes`.

```bash
youxin-cli file upload --file ./example.pdf --file-name example.pdf --operate-type file --yes
```

Arguments:

- `--file`: required local path.
- `--operate-type`: `image`, `audio`, `video`, or `file`.
- `--file-name`: optional API file name.

Output:

```json
{
  "url": "https://..."
}
```

### `invoke`

Advanced raw OpenAPI call.

```bash
youxin-cli invoke --method POST --path /openapi/object/record/page --body-file ./payload.json --read-only
```

Arguments:

- `--method`: required.
- `--path`: required.
- `--body`, `--body-file`, or stdin JSON.
- `--read-only`: use for known read-only non-`GET`/`HEAD` calls.
- `--yes`: use only after user confirmation for mutating calls.

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

## Error Behavior

- Success writes output to stdout and exits `0`.
- Usage errors and safety refusals exit `2`.
- Unexpected failures exit `1`.
- Error output redacts obvious secret fields and bearer tokens.
