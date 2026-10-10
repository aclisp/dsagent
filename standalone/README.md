# Standalone dscode

Production build entry point for the macOS arm64 and Linux x86_64 standalone runtimes. The executable includes Bun and requires no Node.js, Bun, or node_modules installation.
See [ADR-0003](../docs/decisions/0003-standalone-cli.md) for product scope. The build script explicitly rejects other platforms; Linux builds use Bun's x64 baseline target so the executable also runs on pre-AVX2 CPUs.

## Build and validate

The build machine needs the project dependencies, pnpm, and Bun **1.3.14**; macOS builds also use the system `codesign`:

```sh
pnpm install --frozen-lockfile
pnpm build:standalone
pnpm check:standalone
```

On macOS arm64, `pnpm build:standalone` builds **both** macOS arm64 and Linux x86_64 binaries. On Linux x86_64, it builds only the native Linux binary; the macOS artifact requires macOS `codesign`.

To build just one target on this Mac:

```sh
pnpm build:standalone --target linux-x64
pnpm build:standalone --target darwin-arm64
```

`pnpm check:standalone` performs the default build above, then runs the acceptance suite **only for the host platform**. Cross-compilation does not validate execution on the target OS. To test the Mac-built Linux artifact, copy its output directory to a Linux host with this repository's test dependencies and run:

```sh
node standalone/test/verify.mjs /absolute/path/to/copied/linux-x64
```

Cross-compilation downloads and caches the target Bun runtime from the npm registry. On networks where `registry.npmjs.org` is unreachable, point `BUN_COMPILE_TARGET_TARBALL_URL` at a mirror of `@oven/bun-<target>` (for example npmmirror) and build the matching target explicitly with `--target`.

The build also embeds pinned `fd` 10.5.0 and `rg` 15.2.0 binaries for the target platform, with their license notices. Downloads occur on the build host and are checked against SHA-256 hashes in `tools-build.mjs`. For offline builds, set `DSCODE_TOOL_ARCHIVES` to an absolute directory containing the original release `.tar.gz` files named in that module; the same checksums apply. Linux tools use the musl builds.

On the first session, missing bundled tools are extracted to `~/.dscode/bin/fd` and `~/.dscode/bin/rg` (or `$DSCODE_HOME/bin`). Pi's completion/search tools and DSCode's child-process PATH use this same directory. No tool download occurs at runtime, including in print/RPC mode. Ordinary startup only checks whether both paths exist: it does not read binary contents or receipts, hash tools, or acquire the installation lock when both are present. Preparation is shared with pi's subsequent tool requests within the process.

To upgrade existing managed tools from a new executable, run:

```sh
dscode --update-bundled-tools
# To target a custom home:
DSCODE_HOME=/path/to/home dscode --update-bundled-tools
```

This standalone-only command accepts no other arguments, reports each tool's result, and exits without starting a session or contacting a model. It installs missing tools and atomically upgrades binaries whose current SHA-256 matches a valid DSCode installation receipt when the embedded version is newer. Unrecognized or modified binaries, directories, and symlinks are preserved; older executables never downgrade tools. License notices and hash-addressed receipts accompany installed binaries. A process lock coordinates extraction and explicit upgrades, with abandoned-lock recovery. Interrupted upgrades can be retried by running the command again.

Run the extraction and upgrade checks with `node --test standalone/test/tools-install.test.mjs`. The compiled acceptance suite verifies that ordinary startup preserves older managed tools and that the explicit command upgrades them offline, and also exercises pi's `find`/`grep` tools and `exec_command` with an isolated home and restricted PATH.

Artifacts are written to `dist/standalone/<platform>/` (`darwin-arm64` or `linux-x64`):

- `dscode`: approximately 78 MiB on macOS arm64, 110 MiB on Linux x86_64; the only file to distribute, relocatable to any directory. Missing bundled tools are extracted into DSCode's home at runtime.
- `dscode.sha256`: SHA-256 checksum file.
- `build.json`: version, build host, target, size, dependency removal, and adapter records.
- `verification.json`: runtime acceptance results, generated only after validation; rebuilding removes the previous report.

```sh
./dist/standalone/linux-x64/dscode --version
./dist/standalone/linux-x64/dscode
```

The existing GitHub release workflow builds and validates each platform on a native runner, then attaches `dscode-v<version>-<platform>.tar.gz` to the release alongside the independent container publication. Each archive contains `dscode` and `dscode.sha256`. Failed standalone jobs can be retried with GitHub Actions' **Re-run failed jobs**; uploading replaces an existing asset with the same name.

The macOS executable currently uses ad-hoc signing; the Linux executable is unsigned. Developer ID signing, notarization, and installer scripts are outside this implementation.
The ordinary Node distribution continues to use `pnpm build`; the npm package excludes the standalone executable.

## Layout and maintenance boundaries

| Path | Responsibility |
| --- | --- |
| `build.mjs` | Platform/version checks, asset collection, compilation of CLI and worker entry points, signing, and checksums |
| `cli.mjs` / `runtime.mjs` | Start DSCode, reject unsupported commands, and register OAuth/Bedrock entry points |
| `pi-adapter.mjs` | Centralize adaptations for the pinned pi version, embed assets and image/codemode workers, and disable user extensions and package resolution |
| `disabled.mjs` / `*-command*.mjs` / `windows-sandbox.mjs` | Build replacements for explicitly excluded features |
| `test/` | Local mock model, stdio/HTTP MCP, PTY, and acceptance checks for the relocated executable |
| `../packages/core/src/distribution.ts` | Compile-time constants controlling distribution-specific Core behavior |

