import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { piAdapter, PI_VERSION } from "./pi-adapter.mjs";
import { prepareTools, toolVersions } from "./tools-build.mjs";
import { webAssetPaths } from "../scripts/web-assets.mjs";
import { targets, hostPlatform, binaryName } from "./platforms.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = hostPlatform();
if (!Object.hasOwn(targets, host)) {
  throw new Error(`Unsupported standalone build host ${host}; supported: ${Object.keys(targets).join(", ")}.`);
}
if (Bun.version !== "1.3.14") throw new Error("Use Bun 1.3.14; upgrade together with standalone validation.");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--target" || !Object.hasOwn(targets, args[1]))) {
  throw new Error(`Usage: bun standalone/build.mjs [--target ${Object.keys(targets).join("|")}]`);
}
// This Mac can cross-build all targets. Other hosts keep their native default
// because producing our signed macOS artifact requires macOS codesign.
const platforms = args.length ? [args[1]] : host === "darwin-arm64" ? Object.keys(targets) : [host];
if (platforms.includes("darwin-arm64") && process.platform !== "darwin") {
  throw new Error("Build the macOS target on macOS to apply its required ad-hoc signature.");
}
const pi = fs.realpathSync(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const tui = fs.realpathSync(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"))));
const piPackage = path.join(pi, "../package.json");
if (JSON.parse(fs.readFileSync(piPackage)).version !== PI_VERSION) throw new Error(`Review adapters for pi upgrade; expected ${PI_VERSION}`);
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
const photon = createRequire(path.join(pi, "index.js")).resolve("@silvia-odwyer/photon-node");

for (const platform of platforms) await buildPlatform(platform);

async function buildPlatform(platform) {
  const target = targets[platform];
  const name = binaryName("dscode", platform);
  const out = path.join(root, "dist/standalone", platform);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dscode-standalone-build-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(work);
    // Bun 1.3 resolves relative worker entries by mapping source extensions to
    // embedded .js modules. A .js specifier skips that mapping and hits disk.
    const worker = path.join(work, "image-worker.ts");
    fs.writeFileSync(worker, `import ${JSON.stringify(path.join(pi, "utils/image-resize-worker.js"))};\n`);
    const codemodeWorker = path.join(work, "codemode-worker.ts");
    fs.writeFileSync(codemodeWorker, `import ${JSON.stringify(path.join(pi, "extensions/codemode/worker.js"))};\n`);
    // Give the embedded entrypoints the same virtual root. Otherwise Bun's
    // worker URL inherits the checkout's path while the worker lives under /tmp.
    const entry = path.join(work, "cli.mjs");
    fs.writeFileSync(entry, `import ${JSON.stringify(path.join(root, "standalone/cli.mjs"))};\n`);
    const assets = { "package.json": piPackage, ...await prepareTools(platform, work) };
    for (const [name, file] of Object.entries(webAssetPaths(root))) {
      // Bun must not see the same Marked module as both executable JS (TUI) and
      // a file asset (browser). Give the embedded browser copy its own path.
      if (name === "marked.esm.js") {
        const browserMarked = path.join(work, "web-marked.js");
        fs.copyFileSync(file, browserMarked);
        assets[`web/${name}`] = browserMarked;
      } else assets[`web/${name}`] = file;
    }
    assets["quickjs.wasm"] = createRequire(path.join(pi, "index.js")).resolve("quickjs-wasi/quickjs.wasm");
    for (const name of ["light.json", "dark.json"]) assets[name] = path.join(pi, "modes/interactive/theme", name);
    for (const name of ["dscode-light.json", "dscode-dark.json"]) assets[name] = path.join(root, "packages/core/themes", name);
    for (const name of ["template.html", "template.css", "template.js"]) assets[name] = path.join(pi, "core/export-html", name);
    for (const name of ["marked.min.js", "marked-cjk-friendly.min.js", "highlight.min.js"]) assets[name] = path.join(pi, "core/export-html/vendor", name);
    for (const name of fs.readdirSync(path.join(pi, "modes/interactive/assets"))) assets[name] = path.join(pi, "modes/interactive/assets", name);
    const audit = { inputs: new Set(), excluded: new Set(), adapted: new Set() };
    const result = await Bun.build({
      entrypoints: [entry, worker, codemodeWorker],
      compile: { outfile: path.join(work, name), target, autoloadBunfig: false, autoloadDotenv: false, autoloadTsconfig: false, autoloadPackageJson: false },
      target: "bun", minify: { syntax: true, whitespace: true, identifiers: false },
      naming: { asset: "[name].[ext]" },
      define: { DSCODE_STANDALONE: "true", DSCODE_BUILD_VERSION: JSON.stringify(version) },
      plugins: [piAdapter({ root, pi, tui, photon, assets, worker, codemodeWorker, audit, platform, toolVersions })],
    });
    if (!result.success) throw new AggregateError(result.logs, "Standalone build failed");
    const executable = path.join(work, name);
    if (platform === "darwin-arm64") {
      const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", executable], { encoding: "utf8" });
      if (signed.status !== 0) throw new Error(signed.stderr || "Ad-hoc signing failed");
    }
    const bytes = fs.readFileSync(executable);
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(executable, path.join(out, `${name}.tmp`));
    if (!platform.startsWith("windows-")) fs.chmodSync(path.join(out, `${name}.tmp`), 0o755);
    fs.renameSync(path.join(out, `${name}.tmp`), path.join(out, name));
    // A previous acceptance report does not validate this newly built artifact.
    fs.rmSync(path.join(out, "verification.json"), { force: true });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(path.join(out, `${name}.sha256`), `${sha256}  ${name}\n`);
    fs.writeFileSync(path.join(out, "build.json"), JSON.stringify({ version, pi: PI_VERSION, bun: Bun.version,
      platform, target, host, bytes: bytes.length, sha256, tools: toolVersions,
      nativeModules: [...audit.inputs].filter(file => file.endsWith(".node")).map(file => path.relative(path.join(tui, ".."), file).replaceAll("\\", "/")).sort(),
      inputs: audit.inputs.size, excluded: [...audit.excluded].sort(), adapted: [...audit.adapted].sort(),
    }, null, 2) + "\n");
    console.log(`Built ${path.join(out, name)} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(work, { recursive: true, force: true });
  }
}
