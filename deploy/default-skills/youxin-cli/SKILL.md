---
name: youxin-cli
description: Use when Codex needs to inspect or operate on Youxin Cloud OpenAPI data through an installed `youxin-cli` command, including object field metadata, useful field lists, record queries, record upserts/deletes, file uploads, access-token checks, login-token resolution, local private Youxin CLI profiles, or advanced raw OpenAPI invocation. Prefer this skill when the user mentions Youxin Cloud objects, formCode, OpenAPI fields, lookup paths, records, or asks to use `youxin-cli`.
---

# Youxin CLI

## Overview

Use the installed `youxin-cli` binary as the execution boundary for Youxin Cloud OpenAPI work. Do not import repo-local helper code, create temporary scripts in a project repo, or depend on a local checkout.

## Golden Rules

1. **Never guess field values or filter values.** Read `references/commands.md#field-value-shapes--filter-value-rules` before building a query or upsert payload.
2. **Single/multi-select fields**: run `object fields` first and use `fieldOptions[].optionId` as the filter/write value — never the option name. Filtering by option name silently matches nothing.
3. **Lookup fields**: query the referenced object first to get the target `recordId`, then filter the lookup field by that numeric `recordId` (or use a dot-path key like `Lookup__c.Name__c`).

## First Checks

1. Check that `youxin-cli` is available:

```bash
command -v youxin-cli
youxin-cli help
```

2. If it is not available, ask the user to install or provide the binary. Do not fall back to repo-local helper imports unless the user explicitly asks for project-local development work.
3. Check for a local private profile at `~/.config/youxin-cli/profiles.json`.
4. If a matching profile exists, use it as the default credential/context source without printing secret values.
5. If no profile exists, suggest creating one to avoid repeated credential/context discovery.
6. Collect any remaining required inputs:
   - Target `formCode` for object commands.
   - Credentials: prefer a private profile, then `YOUXIN_OPENAPI_KEY` and `YOUXIN_OPENAPI_SECRET`, or `YOUXIN_ACCESS_TOKEN`.
   - Request context: prefer a private profile, then `YOUXIN_APP_ID` and `YOUXIN_USER_ID`.

## Secret Handling

- Treat `~/.config/youxin-cli/profiles.json` as sensitive local private state.
- Do not create, edit, or delete the profile file unless the user explicitly asks.
- Prefer environment variables for passing credentials; avoid putting secrets in shell command arguments.
- Do not print access tokens, refresh tokens, OpenAPI keys, or OpenAPI secrets.
- When checking auth, summarize token presence/expiry instead of echoing token values.

## Local Private Profiles

Use profiles to save tokens and avoid rediscovering credentials/context.

Preferred profile path:

```text
~/.config/youxin-cli/profiles.json
```

Expected shape:

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
      "userId": "YOUR_USER_ID"
    }
  }
}
```

When a profile is available, read it, choose the user-requested profile or `defaultProfile`, and pass credentials/context to `youxin-cli` via env vars. Never echo the profile contents.

Resolve a user-mentioned tenant/profile name in this order:

1. Exact profile key, such as `xje`.
2. Exact `displayName`, such as `铁浪显 ERP`.
3. Exact alias in `aliases`, such as `铁浪显`.
4. If multiple profiles match or no match is clear, ask the user to choose.

If no profile exists, tell the user that creating this local private profile will save tokens in future requests. If the user agrees, show the proposed file path and schema and ask for the exact values or permission to derive them from a known local source.

If no profile exists and the user wants source discovery, ask for explicit permission before inspecting tracked source files for credentials or context. Report only candidate profile names or source locations, not secret values.

## Mutating Commands

Treat these as mutating:

- `object upsert`
- `object delete`
- `file upload`
- `invoke` unless it is `GET`, `HEAD`, or the user clearly confirms `--read-only`

Before running a mutating command:

1. Show the exact operation summary: command group, formCode/path, affected record IDs or file path, and payload source.
2. Ask the user for explicit confirmation.
3. Only after confirmation, run the CLI with `--yes`.

Never add `--yes` automatically without user confirmation.

## Common Workflows

### Inspect Object Fields

Use table output for human review:

```bash
youxin-cli object fields --form-code Account__s --format table --useful
```

Use JSON output for follow-up processing and lookup drilldown curation:

```bash
youxin-cli object fields --form-code Account__s --format json --useful
```

For comma-separated field paths, fetch JSON and produce the requested list from the returned `data[].fieldId` values.

`--useful` filters system/audit fields, reverse relations, and empty-named fields out of the listing. It does not affect query results — to keep query output clean, pass an explicit `externalFields` list.

### Curate Lookup Drilldowns

When the user asks for useful fields, display fields, lookup paths, or fields suitable for export/sync:

1. Fetch the root object fields as JSON.
2. Identify lookup fields by `fieldType` such as `查找` and a non-empty `refObjectId`.
3. Fetch referenced object fields with `youxin-cli object fields --form-code <refObjectId> --format json --useful` only when the lookup value itself is not human-meaningful enough.
4. Prefer one-level dot paths that end in display fields such as name, code, title, status, currency name, or user name.
5. Drill down multiple levels only when the first referenced object is another wrapper/lookup and a deeper field is clearly more useful.
6. Stop when the path is readable and task-relevant; do not recursively explore the whole schema.

Examples of good curated paths:

```text
fml__Currency__c.Name__c
fml__PaymentMethod__c.Name__c
Reviewer__c.UserId.Name
```

For detailed lookup rules, read `references/commands.md#lookup-drilldown-curation`.

### Query Records

Common mistakes to avoid:
- Use `externalFields` (not `fields`) for field selection
- Use `num` (not `limit` or `pageSize`) for page size
- Use `page` (not `pageNumber`) for page number
- Filtering a select field by its option name instead of `optionId` — see Golden Rules
- Using `like` without `%` wildcards — use `contains` for substring matching

Before filtering on a field whose value domain you have not seen, check `references/commands.md#field-value-shapes--filter-value-rules` or run a small unfiltered query and inspect one record's `fieldData`.

Minimal working example:

```bash
youxin-cli object query --form-code Account__s --body '{"page":1,"num":10}'
```

Prefer body files or stdin JSON for non-trivial filters:

```bash
youxin-cli object query --form-code Account__s --body-file ./query.json
```

Summarize result counts and selected fields. Avoid dumping large record sets unless the user asks.

### Advanced Raw Calls

Use `invoke` only when no first-class command fits:

```bash
youxin-cli invoke --method POST --path /openapi/object/record/page --body-file ./payload.json --read-only
```

Use `--read-only` only when the request is known to be a read operation.

## Stdin

The CLI never reads stdin unless the global `--stdin-json` flag is present, so ordinary commands never hang on an open pipe. When `--stdin-json` is used, stdin is read until EOF — always provide a finite producer such as `printf`, and keep credentials in profiles or environment variables rather than command text:

```bash
printf '%s\n' '{"body":{"page":1,"num":10}}' | youxin-cli --stdin-json object query --form-code Account__s
```

Commands using flags, profiles, environment variables, or `--body-file` should omit `--stdin-json`.

## Reference

- Read `references/commands.md` for exact arguments, profile schema, payload shapes, output schemas, field value shapes and filter value rules, and lookup drilldown rules.
