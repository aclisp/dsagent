// The only compatibility layer for pinned pi internals. Never edits node_modules.
import fs from "node:fs";
import path from "node:path";

export const PI_VERSION = "1.0.2";

function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Pi ${PI_VERSION} adapter mismatch: ${before}`);
  return source.replaceAll(before, after);
}

function body(source, signature, replacement) {
  const start = source.indexOf(`${signature} {`);
  if (start < 0) throw new Error(`Missing pi function: ${signature}`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`Missing pi function boundary: ${signature}`);
  return source.slice(0, start) + `${signature} {\n${replacement}\n}` + source.slice(end + 2);
}

export function piAdapter({ root, pi, tui, photon, assets, worker, codemodeWorker, audit, platform, toolVersions }) {
  const standalone = path.join(root, "standalone");
  const macClipboard = platform === "darwin-arm64"
    ? fs.realpathSync(path.join(tui, "../native/darwin/prebuilds/darwin-arm64/darwin-platform.node"))
    : undefined;
  const replacements = new Map([
    [path.join(root, "packages/core/dist/vision-command.js"), "vision-command.mjs"],
    [path.join(root, "packages/core/dist/windows-sandbox.js"), "windows-sandbox.mjs"],
    [path.join(pi, "package-manager-cli.js"), "package-commands.mjs"],
    [path.join(pi, "utils/tools-manager.js"), "tools-manager.mjs"],
  ]);
  return {
    name: "dscode-standalone",
    setup(build) {
      build.onResolve({ filter: /^dscode:tool-versions$/ }, () => ({ path: "tool-versions", namespace: "dscode" }));
      build.onLoad({ filter: /^tool-versions$/, namespace: "dscode" }, () => ({
        loader: "js", contents: `export const versions = ${JSON.stringify(toolVersions)};`,
      }));
      build.onResolve({ filter: /^dscode:assets$/ }, () => ({ path: "assets", namespace: "dscode" }));
      build.onLoad({ filter: /^assets$/, namespace: "dscode" }, () => {
        const entries = Object.entries(assets);
        return { loader: "js", contents:
          entries.map(([, file], i) => `import a${i} from ${JSON.stringify(file)} with { type: "file" };`).join("\n") +
          `\nexport const assets = {${entries.map(([name], i) => `${JSON.stringify(name)}:a${i}`).join(",")}};` };
      });
      build.onResolve({ filter: /^(?:@napi-rs\/keyring|bufferutil|utf-8-validate|kerberos)$/ }, args => {
        audit.excluded.add(args.path);
        return { path: path.join(standalone, "disabled.mjs") };
      });
      build.onResolve({ filter: /^jiti(?:\/static)?$/ }, () => ({ path: "jiti", namespace: "dscode" }));
      build.onLoad({ filter: /^jiti$/, namespace: "dscode" }, () => ({
        loader: "js", contents: 'export function createJiti() { throw new Error("User extensions are disabled"); }',
      }));
      build.onLoad({ filter: /\.(?:js|mjs|node)$/ }, ({ path: file }) => {
        if (file.endsWith(".node")) {
          if (file !== macClipboard) throw new Error(`Unexpected native module: ${file}`);
          audit.inputs.add(file);
          return;
        }
        if (/\/(?:state|vision-cli)\.js$/.test(file) && file.includes("/core/dist/")) {
          throw new Error(`Excluded Core module reached standalone graph: ${file}`);
        }
        audit.inputs.add(file);
        if (file === path.join(root, "packages/core/dist/themes.js")) {
          audit.adapted.add(path.relative(root, file));
          return { loader: "js", contents: 'import { assets } from "dscode:assets"; export function getDSCodeThemePaths() { return [assets["dscode-light.json"], assets["dscode-dark.json"]]; }' };
        }
        if (replacements.has(file)) {
          audit.adapted.add(path.relative(root, file));
          return { contents: `export * from ${JSON.stringify(path.join(standalone, replacements.get(file)))};`, loader: "js" };
        }
        if (file === path.join(tui, "native-platform.js")) {
          audit.adapted.add(path.relative(root, file));
          // Headless CLI children do not need native UI support. Loading on demand
          // also avoids concurrent extraction of the embedded addon by Bun.
          return { contents: macClipboard
            ? `let helper;\nexport function getNativePlatformHelper() { return helper ??= require(${JSON.stringify(macClipboard)}); }\nexport function getNativeClipboard() { return getNativePlatformHelper(); }`
            : "export function getNativePlatformHelper() {} export function getNativeClipboard() {}", loader: "js" };
        }
        if (file === path.join(pi, "extensions/index.js")) return { contents: "export const builtInExtensions = [];", loader: "js" };
        if (file === path.join(pi, "core/extensions/virtual-modules.js")) return { contents: "export const VIRTUAL_MODULES = {};", loader: "js" };
        if (file === path.join(pi, "utils/photon.js")) return {
          // The WASM loader is adapted below; no global fs monkey-patch or disk fallback.
          contents: `import photon from ${JSON.stringify(photon)}; export async function loadPhoton() { return photon; }`, loader: "js",
        };
        let source = fs.readFileSync(file, "utf8");
        const original = source;
        if (file === path.join(root, "packages/core/dist/home.js")) {
          source = `import { installBundledTools } from ${JSON.stringify(path.join(standalone, "tools-manager.mjs"))};\n` + source;
          source = replace(source, "await ensureDSCodeRuntimeDefaults(home);", "await ensureDSCodeRuntimeDefaults(home);\n    await installBundledTools(home);");
        }
        if (file === photon) source = replace(source,
          "const path = require('path').join(__dirname, 'photon_rs_bg.wasm');",
          `const path = require(${JSON.stringify(path.join(path.dirname(photon), "photon_rs_bg.wasm"))});`);
        if (file === path.join(pi, "config.js")) {
          source = 'import { assets } from "dscode:assets";\n' + source;
          source = body(source, "export function getQuickJSWasmPath()", 'return assets["quickjs.wasm"];');
          source = body(source, "export function getCodemodeWorkerSpecifier()", `return new URL(${JSON.stringify(`./${path.basename(codemodeWorker)}`)}, import.meta.url);`);
          source = body(source, "export function getPackageJsonPath()", 'return assets["package.json"];');
          source = body(source, "export function getThemesDir()", 'return dirname(assets["dark.json"]);');
          source = body(source, "export function getBundledInteractiveAssetPath(name)", 'return assets[name];');
        }
        if (file === path.join(pi, "core/export-html/index.js")) {
          source = 'import { assets } from "dscode:assets";\n' + source;
          for (const name of ["template.html", "template.css", "template.js"]) source = replace(source,
            `join(templateDir, "${name}")`, `assets["${name}"]`);
          for (const name of ["marked.min.js", "highlight.min.js"]) source = replace(source,
            `join(templateDir, "vendor", "${name}")`, `assets["${name}"]`);
        }
        if (file === path.join(pi, "utils/image-resize.js")) source = body(source,
          "export async function resizeImage(inputBytes, mimeType, options)",
          `return resizeImageInWorker(new URL(${JSON.stringify(`./${path.basename(worker)}`)}, import.meta.url), inputBytes, mimeType, options);`);
        if (file === path.join(pi, "core/resource-loader.js")) {
          source = replace(source, "this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];", "this.additionalExtensionPaths = [];");
          source = replace(source, "this.noExtensions = options.noExtensions ?? false;", "this.noExtensions = true;");
          // User extensions stay disabled; native built-ins are factory-backed
          // and need no module loader or package installation.
          source = replace(source,
            "? cliEnabledExtensions\n            : this.mergePaths(cliEnabledExtensions, enabledExtensions)",
            '? this.mergePaths(cliEnabledExtensions, enabledExtensions.filter(path => path.startsWith("builtin:")))\n            : this.mergePaths(cliEnabledExtensions, enabledExtensions)');
        }
        if (file === path.join(pi, "core/package-manager.js")) {
          // Retain upstream local skill/prompt/theme discovery and trust semantics.
          source = replace(source, "const packageSources = this.dedupePackages(allPackages);", "const packageSources = [];");
          source = replace(source, "const packageSources = sources\n            .filter((source) => !source.startsWith(BUILTIN_PATH_PREFIX))\n            .map((source) => ({ pkg: source, scope }));", "const packageSources = [];");
        }
        if (file === path.join(pi, "core/extensions/loader.js")) {
          source = body(source, "async function loadExtensionModule(extensionPath, cacheToken)",
            'throw new Error("User extensions are disabled in the standalone CLI");');
          source = replace(source, "async function loadExtensionsInternal(paths, cwd, eventBus, runtime, useCache = false) {",
            "async function loadExtensionsInternal(paths, cwd, eventBus, runtime, useCache = false) {\npaths = [];");
        }
        if (source !== original) {
          audit.adapted.add(path.relative(root, file));
          return { contents: source, loader: "js" };
        }
      });
    },
  };
}
