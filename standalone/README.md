# Standalone dscode

Production build entry point for the macOS arm64 standalone runtime. The executable includes Bun and requires no Node.js, Bun, or node_modules installation.
See [ADR-0003](../docs/decisions/0003-standalone-cli.md) for product scope. Linux x86_64 still requires native validation; the current build script explicitly rejects other platforms.

## Build and validate

The build machine needs the project dependencies, pnpm, Bun **1.3.14**, and macOS `codesign`:

```sh
pnpm install --frozen-lockfile
pnpm build:standalone
pnpm check:standalone
```

Artifacts are written to `dist/standalone/darwin-arm64/`:

- `dscode`: approximately 71 MiB; the only file needed at runtime, relocatable to any directory.
- `dscode.sha256`: SHA-256 checksum file.
- `build.json`: version, size, dependency removal, and adapter records.
- `verification.json`: runtime acceptance results, generated only after validation.

```sh
./dist/standalone/darwin-arm64/dscode --version
./dist/standalone/darwin-arm64/dscode
```

The executable currently uses ad-hoc signing. Developer ID signing, notarization, download publication, and installer scripts are outside this implementation.
The ordinary Node distribution continues to use `pnpm build`; the npm package excludes the standalone executable.

## Layout and maintenance boundaries

| Path | Responsibility |
| --- | --- |
| `build.mjs` | Platform/version checks, asset collection, compilation of both entry points, signing, and checksums |
| `cli.mjs` / `runtime.mjs` | Start DSCode, reject unsupported commands, and register OAuth/Bedrock entry points |
| `pi-adapter.mjs` | Centralize adaptations for the pinned pi version, embed assets and the image worker, and disable user extensions and package resolution |
| `disabled.mjs` / `*-command*.mjs` / `windows-sandbox.mjs` | Build replacements for explicitly excluded features |
| `test/` | Local mock model, stdio/HTTP MCP, PTY, and acceptance checks for the relocated executable |
| `../packages/core/src/distribution.ts` | Compile-time constants controlling distribution-specific Core behavior |

The build does not modify node_modules or maintain a separate copy of Core. Ordinary Node builds leave these constants undefined and retain their existing defaults.
Core differences are limited to version metadata, file credentials, skipping legacy migration, host sandbox defaults, help, and subagents launching the executable itself.
Subagents in plan mode retain tool permission restrictions; their default host sandbox is no longer implicitly changed to an OS read-only sandbox by the plan role.
Explicit sandbox selections still follow the existing rules.

The pi adapter is currently pinned to **0.87.1**. The build fails if required source patterns no longer match or if a native `.node` module, Core SQLite, or the vision CLI unexpectedly enters the build graph.
When upgrading pi/Bun, review the adapter points and rerun `pnpm check` and `pnpm check:standalone`.
The `experiments/standalone/` directory preserves historical feasibility records and is not used for production builds.

## Runtime behavior

- Command: `dscode`; default state directory: `~/.dscode`; existing `DSCODE_*` variables are retained.
- Supports TUI, `-p`, JSON, RPC, subagents, local Skills, stdio/HTTP MCP, image preprocessing, and HTML export.
- Defaults to `danger-full-access` without implicitly granting `permission=full`; existing approvals remain in effect.
- Forces file credentials without rewriting configuration to override old keyring settings or migrating keyring credentials.
- Disables user pi extensions and pi package management; retains the built-in DSCode extension.
- Excludes SQLite, keyring, the vision CLI, native clipboard helpers, Kerberos, and native WebSocket accelerators.
- Embeds themes, HTML templates, Photon WASM, and the image worker without requiring adjacent auxiliary files; disables Bun's automatic loading of project `.env`, bunfig, tsconfig, and package.json as runtime configuration.
- Normal sessions, credentials, checkpoints, and user output may still be written to disk. Retains pi's download of missing rg/fd; users supply other external tools and MCP services.
- Does not automatically check for new versions.

## Validation coverage and limitations

Offline acceptance copies **only one executable** to a temporary directory and uses an isolated HOME and a PATH without Node/Bun. macOS Seatbelt denies reads from the source/build directories and restricts writes to the temporary directory.
Tests do not use real credentials or call paid models.

Coverage includes version output, Bun configuration isolation, a local Skill, extension/package disabling, image input through the WASM worker, JSONL, TUI initialization and model replies under a PTY, RPC/EOF, actual read/exec/apply_patch operations, an explorer subagent launching itself and executing a command, session resume and HTML export, stdio/HTTP MCP calls, noninteractive approval rejection, RPC approval, model error exits, and preservation of existing credential configuration.

These checks do not replace native Linux validation or real provider/OAuth/enterprise proxy testing, and do not cover every TUI shortcut or tool combination.
Acceptance retains temporary directories for inspection; their paths are printed and recorded in `verification.json`.
