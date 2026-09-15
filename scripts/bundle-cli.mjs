import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const piDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const aiDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
const tuiDist = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")));

/** Also used by the isolated startup benchmark, so it measures the production builder. */
export async function buildCliBundle({
  outdir = path.join(root, "dist/bundle"),
  coreDist = path.join(root, "packages/core/dist"),
  entryPoints = { cli: path.join(root, "dist/cli.js") },
} = {}) {
  const externalPackages = new Set(["@napi-rs/keyring", "bufferutil", "utf-8-validate", "supports-color"]);
  // All chunks live beside the entrypoint. Module-relative assets and lazy
  // implementations therefore have one deterministic base after code splitting.
  const origins = new Map([
    [piDist, ["piOrigin", "@earendil-works/pi-coding-agent"]],
    [aiDist, ["aiOrigin", "@earendil-works/pi-ai"]],
    [tuiDist, ["tuiOrigin", "@earendil-works/pi-tui"]],
  ]);
  const options = {
    absWorkingDir: root,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22.19",
    minifySyntax: true,
    minifyWhitespace: true,
    sourcemap: false,
    legalComments: "eof",
    metafile: true,
    tsconfigRaw: { compilerOptions: {} },
    define: { PI_BUNDLED_NODE: "true" },
    external: [...externalPackages],
    banner: { js: 'import { createRequire as __bundleRequire } from "node:module"; const require = __bundleRequire(import.meta.url);' },
    plugins: [{
      name: "dscode-cli-runtime",
      setup(context) {
        context.onResolve({ filter: /^dscode-bundle-origins$/ }, () => ({ path: "origins", namespace: "dscode" }));
        context.onLoad({ filter: /^origins$/, namespace: "dscode" }, () => ({
          contents: `import { createRequire } from "node:module";
            import { pathToFileURL } from "node:url";
            ${[...origins.values()].map(([name, pkg]) => `export const ${name} = import.meta.resolve(${JSON.stringify(pkg)});`).join("\n")}
            export const piRequire = createRequire(piOrigin);
            export function resolvePiDependency(name) { return pathToFileURL(piRequire.resolve(name)).href; }`,
          loader: "js",
        }));
        // Adaptations from pi's build-coding-agent-bundle.mjs: preserve virtual
        // extension modules, defer jiti's transform, and normalize the CJS export.
        context.onResolve({ filter: /^jiti\/static$/ }, () => ({ path: "jiti", namespace: "dscode" }));
        context.onLoad({ filter: /^jiti$/, namespace: "dscode" }, () => ({
          contents: `import { piRequire } from "dscode-bundle-origins";
            let implementation;
            export function createJiti(...args) { implementation ??= piRequire("jiti").createJiti; return implementation(...args); }`,
          loader: "js",
        }));
        context.onResolve({ filter: /^https-proxy-agent$/ }, args => {
          if (args.kind === "dynamic-import") return { path: args.path, namespace: "proxy-export", pluginData: path.dirname(args.importer) };
        });
        context.onLoad({ filter: /.*/, namespace: "proxy-export" }, args => ({
          contents: 'export { HttpsProxyAgent } from "https-proxy-agent";', loader: "js", resolveDir: args.pluginData,
        }));
        context.onLoad({ filter: /\.js$/ }, args => {
          // The worker URL must refer to our emitted worker, not pi's original.
          if (args.path === path.join(piDist, "utils/image-resize.js")) return;
          let contents = readFileSync(args.path, "utf8");
          if (!contents.includes("import.meta.url")) return;
          if (args.path.startsWith(`${coreDist}${path.sep}`)) {
            const relative = path.relative(outdir, args.path).split(path.sep).join("/");
            return { contents: contents.replaceAll("import.meta.url", `new URL(${JSON.stringify(relative)}, import.meta.url).href`), loader: "js" };
          }
          for (const [directory, [origin]] of origins) {
            if (!args.path.startsWith(`${directory}${path.sep}`)) continue;
            const relative = `./${path.relative(directory, args.path).split(path.sep).join("/")}`;
            contents = contents.replaceAll("import.meta.url", `new URL(${JSON.stringify(relative)}, ${origin}).href`);
            let imports = origin;
            if (args.path === path.join(piDist, "utils/photon.js")) {
              // Resolve the native module from its declaring dependency. This
              // works with both pnpm's strict layout and a relocated npm install.
              const specifier = 'import("@silvia-odwyer/photon-node")';
              if (!contents.includes(specifier)) throw new Error("Pi Photon loader changed; review the bundle adapter");
              contents = contents.replace(specifier, 'import(resolvePiDependency("@silvia-odwyer/photon-node"))');
              imports += ", resolvePiDependency";
            }
            return { contents: `import { ${imports} } from "dscode-bundle-origins";\n${contents}`, loader: "js" };
          }
          throw new Error(`Unreviewed module-relative runtime path: ${args.path}`);
        });
      },
    }],
  };
  mkdirSync(outdir, { recursive: true });
  const manifestPath = path.join(outdir, "manifest.json");
  const previousFiles = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8")).files ?? []
    : [];
  const main = await build({ ...options, entryPoints, outdir, splitting: true, chunkNames: "[name]-[hash]" });
  const lazy = await build({
    ...options,
    entryPoints: {
      ...Object.fromEntries(["anthropic", "github-copilot", "kimi-coding", "openai-codex", "openrouter", "radius", "xai"].map(name => [name, path.join(aiDist, `auth/oauth/${name}.js`)])),
      "bedrock-converse-stream": path.join(aiDist, "api/bedrock-converse-stream.js"),
      "image-resize-worker": path.join(piDist, "utils/image-resize-worker.js"),
    },
    outdir,
    splitting: false,
  });
  const outputs = new Set();
  let bytes = 0;
  for (const meta of [main.metafile, lazy.metafile]) {
    for (const input of Object.values(meta.inputs)) {
      for (const item of input.imports) {
        if (item.external && !isBuiltin(item.path) && !externalPackages.has(item.path)) throw new Error(`Unexpected external import: ${item.path}`);
      }
    }
    for (const [file, value] of Object.entries(meta.outputs)) {
      const absolute = path.resolve(root, file);
      outputs.add(path.basename(absolute));
      bytes += value.bytes;
      if (readFileSync(absolute, "utf8").includes(root)) throw new Error(`Bundle contains a checkout path: ${file}`);
    }
  }
  // Remove only stale generated JS chunks, never the retained unbundled CLI.
  for (const file of previousFiles) {
    if (path.basename(file) === file && file.endsWith(".js") && !outputs.has(file)) rmSync(path.join(outdir, file), { force: true });
  }
  for (const name of Object.keys(entryPoints)) chmodSync(path.join(outdir, `${name}.js`), 0o755);
  const summary = { bytes, mainInputs: Object.keys(main.metafile.inputs).length, outputFiles: outputs.size };
  writeFileSync(manifestPath, `${JSON.stringify({ ...summary, files: [...outputs] }, null, 2)}\n`);
  console.log(`Bundled CLI: ${summary.mainInputs} modules, ${(bytes / 1024 / 1024).toFixed(1)} MiB, ${summary.outputFiles} files`);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildCliBundle();
