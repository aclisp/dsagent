#!/usr/bin/env node
// Optional, checkout-local experiment. Does not overwrite normal build output.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCliBundle } from "../../scripts/bundle-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "package.json"));
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piDist = path.dirname(piEntry);
const version = JSON.parse(readFileSync(path.join(piDist, "../package.json"), "utf8")).version;
if (version !== "0.84.4") throw new Error(`This experiment's pi adapters require 0.84.4; found ${version}. Review adapters before updating.`);
mkdirSync(path.join(root, "dist"), { recursive: true });
const output = mkdtempSync(path.join(root, "dist/cli-bundle-"));
const baseline = path.join(output, "baseline");
const deep = path.join(output, "deep");
mkdirSync(path.join(baseline, "dist"), { recursive: true });
mkdirSync(deep);
symlinkSync(path.join(root, "node_modules"), path.join(baseline, "node_modules"), "junction");
cpSync(path.join(root, "package.json"), path.join(baseline, "package.json"));
mkdirSync(path.join(baseline, "packages/core"), { recursive: true });
cpSync(path.join(root, "packages/core/package.json"), path.join(baseline, "packages/core/package.json"));
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(root, "packages/core/tsconfig.json"), "--outDir", path.join(baseline, "packages/core/dist"), "--declaration", "false", "--sourceMap", "false"], { cwd: root, stdio: "inherit" });
// These two launchers are already valid JavaScript. Fail rather than silently
// applying an ad-hoc TypeScript transform if their shape changes.
for (const name of ["cli", "vision-cli"]) {
  const source = readFileSync(path.join(root, `src/${name}.ts`), "utf8");
  writeFileSync(path.join(baseline, `dist/${name}.js`), source);
  execFileSync(process.execPath, ["--check", path.join(baseline, `dist/${name}.js`)]);
}
const native = path.join(root, "packages/core/dist/native");
if (existsSync(native)) cpSync(native, path.join(baseline, "packages/core/dist/native"), { recursive: true });

// Identical observation wrapper for both variants. Includes module loading,
// DSCode initialization, model runtime, extensions, and interactive UI init.
writeFileSync(path.join(baseline, "dist/benchmark.js"), `
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { runDSCodeProcess } from "../packages/core/dist/index.js";
const original = InteractiveMode.prototype.init;
InteractiveMode.prototype.init = async function (...args) {
  const result = await original.apply(this, args);
  process.stderr.write("DSCODE_BENCHMARK_READY\\n");
  return result;
};
void runDSCodeProcess(process.argv.slice(2));
`);

const summary = await buildCliBundle({
  outdir: deep,
  coreDist: path.join(baseline, "packages/core/dist"),
  entryPoints: Object.fromEntries(["cli", "vision-cli", "benchmark"].map(name => [name, path.join(baseline, `dist/${name}.js`)])),
});
const manifest = { root, output, baseline, deep, node: process.version, pi: version, createdAt: new Date().toISOString(), ...summary };
writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(output);
