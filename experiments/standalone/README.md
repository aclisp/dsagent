# Standalone CLI feasibility experiment

See [ADR-0003](../../docs/decisions/0003-standalone-cli.md) for product scope. This is an offline technical probe, **not a releasable standalone builder**.

The macOS arm64 production runtime build has moved to [standalone/](../../standalone/README.md). This directory preserves the initial experiment record.

## Running the experiment

Prerequisites: repository dependencies are installed and the current `dist` has been built; Bun and Node are installed on the experiment's build machine. The macOS TUI probe uses system Python 3 to create a PTY. These are dependencies of the validation tools, not of the executable under test.

```sh
bun experiments/standalone/build.mjs
# Pass the temporary directory printed by the preceding command:
node experiments/standalone/verify.mjs /absolute/path/to/build-output
```

`build.mjs` adapts the generated JS through build plugins only. It does not modify source files, dist, node_modules, or user configuration. Output goes to a new temporary directory containing `dscode`, a separate resource probe named `probe`, and `build.json`. Each executable is independent; `probe` is not a runtime dependency of dscode and is used only for resource testing and as a mock external MCP server.

`verify.mjs` copies both programs to another temporary directory, uses isolated HOME/DSCODE_HOME directories, and restricts PATH to `/usr/bin:/bin`. On macOS, Seatbelt denies reads from the repository and build output directories and restricts writes to the test directory, `/dev/null`, and `/dev/tty`. The model service is mocked on loopback only; tests neither read real credentials nor call paid models. Linux does not enforce this Seatbelt isolation, so its results must not be described as providing equivalent isolation.

Results are written to `verification.json` in the build directory, and temporary directories are retained for inspection. Build adaptations use string matching and fail when the expected source changes. This is a quick validation technique, not the recommended final maintenance approach.

## Verified results (2026-09-25)

Environment: macOS arm64; Bun 1.3.14; Node 22.23.2 running the test service; pi 0.87.1; current DSCode dist version 1.1.6.

An unadapted `bun build --compile dist/cli.js` compiled successfully, but `--version` failed while reading `/$bunfs/package.json`. After adapting version metadata, theme paths, Photon WASM paths, the file credential policy, and the self-relaunch entry point, the following 12 checks passed:

| Check | Actual coverage |
| --- | --- |
| Version | The standalone executable prints the correct version |
| Embedded resource probe | A real worker loads embedded Photon WASM and resizes a 2×2 PNG to 1×1; reads an embedded theme; launches a child process from the same executable |
| Text mode, Skills, built-in tools, and exclusion of user extensions | A local mock Responses stream returns final text; the model request includes the local skill description and built-in tools; the explicit extension test file is not executed |
| JSONL | Every output line parses as JSON, including agent_end |
| TUI initialization | Completes InteractiveMode.init in a real PTY and exits normally through the upstream startup benchmark; this is not acceptance of a full interactive conversation |
| RPC | Returns the correct get_state response and exits normally after stdin EOF |
| Command tool | The mock model invokes real exec_command to run pwd and receives the result |
| Subagent | The mock model invokes real delegate; an explorer relaunches the same executable, completes a JSON-mode request, and returns success; implementer worktrees and all roles are not covered |
| stdio MCP | Discovers and calls a separate mock MCP program; verifies that its environment has no DEEPSEEK_API_KEY |
| HTTP MCP | Streamable HTTP discovery and an actual tool call |
| Error exit | A simulated provider 401 produces a nonzero exit and diagnostics |
| Configuration protection | Even with an existing config selecting keyring, the experiment uses the file policy without rewriting that config |

The final rerun produced a dscode artifact of 78,240,866 bytes (approximately 74.6 MiB), without completed dependency removal or size optimization. The resource probe's size is not counted as part of the product. The image worker's bundled path in the full CLI had not yet been validated; the separate probe explicitly disallows a main-thread fallback from being reported as worker success.

Inspection of the runtime directory found only state files such as settings.json and models-store.json in addition to test fixtures and copied executables. No extracted JS, WASM, dynamic libraries, or tool executables were found. This is evidence for the exercised paths, not proof that every feature path avoids auxiliary file writes.

## Follow-up validation and implementation boundaries

- Sharing one runtime across the three modes has been verified; retaining them requires no new native dependencies.
- Embedded Photon WASM and workers have runtime evidence, so image preprocessing need not be dropped to achieve a single executable.
- The experiment blocks only supplied extension paths and automatic discovery. Package resolution, package management commands, and dynamic loaders have not been fully removed, so it does not guarantee that extensions are disabled in a release build.
- pi's `ensureTool` automatically downloads missing rg/fd. The agreed production behavior retains this as an exception for external tool management, rather than treating it as extraction of the application's own dependencies. This experiment sets PI_OFFLINE and does not verify the download path; it requires separate validation. Do not enable global offline mode merely to prevent downloads.
- Embedded HTML export assets, all image entry points, real TUI conversations, cancellation, background processes, patch/checkpoint/undo, session resume, MCP approvals, and all subagent roles still require acceptance checks.
- OAuth/Bun-specific provider initialization, ordinary proxies, and custom CAs are untested; this round uses only a local mock DeepSeek Responses service.
- Marking keyring and other modules as external is an experimental convenience, not final dependency removal. Release builds must remove unreachable imports along with SQLite, the vision CLI, Windows paths, and similar dependencies, and prevent accidental fallback to host dependencies.
- Linux x86_64 builds and execution using Bun's x64 baseline target, minimum glibc/macOS versions, signing, and the download/upgrade workflow remain unverified. Successful cross-compilation cannot replace execution on the target platform. Linux arm64 is outside the initial release scope.
- The production design should converge on an explicit standalone entry point, asset resolution layer, and platform capability switches, avoiding long-term maintenance of numerous upstream source string replacements.

The core approach is feasible on macOS arm64. This artifact is experimental only and should not be released or used with real credentials or working directories.
