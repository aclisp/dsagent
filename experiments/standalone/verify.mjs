// Offline feasibility checks. Requires a build directory from build.mjs.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const build = await fs.realpath(path.resolve(process.argv[2]));
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dscode-standalone-run-")));
const home = path.join(scratch, "home");
await fs.mkdir(home);
for (const name of ["dscode", "probe"]) {
  await fs.copyFile(path.join(build, name), path.join(scratch, name));
  await fs.chmod(path.join(scratch, name), 0o755);
}
await fs.mkdir(path.join(home, "skills/local-probe"), { recursive: true });
await fs.writeFile(path.join(home, "skills/local-probe/SKILL.md"),
  "---\nname: local-probe\ndescription: STANDALONE_SKILL_SENTINEL\n---\nLocal skill fixture.\n");
const forbidden = path.join(home, "forbidden.js");
await fs.writeFile(forbidden, 'throw new Error("USER_EXTENSION_EXECUTED");');
await fs.writeFile(path.join(home, "config.json"), '{"cli_auth_credentials_store":"keyring"}');
let payload;
let fail = false;
let plannedTool;
let toolIssued = false;
let toolOutputs = [];
const server = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
  payload = JSON.parse(Buffer.concat(chunks));
  if (request.url === "/mcp") {
    if (payload.id === undefined) { response.writeHead(202); response.end(); return; }
    const result = payload.method === "initialize"
      ? {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}}
      : payload.method === "tools/list"
      ? {tools:[{name:"echo",description:"Offline fixture",inputSchema:{type:"object",properties:{}}}]}
      : payload.method === "tools/call" ? {content:[{type:"text",text:"HTTP_MCP_OK"}]} : {};
    response.writeHead(200, {"content-type":"application/json"});
    response.end(JSON.stringify({jsonrpc:"2.0",id:payload.id,result}));
    return;
  }
  toolOutputs.push(...(payload.input ?? []).filter(item => item.type === "function_call_output"));
  if (fail) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "offline rejection" } }));
    return;
  }
  const call = plannedTool && !toolIssued;
  if (call) toolIssued = true;
  const item = call
    ? {id:"fc_probe",call_id:"call_probe",type:"function_call",status:"completed",name:plannedTool.name,arguments:JSON.stringify(plannedTool.args)}
    : { id: "msg_probe", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "standalone ok", annotations: [], logprobs: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp_probe", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "standalone ok", logprobs: [] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_probe", status: "completed", output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } } },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    if (call && event.type === "response.output_text.delta") continue;
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const env = {
  PATH: "/usr/bin:/bin", HOME: home, DSCODE_HOME: home,
  TMPDIR: scratch, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
  DEEPSEEK_API_KEY: "offline-fixture", NO_PROXY: "127.0.0.1,localhost",
};
const results = [];
function run(name, args, rpc = false, tui = false) {
  const exe = path.join(scratch, name);
  // On macOS, deny access to both the checkout and build outputs. PATH has no
  // Node/Bun. Permit only scratch writes: any escaped auxiliary-file write fails.
  const policy = `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(build)}))(deny file-write* (require-not (require-any (subpath ${JSON.stringify(scratch)}) (literal "/dev/null") (literal "/dev/tty"))))`;
  let command = process.platform === "darwin" ? "/usr/bin/sandbox-exec" : exe;
  let argv = process.platform === "darwin" ? ["-p", policy, exe, ...args] : args;
  if (tui) { argv = ["-B", path.join(root, "experiments/standalone/run_pty.py"), command, ...argv]; command = "/usr/bin/python3"; }
  return new Promise(resolve => {
    const child = spawn(command, argv, { env: tui ? {...env, TERM:"xterm-256color", PI_STARTUP_BENCHMARK:"1"} : env, cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20000);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (rpc && stdout.includes('"id":"probe-state"')) child.stdin.end();
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { stderr += error.message; });
    child.once("close", code => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }); });
    if (rpc) child.stdin.write('{"id":"probe-state","type":"get_state"}\n');
    else if (!tui) child.stdin.end();
  });
}
async function check(name, body) {
  try { await body(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
  console.log(JSON.stringify(results.at(-1)));
}
const base = ["--base-url", `http://127.0.0.1:${server.address().port}`, "--no-session"];
try {
  await check("version", async () => {
    const result = await run("dscode", ["--version"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^\d+\.\d+\.\d+\s*$/);
  });
  await check("embedded WASM worker, theme, self-spawn", async () => {
    const fixture = await fs.readFile(path.join(root, "scripts/cli-bundle-smoke.mjs"), "utf8");
    const png = fixture.match(/inputBytes: Buffer.from\("([^"]+)"/)[1];
    const result = await run("probe", [png]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).worker, true);
  });
  await check("print, local skill, built-in tools, excluded extension", async () => {
    const result = await run("dscode", [...base, "--extension", forbidden, "-p", "reply once"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "standalone ok");
    assert.match(JSON.stringify(payload), /STANDALONE_SKILL_SENTINEL/);
    assert.ok(payload.tools.some(tool => tool.name === "exec_command"));
    assert.ok(!result.stderr.includes("USER_EXTENSION_EXECUTED"));
  });
  await check("JSONL", async () => {
    const result = await run("dscode", [...base, "--mode", "json", "-p", "reply once"]);
    assert.equal(result.code, 0, result.stderr);
    const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(events.some(event => event.type === "agent_end"));
  });
  if (process.platform === "darwin") await check("TUI initialization under PTY", async () => {
    const result = await run("dscode", base, false, true);
    assert.equal(result.timedOut, false, result.stdout + result.stderr);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\x1b\[/);
  });
  await check("RPC get_state and EOF", async () => {
    const result = await run("dscode", [...base, "--mode", "rpc"], true);
    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(events.some(event => event.id === "probe-state" && event.success));
  });
  for (const tool of [
    {name:"exec_command",args:{cmd:"pwd"}},
    {name:"delegate",args:{tasks:[{role:"explorer",task:"Reply once with evidence."}]}},
  ]) {
    await check(`real tool execution: ${tool.name}`, async () => {
      plannedTool = tool; toolIssued = false; toolOutputs = [];
      const result = await run("dscode", [...base, "--tools", "read,exec_command,write_stdin,apply_patch,delegate", "--permission", "full", "--mode", "json", "-p", "run tool once"]);
      assert.equal(result.code, 0, result.stderr);
      const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      const finished = events.find(event => event.type === "tool_execution_end" && event.toolName === tool.name);
      assert.ok(finished, result.stdout);
      assert.equal(finished.isError, false, JSON.stringify(finished));
      if (tool.name === "delegate") assert.equal(finished.result.details.results[0].success, true, JSON.stringify(finished));
      else assert.match(JSON.stringify(toolOutputs), /dscode-standalone-run-/);
    });
  }
  for (const transport of ["stdio", "http"]) {
    await check(`MCP ${transport} discovery and call`, async () => {
      await fs.writeFile(path.join(home, "mcp.json"), JSON.stringify({mcpServers:{fixture:transport === "stdio"
        ? {command:path.join(scratch,"probe"),args:["--mcp"]}
        : {url:`http://127.0.0.1:${server.address().port}/mcp`}}}));
      plannedTool = {name:"mcp__fixture__echo",args:{}}; toolIssued = false; toolOutputs = [];
      const result = await run("dscode", [...base, "--permission", "full", "-p", "run MCP once"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(JSON.stringify(toolOutputs), transport === "stdio" ? /MCP_OK:key=unset/ : /HTTP_MCP_OK/);
    });
  }
  plannedTool = undefined;
  await check("provider error exit", async () => {
    fail = true;
    const result = await run("dscode", [...base, "-p", "reply once"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /offline rejection/);
  });
  await check("existing credential config unchanged", async () => {
    assert.equal(await fs.readFile(path.join(home, "config.json"), "utf8"), '{"cli_auth_credentials_store":"keyring"}');
  });
} finally {
  await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(build, "verification.json"), JSON.stringify({ scratch, results }, null, 2));
  console.log(`Artifacts: ${build}; isolated runtime files: ${scratch}`);
}
if (results.some(result => !result.passed)) process.exitCode = 1;
