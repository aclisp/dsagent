# DSCode CLI deep-bundling experiment — 2026-09-13

Historical measurements from the initial adapter. The harness now uses the
production builder; see `docs/CLI_BUNDLING.md` for the maintained solution.

Deep bundling reduced median interactive readiness from **784 ms to 441 ms**:
**343 ms saved, 43.8% less time, or 1.78x as fast** on this machine.
With an additional TypeScript extension, the reduction was **34.7%**.

These measurements motivated making the deep bundle the default CLI while
retaining the unbundled entry for debugging and comparison. No existing source,
package script, installed dependency, or normal build artifact was modified by
this historical experiment run.

## Results

Each row has 20 measured fresh-process launches per variant after 3 warmup pairs.
Baseline and deep order alternate. DSCode's built-in extensions run in every row.

| Readiness scenario | Baseline median | Deep median | Time reduction | Baseline p95 | Deep p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Interactive UI | 783.8 ms | 440.9 ms | 43.8% | 796.4 ms | 450.5 ms |
| Interactive UI + TypeScript extension | 812.1 ms | 530.0 ms | 34.7% | 820.1 ms | 552.2 ms |
| RPC `get_state` | 635.9 ms | 301.1 ms | 52.6% | 656.8 ms | 310.9 ms |
| RPC + TypeScript extension | 670.2 ms | 391.6 ms | 41.6% | 693.6 ms | 412.1 ms |

The extra extension is transformed from TypeScript in an isolated cache for each
run. It imports pi, TUI, and TypeBox, verifies DSCode's patches are present on pi's
classes, registers a command, and completes its `session_start` handler.

## Environment and method

- Checkout revision: `84c3ea43386670d81e3f4c54993b03b734c12dd4`.
- Apple M1, 16 GiB RAM, macOS arm64. Full platform string is in the raw JSON.
- Node `v22.23.2`; installed pi `0.84.4`; DSCode `1.1.2`.
- Sources compiled once into a separate baseline directory; the deep bundle uses
  those exact compiled inputs and the same installed dependencies.
- TUI timing starts before process spawn and ends when `InteractiveMode.init()`
  resolves, after model/session setup, DSCode extension initialization, terminal
  setup, and final initial render. The observation wrapper is identical in both
  variants. Pi's benchmark cleanup delay is outside the measured interval.
- RPC uses the actual CLI entrypoints and ends at the successful `get_state`
  response. It provides a second measurement without the TUI wrapper.
- Fresh temporary home/workspace, placeholder API key, file credentials, no
  persisted session, offline pi mode, no user configuration or remote MCP servers.
- OS filesystem caches were not flushed. These are warm-filesystem, fresh-process
  results, not cold-boot measurements. No CPU profiler was active.

The experiment does not isolate how much of the gain comes from fewer module
loads, minification, or pi's lazy-jiti bundling adapter. It measures their combined
effect on the requested full-runtime readiness path. No help/version fast path
was introduced or benchmarked.

## Artifact and validation

The deep build folds **2,330 main input modules** into an ESM bundle with shared
and lazy chunks: **50 JavaScript output files, 8,661,598 bytes (8.26 MiB)** including
the separately emitted OAuth, Bedrock, and image-worker implementations.
That size excludes the installed external dependencies and assets.

Completed checks:

- 184 successful startup measurements including warmups, with model/RPC state
  and extension completion checked on every applicable run.
- TypeScript extension imports and shared pi class identity via DSCode's actual
  credential-store and UI-branding patch markers.
- Local Responses API streaming request through both real CLI entrypoints.
- DSCode default tool schemas and discovery of a local stdio MCP tool.
- Nonzero CLI exit on mock provider authentication failure.
- Both vision launchers start.
- Emitted OAuth and Bedrock implementation modules import successfully without
  initiating authentication or remote provider calls.
- Build/smoke script syntax and Git whitespace checks.

These checks do not establish release readiness. Real keyring access, real OAuth,
image resizing, Windows sandbox execution, all model transports, and actual tool
execution remain untested. A user's saved sessions, extension collection, and
remote MCP startup can change the absolute improvement.

The output is attached to this checkout using absolute asset/native-loader
origins. Keep its baseline directory and installed dependencies. It must be
rebuilt after relocation or dependency updates; it is not a portable npm artifact.

## Reproduce or try

See [README.md](README.md) for the optional build and benchmark commands.
The measured artifact from this run is:

```text
dist/cli-bundle-MI8zFi/deep/cli.js
```

The complete paired observations and summaries are in
[measurements.json](measurements.json). Build metadata and the manifest remain in
`dist/cli-bundle-MI8zFi/` alongside the generated baseline and deep variants.
