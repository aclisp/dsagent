# Youxin CLI Usage Manual

`youxin-cli` is a credential-neutral command-line adapter for the Youxin Cloud OpenAPI wrappers in `src/youxin.cloud`.

The CLI does not import repo tenant constants and does not ship built-in tenant credentials. Provide credentials through flags, environment variables, or opt-in stdin JSON.

## Build And Run

Build the standalone binary:

```bash
bun run build:youxin-cli
```

Run the compiled binary:

```bash
youxin-cli help
```

Run directly from source during development:

```bash
bun run src/youxin-cli/index.ts help
```

## Global Inputs

Most commands need credentials and a request context.

### Stdin JSON Is Opt-In

The CLI never reads stdin unless the global `--stdin-json` flag is present. When enabled, it reads stdin until EOF and accepts the credential, context, body, `param`, and bare request-object envelopes described below.

`--stdin-json` requires a finite producer or an explicit EOF. An open pipe that never closes cannot be parsed and will keep the command waiting by design.

Examples that do not read stdin:

```bash
youxin-cli help
youxin-cli object fields --form-code Account__s --format json
youxin-cli object query --form-code Account__s --body-file ./query.json
```

### Credentials

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

If `--token`, `YOUXIN_ACCESS_TOKEN`, or an access token from `--stdin-json` is provided, the CLI uses that token directly and does not fetch a new one.

If no access token is provided, commands that call business APIs require an OpenAPI key and secret. The CLI fetches one access token for that command invocation.

Prefer environment variables or stdin JSON supplied with `--stdin-json` for secrets. Command-line flags are convenient for manual testing, but they can appear in shell history and process listings.

### Request Context

Business API commands also need `appId` and `userId`.

Context values are resolved in this order:

1. Flags
2. Environment variables
3. Stdin JSON when `--stdin-json` is present

Supported context inputs:

| Purpose | Flag | Environment variable | Stdin JSON key |
| --- | --- | --- | --- |
| App ID | `--app-id` | `YOUXIN_APP_ID` | `context.appId`, `appId` |
| User ID | `--user-id` | `YOUXIN_USER_ID` | `context.userId`, `userId` |
| Account ID | `--account-id` | `YOUXIN_ACCOUNT_ID` | `context.accountId`, `accountId` |

`accountId` is optional in v1. The current first-class object and file commands pass an empty account ID to the underlying wrapper when the API does not require one.

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

Stdin JSON:

```bash
printf '%s\n' '{"body":{"page":1,"num":10}}' |
  youxin-cli --stdin-json object query --form-code Account__s
```

With `--stdin-json`, the CLI uses `body` first, then `param`. If stdin JSON does not look like a credential/context envelope, the whole stdin object is treated as the request body.

Example envelope:

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

### Safety For Mutations

Mutating commands require `--yes`.

Affected commands:

- `object upsert`
- `object delete`
- `file upload`
- `invoke` for non-`GET`/`HEAD` methods unless `--read-only` is supplied

Without `--yes`, the CLI exits before resolving credentials or sending a request and prints a dry-run summary.

Example:

```bash
youxin-cli object delete --form-code Account__s --record-ids 123
```

Output:

```text
Refusing to run mutating command without --yes.
Dry run: object delete formCode=Account__s recordIds=123
```

## Command Reference

### `help`

Print command usage.

```bash
youxin-cli help
youxin-cli --help
```

Output:

```text
Usage:
  youxin-cli [--stdin-json] <command> [options]
  youxin-cli auth token
  youxin-cli auth resolve-token --login-token <token>
  youxin-cli object fields --form-code <formCode> [--format json|table|csv] [--useful]
  youxin-cli object query --form-code <formCode> [--body|--body-file]
  youxin-cli object upsert --form-code <formCode> [--body|--body-file] --yes
  youxin-cli object delete --form-code <formCode> --record-ids <ids> --yes
  youxin-cli file upload --file <path> --operate-type image|audio|video|file --yes
  youxin-cli invoke --method <method> --path <path> [--body|--body-file] [--read-only|--yes]

Global options:
  --stdin-json  Read JSON from stdin until EOF. Use a finite producer or close stdin explicitly.
```

### `auth token`

