import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { piAdapter, PI_VERSION } from "./pi-adapter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("This build currently supports macOS arm64 only; Linux validation is pending.");
}
if (Bun.version !== "1.3.14") throw new Error("Use Bun 1.3.14; upgrade together with standalone validation.");
if (process.argv.length > 2) throw new Error("Usage: bun standalone/build.mjs");
const pi = fs.realpathSync(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const tui = fs.realpathSync(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"))));
const piPackage = path.join(pi, "../package.json");
if (JSON.parse(fs.readFileSync(piPackage)).version !== PI_VERSION) throw new Error(`Review adapters for pi upgrade; expected ${PI_VERSION}`);
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
const photon = createRequire(path.join(pi, "index.js")).resolve("@silvia-odwyer/photon-node");
const out = path.join(root, "dist/standalone/darwin-arm64");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "dscode-standalone-build-"));
const previousCwd = process.cwd();
try {
  process.chdir(work);
  const worker = path.join(work, "image-worker.js");
  fs.writeFileSync(worker, `import ${JSON.stringify(path.join(pi, "utils/image-resize-worker.js"))};\n`);
  // Give the two embedded entrypoints the same virtual root. Otherwise Bun's
  // worker URL inherits the checkout's path while the worker lives under /tmp.
  const entry = path.join(work, "cli.mjs");
  fs.writeFileSync(entry, `import ${JSON.stringify(path.join(root, "standalone/cli.mjs"))};\n`);
  const assets = { "package.json": piPackage };
  for (const name of ["light.json", "dark.json"]) assets[name] = path.join(pi, "modes/interactive/theme", name);
  for (const name of ["template.html", "template.css", "template.js"]) assets[name] = path.join(pi, "core/export-html", name);
  for (const name of ["marked.min.js", "highlight.min.js"]) assets[name] = path.join(pi, "core/export-html/vendor", name);
  for (const name of fs.readdirSync(path.join(pi, "modes/interactive/assets"))) assets[name] = path.join(pi, "modes/interactive/assets", name);
  const audit = { inputs: new Set(), excluded: new Set(), adapted: new Set() };
  const result = await Bun.build({
    entrypoints: [entry, worker],
    compile: { outfile: path.join(work, "dscode"), autoloadBunfig: false, autoloadDotenv: false, autoloadTsconfig: false, autoloadPackageJson: false },
    target: "bun", minify: { syntax: true, whitespace: true, identifiers: false },
    naming: { asset: "[name].[ext]" },
    define: { DSCODE_STANDALONE: "true", DSCODE_BUILD_VERSION: JSON.stringify(version) },
    plugins: [piAdapter({ root, pi, tui, photon, assets, worker, audit })],
  });
  if (!result.success) throw new AggregateError(result.logs, "Standalone build failed");
  const executable = path.join(work, "dscode");
  const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", executable], { encoding: "utf8" });
  if (signed.status !== 0) throw new Error(signed.stderr || "Ad-hoc signing failed");
  const bytes = fs.readFileSync(executable);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(executable, path.join(out, "dscode.tmp"));
  fs.chmodSync(path.join(out, "dscode.tmp"), 0o755);
  fs.renameSync(path.join(out, "dscode.tmp"), path.join(out, "dscode"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(out, "dscode.sha256"), `${sha256}  dscode\n`);
  fs.writeFileSync(path.join(out, "build.json"), JSON.stringify({ version, pi: PI_VERSION, bun: Bun.version,
    platform: "darwin-arm64", bytes: bytes.length, sha256,
    inputs: audit.inputs.size, excluded: [...audit.excluded].sort(), adapted: [...audit.adapted].sort(),
  }, null, 2) + "\n");
  console.log(`Built ${path.join(out, "dscode")} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`);
} finally {
  process.chdir(previousCwd);
  fs.rmSync(work, { recursive: true, force: true });
}