The build does not modify node_modules or maintain a separate copy of Core. Ordinary Node builds leave these constants undefined and retain their existing defaults.
Core differences are limited to version metadata, file credentials, skipping legacy migration, host sandbox defaults, help, and subagents launching the executable itself.
Direct `dscode` commands through `exec_command` relaunch the standalone executable itself with ordinary CLI arguments and independent permissions. Children can edit, run ordinary commands, and use MCP; managed DSCode child depth is limited to one level, matching the original `delegate`. Children cannot launch another DSCode child through `exec_command`. Standalone user-extension limitations still apply. Print children wait for stdin EOF; RPC children use JSONL stdin/stdout. `timeout_ms: 0` disables managed-process deadlines. See [CLI children](../docs/CLI_REFERENCE.md#background-cli-children).
Explicit sandbox selections still follow the existing rules.

The pi adapter is currently pinned to **1.1.0**. The build fails if required source patterns no longer match or if a native `.node` module, Core SQLite, or the vision CLI unexpectedly enters the build graph.
When upgrading pi/Bun, review the adapter points and rerun `pnpm check` and `pnpm check:standalone`.
The `experiments/standalone/` directory preserves historical feasibility records and is not used for production builds.

## Runtime behavior

- Command: `dscode`; default state directory: `~/.dscode`; existing `DSCODE_*` variables are retained.
- Supports TUI, `-p`, JSON, RPC, subagents, local Skills, native Pi codemode/tool-search, stdio/HTTP MCP, image preprocessing, and HTML export.
- In the local macOS TUI, `Ctrl+V` reads clipboard images through pi's embedded native helper and attaches them to the prompt. Linux image paste uses `wl-paste` on Wayland or `xclip` on X11 when installed. An SSH session does not expose the client's clipboard to the remote executable.
- Defaults to `danger-full-access` without implicitly granting `permission=full`; existing approvals remain in effect.
- Forces file credentials without rewriting configuration to override old keyring settings or migrating keyring credentials.
- Disables user pi extensions and pi package management; retains the built-in DSCode extension.
- Replaces Pi's local documentation paths in the system prompt with its version-matched online documentation index and a brief standalone limitation statement.
- Excludes SQLite, keyring, the vision CLI, Linux native clipboard helpers, Kerberos, and native WebSocket accelerators. The macOS native clipboard helper is embedded in the executable.
- Embeds themes, HTML templates, Photon WASM, and the image worker without requiring adjacent auxiliary files; disables Bun's automatic loading of project `.env`, bunfig, tsconfig, and package.json as runtime configuration.
- Normal sessions, credentials, checkpoints, bundled tools, and user output may still be written to disk. Users supply other external tools and MCP services.
- DSCode `exec_command` prepends DSCode's `bin` directory to the child process PATH. Ordinary Node installations retain pi's existing managed-tool lookup and download behavior.
- Does not automatically check for new versions.

## Validation coverage and limitations

Offline acceptance copies **only one executable** to a temporary directory and uses an isolated HOME and a PATH without Node/Bun. On macOS, Seatbelt additionally denies reads from the source/build directories and restricts writes to the temporary directory; Linux runs the same checks without that OS-level isolation.
Tests do not use real credentials or call paid models.

The acceptance runner uses Node.js and installed repository test dependencies. Its stdio MCP server reuses `test/fixtures/mcp-server.mjs`, built with `@modelcontextprotocol/sdk` and bundled into the temporary directory so it can run without reading the checkout. The server is launched with the runner's absolute Node.js executable path; DSCode's PATH still excludes Node/Bun. Python 3 remains a test requirement for the real PTY/TUI probes only.

Coverage includes version output, Bun configuration isolation, a local Skill, extension/package disabling, image input through the WASM worker, JSONL, TUI initialization and model replies under a PTY, RPC/EOF, actual read/exec/apply_patch operations, a managed CLI child relaunching itself and reading a file, session resume and HTML export, stdio/HTTP MCP calls, noninteractive approval rejection, RPC approval, model error exits, and preservation of existing credential configuration.

To verify macOS TUI image paste, first copy an image to the host clipboard, then run `DSCODE_TEST_CLIPBOARD_IMAGE=1 node standalone/test/verify.mjs dist/standalone/darwin-arm64`. This opt-in check sends `Ctrl+V` in a PTY and verifies that the local mock model receives an image. It does not replace the clipboard contents and removes the pasted temporary image afterward.

These checks do not replace real provider/OAuth/enterprise proxy testing, and do not cover every TUI shortcut or tool combination.
Acceptance retains temporary directories for inspection; their paths are printed and recorded in `verification.json`.

## Validation record

2026-09-25 Linux x86_64: built with Bun 1.3.14 targeting `bun-linux-x64-baseline` on glibc 2.34; all 20 offline acceptance checks passed, including both PTY/TUI checks, the embedded WASM image worker, an explorer subagent relaunching the executable, and stdio/HTTP MCP. The executable is 104,560,768 bytes (99.7 MiB) and links only against glibc, libpthread, libdl, and libm. Minimum glibc version and real provider/OAuth paths remain untested.

2026-09-26 macOS arm64: embedded pi's native clipboard helper in the standalone executable. The relocated executable passed the offline acceptance suite and the opt-in PTY image-paste check with a real clipboard image and local mock model. The Linux x86_64 cross-build completed; this change was not rerun on a Linux host.
