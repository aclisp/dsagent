// Feasibility experiment only: build-time adapters, not a supported distribution.
// Run with Bun; all generated files go to a fresh temporary directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pi = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const piRequire = createRequire(path.join(pi, "index.js"));
const photon = piRequire.resolve("@silvia-odwyer/photon-node");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "dscode-standalone-probe-"));
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
// Bun 1.3 writes intermediate .bun-build files to cwd even with an absolute outfile.
process.chdir(out);
const quote = JSON.stringify;
const adaptations = new Set();
function replace(source, before, after) {
  if (!source.includes(before)) throw new Error(`Upstream adapter no longer matches: ${before}`);
  return source.replaceAll(before, after);
}
const plugin = {
  name: "standalone-feasibility",
  setup(build) {
    build.onLoad({ filter: /\.js$/ }, ({ path: file }) => {
      let source = fs.readFileSync(file, "utf8");
      const original = source;
      if (file.endsWith("/core/dist/version.js")) source = `export const DSCODE_VERSION = ${quote(version)};`;
      if (file.endsWith("/core/dist/settings.js")) source = replace(source,
        'parseCredentialStoreMode(environmentStore ?? configuredStore ?? "auto")', '"file"');
      if (file.endsWith("/core/dist/runtime-options.js")) source = replace(source,
        'process.env.DSCODE_SANDBOX ?? "workspace-write"', 'process.env.DSCODE_SANDBOX ?? "danger-full-access"');
      if (file.endsWith("/core/dist/subagents.js")) {
        source = replace(source, 'return { command: process.execPath, prefix: [script] };',
          'return { command: process.execPath, prefix: [] };');
        source = replace(source, 'readOnly ? "read-only" : "workspace-write"', '"danger-full-access"');
      }
      if (file.endsWith("/pi-tui/dist/native-platform.js")) source =
        'export function getNativePlatformHelper() {} export function getNativeClipboard() {}';
      if (file === photon) {
        source = replace(source, "const path = require('path').join(__dirname, 'photon_rs_bg.wasm');",
          `const path = require(${quote(path.join(path.dirname(photon), "photon_rs_bg.wasm"))});`);
      }
      if (file === path.join(pi, "config.js")) {
        source = `import lightAsset from ${quote(path.join(pi, "modes/interactive/theme/light.json"))} with { type: "file" };\nimport darkAsset from ${quote(path.join(pi, "modes/interactive/theme/dark.json"))} with { type: "file" };\n` + source;
        source = replace(source, 'return join(getPackageDir(), "theme");', 'return dirname(process.env.COLORFGBG ? lightAsset : darkAsset);');
      }
      if (file === path.join(pi, "core/resource-loader.js")) {
        source = replace(source, 'this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];', 'this.additionalExtensionPaths = [];');
        source = replace(source, 'this.noExtensions = options.noExtensions ?? false;', 'this.noExtensions = true;');
      }
      if (source !== original) {
        adaptations.add(path.relative(root, file));
        return { contents: source, loader: "js" };
      }
    });
  },
};
const worker = path.join(out, "image-worker.js");
fs.writeFileSync(worker, `import ${quote(path.join(pi, "utils/image-resize-worker.js"))};`);
const probe = path.join(out, "probe.js");
fs.writeFileSync(probe, `import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import theme from ${quote(path.join(pi, "modes/interactive/theme/dark.json"))} with { type: "file" };
if (process.argv.includes("--child")) { console.log("CHILD_OK"); process.exit(0); }
if (process.argv.includes("--mcp")) {
  const input = createInterface({input:process.stdin});
  for await (const line of input) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    const result = request.method === "initialize"
      ? {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}
      : request.method === "tools/list"
      ? {tools:[{name:"echo",description:"Offline fixture",inputSchema:{type:"object",properties:{}}}]}
      : request.method === "tools/call"
      ? {content:[{type:"text",text:"MCP_OK:key="+(process.env.DEEPSEEK_API_KEY ?? "unset")}]}
      : {};
    console.log(JSON.stringify({jsonrpc:"2.0",id:request.id,result}));
  }
  process.exit(0);
}
const child = spawnSync(process.execPath, ["--child"], {encoding:"utf8"});
if (child.status !== 0 || !child.stdout.includes("CHILD_OK")) throw new Error("Self spawn failed");
JSON.parse(readFileSync(theme, "utf8"));
const worker = new Worker(new URL("./image-worker.js", import.meta.url));
const timer = setTimeout(() => { console.error("WORKER_TIMEOUT"); process.exit(1); }, 10000);
worker.once("error", error => { throw error; });
worker.once("message", async message => {
  clearTimeout(timer);
  if (message.result?.width !== 1 || message.result?.height !== 1) throw new Error(JSON.stringify(message));
  await worker.terminate();
  console.log(JSON.stringify({worker:true, photon:true, embeddedTheme:true, selfSpawn:true, result:message.result}));
});
worker.postMessage({inputBytes:Buffer.from(process.argv[2], "base64"),mimeType:"image/png",options:{maxWidth:1,maxHeight:1}});
`);
for (const [name, entrypoints] of [
  ["dscode", [path.join(root, "dist/cli.js")]],
  ["probe", [probe, worker]],
]) {
  const result = await Bun.build({
    entrypoints, compile: { outfile: path.join(out, name) }, target: "bun",
    naming: { asset: "[name].[ext]" }, plugins: [plugin],
    external: ["@napi-rs/keyring", "bufferutil", "utf-8-validate", "kerberos"],
  });
  if (!result.success) throw new AggregateError(result.logs, "Build failed");
}
fs.writeFileSync(path.join(out, "build.json"), JSON.stringify({
  bun: Bun.version, platform: process.platform, arch: process.arch, version,
  adaptations: [...adaptations],
  bytes: Object.fromEntries(["dscode", "probe"].map(name => [name, fs.statSync(path.join(out, name)).size])),
}, null, 2));
console.log(out);
