// Offline acceptance of the real distributable. No paid provider requests.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const build = await fs.realpath(path.resolve(process.argv[2] ?? path.join(root, "dist/standalone/darwin-arm64")));
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dscode-standalone-run-")));
const home = path.join(scratch, "home");
await fs.mkdir(home);
for (const name of ["dscode"]) {
  await fs.copyFile(path.join(build, name), path.join(scratch, name));
  await fs.chmod(path.join(scratch, name), 0o755);
}
await fs.mkdir(path.join(home, "skills/local-probe"), { recursive: true });
await fs.writeFile(path.join(home, "skills/local-probe/SKILL.md"),
  "---\nname: local-probe\ndescription: STANDALONE_SKILL_SENTINEL\n---\nLocal skill fixture.\n");
const forbidden = path.join(home, "forbidden.js");
await fs.writeFile(forbidden, 'throw new Error("USER_EXTENSION_EXECUTED");');
await fs.writeFile(path.join(home, "config.json"), '{"cli_auth_credentials_store":"keyring"}');
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({extensions:[forbidden],packages:["npm:must-not-install-standalone-fixture"],cacheWarming:"off"}));
await fs.copyFile(path.join(root, "standalone/test/mcp.py"), path.join(scratch, "mcp.py"));
const fixture = await fs.readFile(path.join(root, "scripts/cli-bundle-smoke.mjs"), "utf8");
const png = fixture.match(/inputBytes: Buffer.from\("([^"]+)"/)[1];
await fs.writeFile(path.join(scratch, "image.png"), Buffer.from(png,"base64"));
let payload;
let fail = false;
let plannedTool;
let toolIssued = false;
let toolOutputs = [];
let childCommandIssued = false;
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
  toolOutputs.push(...(payload.input ?? []).filter(item => item.type === "function_call_output" || item.type === "custom_tool_call_output"));
  if (fail) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "offline rejection" } }));
    return;
  }
  const childCall = plannedTool?.name === "delegate" && toolIssued && !childCommandIssued && !payload.tools.some(tool=>tool.name === "delegate");
  const call = plannedTool && !toolIssued || childCall;
  const currentTool = childCall ? {name:"exec_command",args:{cmd:"pwd"}} : plannedTool;
  if (childCall) childCommandIssued = true;
  if (call) toolIssued = true;
  const item = call
    ? currentTool.name === "apply_patch"
      ? {id:"fc_probe",call_id:"call_probe",type:"custom_tool_call",status:"completed",name:currentTool.name,input:currentTool.args.input}
      : {id:"fc_probe",call_id:"call_probe",type:"function_call",status:"completed",name:currentTool.name,arguments:JSON.stringify(currentTool.args)}
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
  if (tui) { argv = ["-B", path.join(root, "standalone/test/run_pty.py"), command, ...argv]; command = "/usr/bin/python3"; }
  return new Promise(resolve => {
    const child = spawn(command, argv, { env: tui ? {...env, TERM:"xterm-256color", ...(tui === "dialog" ? {DSCODE_TEST_TUI_DIALOG:"1"} : {PI_STARTUP_BENCHMARK:"1"})} : env, cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20000);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (rpc === true && stdout.includes('"id":"probe-state"')) child.stdin.end();
      if (typeof rpc === "object") {
        // Revisit complete records only once, across split pipe chunks.
        const lines = stdout.split("\n");
        while ((rpc.seen ?? 0) < lines.length - 1) {
          const index = rpc.seen ?? 0;
          rpc.seen = index + 1;
          rpc.onEvent(JSON.parse(lines[index]), child);
        }
      }
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { stderr += error.message; });
    child.once("close", code => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }); });
    if (rpc === true) child.stdin.write('{"id":"probe-state","type":"get_state"}\n');
    else if (typeof rpc === "object") for (const request of rpc.start) child.stdin.write(JSON.stringify(request)+"\n");
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
  await check("ignores Bun project runtime configuration", async () => {
    await fs.writeFile(path.join(scratch, "bunfig.toml"), 'preload = ["./must-not-load.js"]\n');
    await fs.writeFile(path.join(scratch, "must-not-load.js"), 'throw new Error("BUN_PRELOAD_EXECUTED");');
    await fs.writeFile(path.join(scratch, ".env"), "DSCODE_SANDBOX=invalid-dotenv-value\n");
    try {
      const result = await run("dscode", [...base, "-p", "reply once"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), "standalone ok");
    } finally {
      for (const name of ["bunfig.toml", "must-not-load.js", ".env"]) await fs.unlink(path.join(scratch, name));
    }
  });
  await check("print, local skill, built-in tools, ignored configured extension/package", async () => {
    const result = await run("dscode", [...base, "-p", "reply once"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "standalone ok");
    assert.match(JSON.stringify(payload), /STANDALONE_SKILL_SENTINEL/);
    assert.ok(payload.tools.some(tool => tool.name === "exec_command"));
    assert.ok(!result.stderr.includes("USER_EXTENSION_EXECUTED"));
  });
  await check("explicit extensions and package commands rejected", async () => {
    for (const args of [["--extension",forbidden], ["-e",forbidden], ["install","npm:fixture"], ["update"], ["config"]]) {
      const result = await run("dscode",args);
      assert.notEqual(result.code,0);
      assert.match(result.stderr,/not supported/);
    }
  });
  await check("image attachment through embedded WASM worker", async () => {
    const result = await run("dscode",[...base,"@image.png","-p","describe image"]);
    assert.equal(result.code,0,result.stderr);
    assert.ok(payload.input.some(item=>Array.isArray(item.content) && item.content.some(part=>part.type === "input_image")),JSON.stringify(payload));
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
  if (process.platform === "darwin") await check("TUI model reply and clean exit under PTY", async () => {
    const result = await run("dscode", [...base,"reply once"], false, "dialog");
    assert.equal(result.timedOut,false,result.stdout+result.stderr);
    assert.equal(result.code,0,result.stdout+result.stderr);
    assert.match(result.stdout,/standalone ok/);
  });
  await check("RPC get_state and EOF", async () => {
    const result = await run("dscode", [...base, "--mode", "rpc"], true);
    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(result.code, 0, result.stderr);
    const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(events.some(event => event.id === "probe-state" && event.success));
  });
  for (const tool of [
    {name:"read",args:{path:"image.png"}},
    {name:"exec_command",args:{cmd:"pwd"}},
    {name:"apply_patch",args:{input:"*** Begin Patch\n*** Add File: patched.txt\n+standalone patch\n*** End Patch"}},
    {name:"delegate",args:{tasks:[{role:"explorer",task:"Reply once with evidence."}]}},
  ]) {
    await check(`real tool execution: ${tool.name}`, async () => {
      plannedTool = tool; toolIssued = false; toolOutputs = []; childCommandIssued = false;
      const result = await run("dscode", [...base, "--tools", "read,exec_command,write_stdin,apply_patch,delegate", "--mode", "json", "-p", "run tool once"]);
      assert.equal(result.code, 0, result.stderr);
      const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      const finished = events.find(event => event.type === "tool_execution_end" && event.toolName === tool.name);
      assert.ok(finished, result.stdout);
      assert.equal(finished.isError, false, JSON.stringify(finished));
      if (tool.name === "read") assert.ok(finished.result.content.some(item => item.type === "image"),JSON.stringify(finished));
      else if (tool.name === "apply_patch") assert.equal(await fs.readFile(path.join(scratch,"patched.txt"),"utf8"),"standalone patch\n");
      else if (tool.name === "delegate") {
        assert.equal(finished.result.details.results[0].success, true, JSON.stringify(finished));
        assert.ok(childCommandIssued);
        assert.match(JSON.stringify(toolOutputs), /dscode-standalone-run-/);
      }
      else assert.match(JSON.stringify(toolOutputs), /dscode-standalone-run-/);
    });
  }
  plannedTool = undefined;
  await check("session persistence, resume and embedded HTML export", async () => {
    const args = ["--base-url",base[1]];
    let result = await run("dscode",[...args,"-p","remember this"]);
    assert.equal(result.code,0,result.stderr);
    const sessions = (await fs.readdir(path.join(home,"sessions"))).filter(name=>name.endsWith(".jsonl"));
    assert.ok(sessions.length);
    const session = path.join(home,"sessions",sessions[0]);
    result = await run("dscode",[...args,"--session",session,"-p","continue"]);
    assert.equal(result.code,0,result.stderr);
    assert.match(JSON.stringify(payload.input),/remember this/);
    result = await run("dscode",[...args,"--export",session,path.join(scratch,"session.html")]);
    assert.equal(result.code,0,result.stderr);
    const html = await fs.readFile(path.join(scratch,"session.html"),"utf8");
    assert.match(html,/<!DOCTYPE html>/i);
    assert.ok(html.length > 10000);
    assert.ok(!html.includes("{{JS}}"));
  });
  for (const transport of ["stdio", "http"]) {
    await check(`MCP ${transport} discovery and call`, async () => {
      await fs.writeFile(path.join(home, "mcp.json"), JSON.stringify({mcpServers:{fixture:transport === "stdio"
        ? {command:"/usr/bin/python3",args:["-B",path.join(scratch,"mcp.py")]}
        : {url:`http://127.0.0.1:${server.address().port}/mcp`}}}));
      plannedTool = {name:"mcp__fixture__echo",args:{}}; toolIssued = false; toolOutputs = [];
      const result = await run("dscode", [...base, "--permission", "full", "-p", "run MCP once"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(JSON.stringify(toolOutputs), transport === "stdio" ? /MCP_OK:key=unset/ : /HTTP_MCP_OK/);
    });
  }
  plannedTool = undefined;
  await check("auto permissions deny noninteractive MCP", async () => {
    plannedTool = {name:"mcp__fixture__echo",args:{}}; toolIssued=false; toolOutputs=[];
    const result = await run("dscode",[...base,"--mode","json","-p","try MCP"]);
    assert.equal(result.code,0,result.stderr);
    assert.match(JSON.stringify(toolOutputs),/approval UI/);
    assert.doesNotMatch(JSON.stringify(toolOutputs),/HTTP_MCP_OK/);
  });
  await check("RPC approval allows MCP once", async () => {
    plannedTool = {name:"mcp__fixture__echo",args:{}}; toolIssued=false; toolOutputs=[];
    let confirmed = false;
    const result = await run("dscode",[...base,"--mode","rpc"],{
      start:[{id:"prompt",type:"prompt",message:"try MCP"}],
      onEvent(event,child) {
        if(event.type === "extension_ui_request" && event.method === "confirm") {
          confirmed=true;
          child.stdin.write(JSON.stringify({type:"extension_ui_response",id:event.id,confirmed:true})+"\n");
        }
        if(event.type === "agent_end") child.stdin.end();
      },
    });
    assert.equal(result.timedOut,false,result.stderr);
    assert.equal(result.code,0,result.stderr);
    assert.ok(confirmed,result.stdout);
    assert.match(JSON.stringify(toolOutputs),/HTTP_MCP_OK/);
  });
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