Fetch an OpenAPI access token from an OpenAPI key and secret.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--key` | Yes unless provided by env/`--stdin-json` | OpenAPI key. |
| `--secret` | Yes unless provided by env/`--stdin-json` | OpenAPI secret. |
| `--refresh-token` | No | Refresh token. If provided, the wrapper uses refresh-token grant mode. |

Environment alternatives:

- `YOUXIN_OPENAPI_KEY`
- `YOUXIN_OPENAPI_SECRET`
- `YOUXIN_REFRESH_TOKEN`

Stdin alternatives with `--stdin-json`:

- `credentials.key`, `key`, or `openapiKey`
- `credentials.secret`, `secret`, or `openapiSecret`
- `credentials.refreshToken` or `refreshToken`

Output:

JSON object:

```json
{
  "accessToken": "ACCESS_TOKEN",
  "expiresIn": 7200,
  "refreshToken": "REFRESH_TOKEN"
}
```

This command prints secrets. Redirect or store output carefully.

Example with env vars:

```bash
export YOUXIN_OPENAPI_KEY='YOUR_OPENAPI_KEY'
export YOUXIN_OPENAPI_SECRET='YOUR_OPENAPI_SECRET'

youxin-cli auth token
```

Example with stdin JSON:

```bash
printf '%s\n' '{
  "credentials": {
    "key": "YOUR_OPENAPI_KEY",
    "secret": "YOUR_OPENAPI_SECRET"
  }
}' | youxin-cli --stdin-json auth token
```

### `auth resolve-token`

Resolve a Youxin login-state token into user and tenant information.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--login-token` | Yes unless provided by `--stdin-json` | Youxin platform login-state token. |

Stdin alternative with `--stdin-json`:

- `loginToken`

Output:

JSON object:

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

Example with stdin JSON:

```bash
printf '%s\n' '{"loginToken":"YOUXIN_LOGIN_TOKEN"}' |
  youxin-cli --stdin-json auth resolve-token
```

### `object fields`

Fetch object field metadata for a `formCode`.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--form-code` | Yes | Target object/form code, such as `Account__s`. |
| `--format` | No | Output format: `json`, `table`, or `csv`. Defaults to `json`. |
| `--useful` | No | Filter out noisy fields such as empty names, known system fields, underscore-prefixed fields, reverse relation fields, and common audit fields. |
| Credentials | Yes | Access token or OpenAPI key/secret. |
| Context | Yes | `appId` and `userId`. |

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
export YOUXIN_OPENAPI_KEY='YOUR_OPENAPI_KEY'
export YOUXIN_OPENAPI_SECRET='YOUR_OPENAPI_SECRET'
export YOUXIN_APP_ID='YOUR_APP_ID'
export YOUXIN_USER_ID='YOUR_USER_ID'

youxin-cli object fields --form-code Account__s
youxin-cli object fields --form-code Account__s --format table
youxin-cli object fields --form-code Account__s --format csv --useful
```

Example with stdin credentials and context:

```bash
printf '%s\n' '{
  "credentials": {
    "key": "YOUR_OPENAPI_KEY",
    "secret": "YOUR_OPENAPI_SECRET"
  },
  "context": {
    "appId": "YOUR_APP_ID",
    "userId": "YOUR_USER_ID"
  }
}' | youxin-cli --stdin-json object fields --form-code Account__s --format table --useful
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

Body fields supported by the underlying wrapper include:

| Body field | Description |
| --- | --- |
| `page` | Page number. Defaults to `1` in the wrapper. |
| `num` | Page size. Defaults to `10` in the wrapper. |
| `recordIds` | Numeric record IDs to fetch. |
| `externalFields` | Fields to return. Supports dot-path drilldown where the API supports it. |
| `fieldSorts` | Sort descriptors, for example `{ "fieldKey": "CreatedAt", "sortBy": "desc" }`. |
| `queryCriteria` | Exact-match criteria object keyed by field ID. |
| `search` | OR filter array. |
| `filter` | AND filter array. |

Filter conditions supported by the wrapper type:

```text
equal, unEqual, greater, smaller, greaterEqual, smallerEqual, in, notIn,
contains, notContains, like, isNull, isNotNull, begin_with, end_with
```

Output:

JSON object:

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

Examples:

```bash
youxin-cli object query \
  --form-code Account__s \
  --body '{"page":1,"num":1,"externalFields":["Name"]}'
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

```bash
printf '%s\n' '{
  "body": {
    "page": 1,
    "num": 10,
    "filter": [
      {
        "key": "Name",
        "condition": "like",
        "value": "Acme"
      }
    ]
  }
}' | youxin-cli --stdin-json object query --form-code Account__s
```

### `object upsert`

Insert or update object records.

