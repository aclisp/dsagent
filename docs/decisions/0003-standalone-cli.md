# ADR-0003: Standalone CLI scope and technical validation

Status: Product scope confirmed. The macOS arm64 production runtime build is implemented and has passed offline acceptance checks. Linux and the release workflow remain to be validated.

## Goal

Provide a single `dscode` executable with an embedded runtime, so users do not need to install Node.js, Bun, or pnpm, clone the repository, or build locally. Evaluate Bun standalone first; keep the existing Node distribution unchanged.

Avoid extracting application dependencies such as JS, WASM, and dynamic libraries at runtime wherever possible. Sessions, credentials, checkpoints, Git worktrees, and files requested by users may still be written to disk. Retain pi's automatic download of missing rg/fd as an explicit exception for external tool management: these tools may be downloaded to the tool directory and are not part of the executable. Do not silently remove features or relax permissions to meet packaging requirements.

## Confirmed scope

| Area | Decision |
| --- | --- |
| Command and configuration | `dscode`, default `~/.dscode`, existing `DSCODE_*` environment variables |
| Platforms | Linux x86_64 (glibc) and macOS arm64; use Bun's x64 baseline target for Linux; exclude Linux arm64, Windows, Alpine/musl, and Intel Macs |
| Execution modes | TUI, `-p`, `--mode json`, and `--mode rpc`; retain help, version, and authentication management commands |
| Default sandbox | Main process and subagents default to `danger-full-access`; this does not imply `permission=full` or `-y` |
| Approvals | Retain existing permission rules and subagent role permissions; print/JSON modes reject operations requiring approval when no confirmation interface is available; RPC provides approvals through its protocol |
| Credentials | Always use file credentials in the standalone distribution, without a keyring dependency |
| Shared directory | Read existing local Skills and JSONL sessions; do not migrate keyring credentials or rewrite existing configuration to enforce these policies; credentials available only in the keyring require a new login |
| Images | Retain image paths, `@file` input, and image reads through `read`; embed Photon WASM preprocessing and the image worker |
| Clipboard | Exclude the native TUI helper; retain ordinary terminal text paste; direct macOS clipboard screenshot access is not required; Linux may use clipboard commands installed by the user |
| Vision CLI | Exclude `dscode-vision` and its dedicated execution path |
| Subagents | Retain them by launching the same executable; internal noninteractive execution must not depend on adjacent JS files or system Node |
| Skills | Support local user and project Skills; users supply the files and any external commands they require |
| Extensions | Retain the built-in DSCode extension; disable user extensions, including explicit loading entry points |
| pi package management | Exclude package installation, updates, removal, and loading extensions from packages |
| MCP | Retain stdio and Streamable HTTP; users provide services, runtimes, and launch commands |
| Native dependency removal | Exclude keyring, SQLite, Windows helpers, optional native WebSocket accelerators, and Kerberos |
| Proxies | Retain ordinary HTTP/HTTPS proxies; exclude Negotiate authentication that depends on the Kerberos module |
| Static assets | Embed themes and HTML export templates; exclude pi documentation and examples; user-requested HTML exports may be written to disk |
| Installation and upgrades | Direct downloads or a platform-detecting installer; verify downloads before atomic replacement; no automatic update checks or updates |
| External tools | Exclude them from the executable; retain pi's automatic download of missing rg/fd; users supply other tools such as Git, npx, and Python |

## Technical validation criteria

1. Start without Node/Bun, node_modules, or the source directory available. Dependencies installed on the build machine must not create false positives.
2. Verify version, help, TUI initialization, text output, JSONL, and RPC. Keep diagnostic logs out of protocol stdout.
3. Use a local mock model to verify streaming, cancellation, exit codes, commands and patches, background processes, and session resume without calling paid models.
4. Verify image WASM, workers, and image attachments without extracting auxiliary files.
5. Verify the built-in extension and local Skills, and confirm that user extensions and package loading are disabled.
6. Verify stdio/HTTP MCP, approvals, and subagents relaunching the same executable.
7. Confirm that the trimmed dependency graph excludes the modules listed above; document native platform behavior that remains untested.
8. Record artifact size, build environment, reproducible commands, and actual results. A successful build alone does not constitute functional acceptance.

## Validation record

2026-09-25: Completed 12 offline checks on macOS arm64 with Bun 1.3.14, including an embedded WASM worker, TUI initialization, text/JSON/RPC, a real explorer subagent, and stdio/HTTP MCP. The experiment used isolated directories, a restricted PATH, and Seatbelt without reading or writing real credentials or user state.

A dedicated production build entry point in `standalone/` was subsequently implemented, adding dependency removal and acceptance checks for HTML export, TUI conversations, real tool execution, command execution inside a subagent, and RPC approvals. The executable is approximately 71 MiB; the ordinary Node distribution retains its existing behavior. Linux x86_64, real OAuth/providers, release signing and notarization, and the release/installation workflow remain pending.

See [standalone/README.md](../../standalone/README.md) for the production build, repeatable acceptance steps, and limitations. See the [standalone experiment record](../../experiments/standalone/README.md) for the initial investigation.
