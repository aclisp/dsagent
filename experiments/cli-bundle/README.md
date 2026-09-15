# Optional deep CLI bundle

This experiment measures time until DSCode is ready for work. It leaves existing
source files, package scripts, normal build artifacts, and dependencies unchanged.
The harness reuses the production builder. Generated artifacts go into a
fresh `dist/cli-bundle-*` directory on every build.

## Run

From the repository root, using the existing installed dependencies:

```sh
node experiments/cli-bundle/build.mjs
```

The last output line is the experiment directory. Substitute it for `<output>`:

```sh
node <output>/deep/cli.js
node experiments/cli-bundle/smoke.mjs <output>
python3 experiments/cli-bundle/benchmark.py <output> --runs 20 --warmup 3
```

Launching `deep/cli.js` normally uses your normal DSCode settings and credentials,
just like the existing CLI. The smoke test and benchmark use temporary homes and
fake credentials instead. They do not modify your existing DSCode configuration.
The Python benchmark requires macOS or Linux for its standard-library PTY driver.

Useful shorter benchmark commands:

```sh
python3 experiments/cli-bundle/benchmark.py <output> --mode tui --extensions none
python3 experiments/cli-bundle/benchmark.py <output> --runs 1 --warmup 0
```

No package installation, normal build, pi checkout, or changes to `package.json`
are required. The scripts resolve the pi version actually installed in DSCode.
The build deliberately rejects versions other than pi 0.84.4 until its adapters
have been reviewed against the new version.

## Bundle design

The harness compiles an isolated baseline, then calls the production builder in
`scripts/bundle-cli.mjs`. It adds a benchmark observation entry to both variants;
normal build artifacts are not modified. All production asset/native dependency
adapters are shared with the default CLI. See
[CLI bundling](../../docs/CLI_BUNDLING.md) for the maintained runtime boundary.

The generated CLI uses its sibling baseline for DSCode companion assets and the
existing installed dependencies for pi assets/native modules. Keep the complete
experiment directory. Normal production packages use package-relative paths and
can be relocated; the old checkout-anchored adapter is no longer used.

## What is measured

The primary metric is parent process spawn to completion of
`InteractiveMode.init()` in a 120x32 pseudo-terminal. This includes module loading,
DSCode initialization, model selection, managed-tool checks, extension startup,
and the completed UI render. An identical wrapper in each variant observes the
existing method; it does not skip initialization or defer additional code.

Pi's existing `PI_STARTUP_BENCHMARK=1` mode exits after initialization. Its 150 ms
terminal cleanup delay and process shutdown are **outside** the measured interval.
RPC measurements separately time a successful `get_state` response from the real
CLI entrypoint, without the interactive observation wrapper.

For each scenario the benchmark runs three warmup pairs and twenty measured
pairs, alternating baseline/deep order. Every run uses a fresh Node process,
temporary home and workspace, file credential storage, an environment API-key
placeholder, no persisted session, and offline pi mode. Existing `PATH` is used
for managed tools. OS filesystem caches are not flushed. This represents fresh
process startup with warm filesystem caches, not a cold machine boot.

The default scenarios cover TUI and RPC, each with and without one explicitly
loaded TypeScript extension. DSCode's built-in extensions remain enabled in all
scenarios. The extra extension checks that it sees the credential-store and UI
branding patches on the same pi classes, imports TypeBox/TUI, registers a command,
and completes `session_start`. Its transform cache is isolated per run.

The benchmark does not measure model response latency, a real credential store,
large saved-session histories, actual user extension collections, or remote MCP
initialization. Normal CLI runtime behavior is unchanged; offline settings apply
only to the measurements. Raw samples, medians, and nearest-rank p95 values are
written to a new timestamped JSON file in the output directory.

## Validation

`smoke.mjs` compares both variants against a local HTTP model fixture and local
stdio MCP fixture. It verifies streaming output, the DSCode tool list, MCP tool
discovery, provider error exit status, the vision launcher, imports of emitted
lazy OAuth/Bedrock modules, and Photon/WASM image-worker resizing. It makes no remote model or authentication calls.
The benchmark additionally validates interactive initialization, RPC model state,
and extension compatibility on every run.

Windows sandbox execution, real OAuth login, native credential writes, actual tool
execution, and all provider transports need separate validation. The experiment
does not run the full repository test suite or alter production build outputs.
