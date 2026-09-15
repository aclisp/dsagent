# CLI bundling

`pnpm build` creates both CLI variants from the same source:

| Entry | Purpose |
| --- | --- |
| `dist/bundle/cli.js` | Default `dscode` command and `pnpm start`; deep JavaScript bundle |
| `dist/cli.js` | Retained unbundled CLI; `pnpm start:unbundled` |
| `dist/vision-cli.js` | Existing independent vision executable, also used by the server |

Both main CLI variants use the same settings, credentials, sessions, and modes.
`pnpm dev` continues to run source code. The core SDK and its RPC entry remain
unbundled. The web server and vision bundlers retain their existing boundaries.

## Runtime boundary

`scripts/bundle-cli.mjs` bundles DSCode, pi's SDK/TUI/model runtime, and statically
reachable JavaScript dependencies with esbuild. ESM splitting preserves lazy
provider loading and a shared module graph for DSCode's pi class patches. The
bundle targets Node 22.19+, minifies syntax and whitespace, retains identifiers,
and preserves dependency license comments. All chunks sit in `dist/bundle/`.

Like pi's own Node bundler, it enables `PI_BUNDLED_NODE` for extension virtual
modules, defers jiti until an extension is loaded, adapts the dynamic
`https-proxy-agent` export, and emits OAuth, Bedrock, and image-worker modules that
esbuild cannot discover through variable imports or worker URLs.

Runtime package origins are resolved with `import.meta.resolve`, never embedded
checkout paths. This keeps pi's themes, documentation, native terminal helpers,
clipboard, and jiti at their installed locations. Photon/WASM resolves from pi's
own dependency tree, including pnpm's strict layout. Keyring remains an external
direct dependency; optional native accelerators retain their fallback behavior.

DSCode's version metadata, Windows sandbox helpers, vision executable, and core
RPC companion retain their existing package-relative locations. Keep the whole
installed package and its dependencies; copying `cli.js` alone is unsupported.
The bundle works after relocating/installing the package and does not require the
original checkout. Unreviewed module-relative paths and unexpected external
imports fail the build rather than silently producing incomplete artifacts.

The root package ships both variants. Checkout-local `dist/cli-bundle-*`
benchmark outputs are excluded from packing. Dependencies are retained because
the unbundled CLI, SDK, native modules, and runtime assets still need them.

## Validation and upgrades

`pnpm check` includes installed-package validation outside the checkout. It checks
the default bin mapping, both versions, absence of benchmark output, and runs
`scripts/cli-bundle-smoke.mjs` against the installed package. That smoke verifies:

- A local streaming Responses request, default DSCode tools, and local MCP discovery.
- TypeScript extension loading and shared credential/UI class patches.
- Provider failure exit status and the vision launcher.
- Lazy OAuth/Bedrock imports and an actual Photon/WASM image-worker resize.

After a pi upgrade, review its upstream bundler and variable imports, worker
paths, extension loader, and package asset resolution. Run the complete checks.
Real OAuth flows, native credential writes, Windows sandbox execution, and
additional provider transports still require platform/provider-specific testing.
No full TUI or paid-provider validation is implied by the package smoke.

## Startup measurements

The initial experiment reduced interactive readiness from 784 ms to 441 ms on an
Apple M1 with Node 22.23.2, or 44% less time. With an extra TypeScript extension it
reduced readiness from 812 ms to 530 ms. These are isolated-home, warm-filesystem,
offline measurements, not guarantees for all projects or machines.

The repeatable harness now calls the production builder:

```sh
node experiments/cli-bundle/build.mjs
python3 experiments/cli-bundle/benchmark.py <printed-output-directory> --runs 20 --warmup 3
```

It compiles a separate baseline without overwriting either normal CLI, and adds
the same readiness observation wrapper to both variants. The primary metric is
process spawn until `InteractiveMode.init()` completes, excluding pi's benchmark
cleanup delay. RPC readiness is independently measured through `get_state`.
See `experiments/cli-bundle/` for methodology and recorded observations.