This is a mutating command and requires `--yes`.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--form-code` | Yes | Target object/form code. This value overwrites any `formCode` in the body. |
| `--body` | No | Inline JSON upsert body. |
| `--body-file` | No | Path to a JSON upsert body file. |
| stdin JSON with `--stdin-json` | No | Upsert body or envelope. |
| `--yes` | Yes | Required mutation confirmation. |
| Credentials | Yes | Access token or OpenAPI key/secret. |
| Context | Yes | `appId` and `userId`. |

Body fields:

| Body field | Required | Description |
| --- | --- | --- |
| `fieldDatas` | Yes for useful mutation | Array of field-data objects to insert/update. If omitted, v1 sends an empty array. |
| `autoNumberSettable` | No | Whether to manually set auto-number fields. |
| `bizRuleCloseable` | No | Whether to bypass business-rule checks. |
| `processCloseable` | No | Whether to bypass trigger/process execution. |
| `clearExistedSubRecord` | No | Whether to clear existing child records when updating with child data. |
| `subFormCodes` | No | Child form codes to clear when `clearExistedSubRecord` is true. |

Output:

JSON object:

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

Examples:

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

Example dry-run refusal:

```bash
youxin-cli object upsert --form-code Account__s --body-file /tmp/upsert.json
```

Output:

```text
Refusing to run mutating command without --yes.
Dry run: object upsert formCode=Account__s
```

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

JSON object:

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

Example dry-run refusal:

```bash
youxin-cli object delete --form-code Account__s --record-ids 123,456
```

Output:

```text
Refusing to run mutating command without --yes.
Dry run: object delete formCode=Account__s recordIds=123,456
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

JSON object:

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

Advanced raw OpenAPI caller.

Use this when a wrapper is not yet exposed as a first-class CLI command. Prefer first-class commands when available.

Inputs:

| Argument | Required | Description |
| --- | --- | --- |
| `--method` | Yes | HTTP method, such as `POST`, `GET`, or `DELETE`. The CLI uppercases the value. |
| `--path` | Yes | OpenAPI path, such as `/openapi/object/record/page`. |
| `--body` | No | Inline JSON body. |
| `--body-file` | No | Path to JSON body file. |
| stdin JSON with `--stdin-json` | No | Body or envelope. |
| `--read-only` | Required for non-`GET`/`HEAD` calls when intentionally read-only | Allows a non-`GET`/`HEAD` request without `--yes`. Useful because many Youxin read APIs use `POST`. |
| `--yes` | Required for mutations | Required for non-`GET`/`HEAD` requests unless `--read-only` is present. |
| Credentials | Yes | Access token or OpenAPI key/secret. |
| Context | Yes | `appId` and `userId`; `accountId` is passed through when supplied. |

Output:

Raw normalized OpenAPI response from `OpenapiInvokeWithToken`:

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

Dry-run refusal for non-`GET`/`HEAD` without `--read-only` or `--yes`:

```bash
youxin-cli invoke \
  --method POST \
  --path /openapi/object/record/page
```

Output:

```text
Refusing to run mutating command without --yes.
Dry run: invoke method=POST path=/openapi/object/record/page
```

## Error Behavior

On success, the CLI writes command output to stdout and exits with code `0`.

On error, the CLI writes a concise error to stderr and exits non-zero:

- Exit code `2` is used for CLI usage errors and safety refusals.
- Exit code `1` is used for unexpected failures.

The error formatter redacts obvious secret-like text in error messages, including JSON fields named `key`, `secret`, `token`, `authorization`, and `refreshToken`, plus bearer tokens.

## Practical Patterns

### Use Env Vars For Repeated Manual Work

```bash
export YOUXIN_OPENAPI_KEY='YOUR_OPENAPI_KEY'
export YOUXIN_OPENAPI_SECRET='YOUR_OPENAPI_SECRET'
export YOUXIN_APP_ID='YOUR_APP_ID'
export YOUXIN_USER_ID='YOUR_USER_ID'

youxin-cli object fields --form-code Account__s --format table --useful
```

### Use Stdin JSON For Agent Workflows

```bash
printf '%s\n' '{
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
    "num": 1
  }
}' | youxin-cli --stdin-json object query --form-code Account__s
```

### Reuse A Token Explicitly

```bash
youxin-cli auth token > /tmp/youxin-token.json

export YOUXIN_ACCESS_TOKEN="$(jq -r '.accessToken' /tmp/youxin-token.json)"
export YOUXIN_APP_ID='YOUR_APP_ID'
export YOUXIN_USER_ID='YOUR_USER_ID'

youxin-cli object fields --form-code Account__s --format json
```

The CLI does not refresh tokens during normal business commands in v1. Fetch a new token with `auth token` when the old one expires.
