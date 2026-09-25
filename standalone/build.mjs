import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { piAdapter, PI_VERSION } from "./pi-adapter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Linux uses the x64 baseline target per ADR-0003; the build host needs AVX2
// only for its own Bun, not for the produced executable.
const targets = { "darwin-arm64": "bun-darwin-arm64", "linux-x64": "bun-linux-x64-baseline" };
const platform = `${process.platform}-${process.arch}`;
const target = targets[platform];
if (!target) {
  throw new Error(`Unsupported standalone platform ${platform}; supported: ${Object.keys(targets).join(", ")}.`);
}
if (Bun.version !== "1.3.14") throw new Error("Use Bun 1.3.14; upgrade together with standalone validation.");
if (process.argv.length > 2) throw new Error("Usage: bun standalone/build.mjs");
const pi = fs.realpathSync(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const tui = fs.realpathSync(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"))));
const piPackage = path.join(pi, "../package.json");
if (JSON.parse(fs.readFileSync(piPackage)).version !== PI_VERSION) throw new Error(`Review adapters for pi upgrade; expected ${PI_VERSION}`);
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
const photon = createRequire(path.join(pi, "index.js")).resolve("@silvia-odwyer/photon-node");
const out = path.join(root, "dist/standalone", platform);
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
    compile: { outfile: path.join(work, "dscode"), target, autoloadBunfig: false, autoloadDotenv: false, autoloadTsconfig: false, autoloadPackageJson: false },
    target: "bun", minify: { syntax: true, whitespace: true, identifiers: false },
    naming: { asset: "[name].[ext]" },
    define: { DSCODE_STANDALONE: "true", DSCODE_BUILD_VERSION: JSON.stringify(version) },
    plugins: [piAdapter({ root, pi, tui, photon, assets, worker, audit })],
  });
  if (!result.success) throw new AggregateError(result.logs, "Standalone build failed");
  const executable = path.join(work, "dscode");
  if (process.platform === "darwin") {
    const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", executable], { encoding: "utf8" });
    if (signed.status !== 0) throw new Error(signed.stderr || "Ad-hoc signing failed");
  }
  const bytes = fs.readFileSync(executable);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(executable, path.join(out, "dscode.tmp"));
  fs.chmodSync(path.join(out, "dscode.tmp"), 0o755);
  fs.renameSync(path.join(out, "dscode.tmp"), path.join(out, "dscode"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(path.join(out, "dscode.sha256"), `${sha256}  dscode\n`);
  fs.writeFileSync(path.join(out, "build.json"), JSON.stringify({ version, pi: PI_VERSION, bun: Bun.version,
    platform, target, bytes: bytes.length, sha256,
    inputs: audit.inputs.size, excluded: [...audit.excluded].sort(), adapted: [...audit.adapted].sort(),
  }, null, 2) + "\n");
  console.log(`Built ${path.join(out, "dscode")} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`);
} finally {
  process.chdir(previousCwd);
  fs.rmSync(work, { recursive: true, force: true });
}
