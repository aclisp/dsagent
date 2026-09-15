#!/usr/bin/env node
// Exercise the emitted CLI against a loopback-only model endpoint and local MCP.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.resolve(process.argv[2] ?? root);
const manifest = process.argv[2] === "--manifest"
  ? JSON.parse(await readFile(path.resolve(process.argv[3], "manifest.json"), "utf8"))
  : { root, baseline: packageRoot, deep: path.join(packageRoot, "dist/bundle") };
const scratch = await mkdtemp(path.join(os.tmpdir(), "dscode-bundle-smoke-"));
let failResponse = false;
let payload;
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  payload = JSON.parse(Buffer.concat(chunks).toString());
  if (failResponse) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "bundle smoke rejected key" } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const item = { id: "msg_bundle", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "bundle smoke ok", annotations: [], logprobs: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp_bundle", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "bundle smoke ok", logprobs: [] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_bundle", status: "completed", output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } } },
  ];
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});

function capture(entry, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${stderr}`)); }, 20000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  for (const variant of ["baseline", "deep"]) {
    const home = path.join(scratch, variant);
    await mkdir(home);
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [path.join(manifest.root, "test/fixtures/mcp-server.mjs")] } } }));
    const extension = path.join(home, "extension.ts");
    await writeFile(extension, `import { ModelRuntime, InteractiveMode } from "@earendil-works/pi-coding-agent";
      import { Type } from "typebox";
      export default function (pi) {
        const label: string = "bundle-probe";
        if (!ModelRuntime[Symbol.for("ai.thinkany.dscode.credential-store-installed")]) throw new Error("Different credential-store class");
        if (!InteractiveMode.prototype[Symbol.for("dscode.runtime-branding")]) throw new Error("Different UI class");
        if (Type.String().type !== "string") throw new Error("TypeBox import failed");
        pi.registerCommand(label, { description: label, handler: async () => {} });
        pi.on("session_start", () => process.stderr.write("EXTENSION_READY\\n"));
      }`);
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home, DSCODE_HOME: home, DSCODE_CREDENTIALS_STORE: "file", DEEPSEEK_API_KEY: "smoke-only-key", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
    const entry = path.join(manifest[variant], variant === "baseline" ? "dist/cli.js" : "cli.js");
    const args = ["--extension", extension, "--base-url", `http://127.0.0.1:${server.address().port}`, "--mode", "json", "--print", "--no-session", "--no-approve", "reply once"];
    failResponse = false;
    const success = await capture(entry, args, env, home);
    assert.equal(success.code, 0, success.stderr);
    assert.ok(success.stdout.includes("bundle smoke ok"), success.stdout);
    assert.ok(success.stderr.includes("EXTENSION_READY"), success.stderr);
    assert.equal(payload.model, "deepseek-flash");
    assert.deepEqual(payload.tools.map(tool => tool.name).sort(), ["read", "exec_command", "write_stdin", "apply_patch", "mcp__fixture__echo"].sort());
    failResponse = true;
    const failure = await capture(entry, args, env, home);
    assert.notEqual(failure.code, 0);
    assert.ok(`${failure.stdout}\n${failure.stderr}`.includes("bundle smoke rejected key"));
    const vision = await capture(path.join(manifest.baseline, "dist/vision-cli.js"), ["--help"], env, home);
    assert.equal(vision.code, 0, vision.stderr);
    assert.ok(vision.stdout.includes("dscode-vision --image"));
    console.log(`${variant}: model streaming, DSCode tools, local MCP discovery, provider failure exit, vision launcher passed`);
  }
  // Pi's variable-specifier OAuth and Bedrock imports must also resolve after
  // relocation. Import definitions only; do not authenticate or call providers.
  for (const name of ["anthropic", "github-copilot", "kimi-coding", "openai-codex", "openrouter", "radius", "xai", "bedrock-converse-stream"]) {
    await import(pathToFileURL(path.join(manifest.deep, `${name}.js`)).href);
  }
  console.log("deep: lazy OAuth and Bedrock module imports passed (no remote requests)");
  const worker = new Worker(path.join(manifest.deep, "image-resize-worker.js"));
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Image worker timed out")), 10000);
      worker.once("error", error => { clearTimeout(timeout); reject(error); });
      worker.once("message", message => { clearTimeout(timeout); resolve(message); });
      // Pi test fixture: 2x2 PNG resized to 1x1 through the relocated Photon/WASM path.
      worker.postMessage({ inputBytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==", "base64"), mimeType: "image/png", options: { maxWidth: 1, maxHeight: 1 } });
    });
    assert.equal(result.result?.width, 1, JSON.stringify(result));
  } finally { await worker.terminate(); }
  console.log("deep: image worker and native Photon/WASM decoding passed");
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
