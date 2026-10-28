// Offline acceptance of the real distributable. No paid provider requests.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import { verifyWebHandoff } from "../../scripts/web-handoff-smoke.mjs";
import { ptyInvocation, isolatedRuntimeEnvironment, terminatePty } from "../../scripts/pty.mjs";
import { hostPlatform, binaryName } from "../platforms.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const windows = process.platform === "win32";
const build = await fs.realpath(path.resolve(process.argv[2] ?? path.join(root, "dist/standalone", hostPlatform())));
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dscode-standalone-run-")));
const scratch = windows ? path.join(temporary, "中文 workspace O'Brien [1]") : temporary;
await fs.mkdir(scratch, { recursive: true });
const executable = binaryName("dscode");
const metadata = JSON.parse(await fs.readFile(path.join(build, "build.json"), "utf8"));
assert.equal(metadata.platform, hostPlatform(), "Run acceptance on the artifact's target OS and architecture");
const sha256 = createHash("sha256").update(await fs.readFile(path.join(build, executable))).digest("hex");
assert.equal(sha256, metadata.sha256, "Executable does not match its build metadata");
const home = path.join(scratch, "home");
await fs.mkdir(home);
for (const name of [executable]) {
  await fs.copyFile(path.join(build, name), path.join(scratch, name));
  if (!windows) await fs.chmod(path.join(scratch, name), 0o755);
}
await fs.mkdir(path.join(home, "skills/local-probe"), { recursive: true });
await fs.writeFile(path.join(home, "skills/local-probe/SKILL.md"),
  "---\nname: local-probe\ndescription: STANDALONE_SKILL_SENTINEL\n---\nLocal skill fixture.\n");
const forbidden = path.join(home, "forbidden.js");
await fs.writeFile(forbidden, 'throw new Error("USER_EXTENSION_EXECUTED");');
await fs.writeFile(path.join(home, "config.json"), '{"cli_auth_credentials_store":"keyring"}');
await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({extensions:[forbidden],packages:["npm:must-not-install-standalone-fixture"],cacheWarming:"off"}));
// Bundle the shared SDK fixture so the sandboxed server never reads the checkout.
await bundle({
  entryPoints: [path.join(root, "test/fixtures/mcp-server.mjs")],
  outfile: path.join(scratch, "mcp-server.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node26",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const fixture = await fs.readFile(path.join(root, "scripts/cli-bundle-smoke.mjs"), "utf8");
const png = fixture.match(/inputBytes: Buffer.from\("([^"]+)"/)[1];
await fs.writeFile(path.join(scratch, "image.png"), Buffer.from(png,"base64"));
let payload;
let fail = false;
let plannedTool;
let toolIssued = false;
let toolOutputs = [];
let childReadIssued = false;
let childTools = [];
let childEofSent = false;
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
  if (payload.tools?.some(tool => tool.type === "custom" && tool.name !== "apply_patch") ||
      payload.input?.some(item => item.type === "custom_tool_call" && item.name !== "apply_patch")) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Only apply_patch supports custom tools" } }));
    return;
  }
  if (fail) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "offline rejection" } }));
    return;
  }
  const childProcess = payload.model === "standalone-child";
  const childCall = plannedTool?.child && toolIssued && !childReadIssued && childProcess;
  let currentTool = childCall ? {name:"read",args:{path:"home/forbidden.js"}} : plannedTool;
  let call = plannedTool && !toolIssued || childCall;
  if (plannedTool?.child && toolIssued && !childProcess && !JSON.stringify(payload.input).includes("exit_code: 0")) {
    const processId = /process_id: (\d+)/.exec(JSON.stringify(payload.input))?.[1];
    currentTool = {name:"write_stdin",args:{process_id:processId,...(!childEofSent ? {eof:true} : {}),yield_time_ms:30000}};
    childEofSent = true;
    call = true;
  }
  if (childCall) { childReadIssued = true; childTools = payload.tools.map(tool => tool.name).sort(); }
  if (call) toolIssued = true;
  const item = call
    ? {id:"fc_probe",call_id:"call_probe",type:"function_call",status:"completed",name:currentTool.name,arguments:JSON.stringify(currentTool.args)}
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
  ...isolatedRuntimeEnvironment(home, scratch), DSCODE_HOME: home,
  TMPDIR: scratch, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
  DEEPSEEK_API_KEY: "offline-fixture", NO_PROXY: "127.0.0.1,localhost",
};
const results = [];
function run(name, args, rpc = false, tui = false, forbidNativeExtraction = false) {
  const exe = path.join(scratch, binaryName(name));
  // On macOS, deny access to both the checkout and build outputs. PATH has no
  // Node/Bun. Permit only scratch writes: any escaped auxiliary-file write fails.
  const policy = `(version 1)(allow default)(deny file-read* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(build)}))(deny file-write* (require-not (require-any (subpath ${JSON.stringify(scratch)}) (literal "/dev/null") (literal "/dev/tty"))))${forbidNativeExtraction ? '(deny file-write* (regex "\\\\.node$"))' : ''}`;
  let command = process.platform === "darwin" ? "/usr/bin/sandbox-exec" : exe;
  let argv = process.platform === "darwin" ? ["-p", policy, exe, ...args] : args;
  if (tui) {
    const terminal = ptyInvocation(command, argv, true);
    command = terminal.command; argv = terminal.args;
  }
  return new Promise(resolve => {
    const child = spawn(command, argv, { env: tui ? {...env, TERM:"xterm-256color", ...(tui === "dialog" || tui === "paste" ? {DSCODE_TEST_TUI_DIALOG:"1", ...(tui === "paste" ? {DSCODE_TEST_TUI_PASTE:"1"} : {})} : {PI_STARTUP_BENCHMARK:"1"})} : env, cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; terminatePty(child); }, windows ? 60_000 : 20_000);
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
  await check("TUI/Web/TUI continuation in relocated standalone", async () => {
    await verifyWebHandoff({ executable: path.join(scratch, executable), args: [], parentDirectory: scratch,
      denyReadPaths: [root, build], restrictPath: true });
  });
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
  await check("only the explicit command upgrades bundled tools offline", async () => {
    const bin = path.join(home, "bin");
    const expected = {};
    const old = {};
    for (const tool of ["fd", "rg"]) {
      expected[tool] = await fs.readFile(path.join(bin, binaryName(tool)));
      const previous = Buffer.from(`#!/bin/sh\necho old-${tool}\n`);
      old[tool] = previous;
      const sha256 = createHash("sha256").update(previous).digest("hex");
      await fs.writeFile(path.join(bin, binaryName(tool)), previous);
      await fs.writeFile(path.join(bin, `.${tool}-${sha256}.json`),
        JSON.stringify({ tool, version: "0.0.1", sha256 }));
    }
    let result = await run("dscode", [...base, "-p", "reply once"]);
    assert.equal(result.code, 0, result.stderr);
    for (const tool of ["fd", "rg"]) assert.deepEqual(await fs.readFile(path.join(bin, binaryName(tool))), old[tool]);
    payload = undefined;
    result = await run("dscode", ["--update-bundled-tools"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(payload, undefined, "maintenance must not contact the model");
    assert.match(result.stdout, /fd: updated to 10\.5\.0/);
    assert.match(result.stdout, /rg: updated to 15\.2\.0/);
    assert.doesNotMatch(result.stdout, /\x1b\[/, "maintenance must not start the TUI");
    for (const tool of ["fd", "rg"]) {
      assert.deepEqual(await fs.readFile(path.join(bin, binaryName(tool))), expected[tool]);
      if (!windows) assert.ok((await fs.stat(path.join(bin, tool))).mode & 0o111);
    }
    result = await run("dscode", ["--update-bundled-tools"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /is not newer/);
    result = await run("dscode", ["--update-bundled-tools", "-p", "unrelated prompt"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Usage:/);
  });
  if (windows) await check("a running Windows tool survives an update and replacement can be retried after exit", async () => {
    const target = path.join(home, "bin", binaryName("rg"));
    const bytes = await fs.readFile(target);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const receipt = path.join(home, "bin", `.rg-${hash}.json`);
    const savedReceipt = await fs.readFile(receipt);
    await fs.writeFile(receipt, JSON.stringify({tool:"rg",version:"0.0.1",sha256:hash}));
    const child = spawn(target, ["--text", "."], { env, stdio:["pipe","ignore","ignore"] });
    const closed = once(child, "close");
    try {
      await once(child, "spawn");
      const result = await run("dscode", ["--update-bundled-tools"]);
      // A filesystem/runtime may permit atomic replacement of an open image.
      // When Windows denies it, the old executable must remain intact.
      if (result.code !== 0) assert.match(result.stderr, /Cannot replace rg\.exe/);
      assert.equal(child.exitCode, null, "the updater must not terminate a running tool");
      assert.deepEqual(await fs.readFile(target), bytes);
    } finally {
      child.stdin.end();
      await closed;
    }
    try {
      const retry = await run("dscode", ["--update-bundled-tools"]);
      assert.equal(retry.code, 0, retry.stderr);
      assert.match(retry.stdout, /rg: updated to 15\.2\.0/);
    } finally {
      // The probe deliberately used an old receipt for identical executable bytes.
      await fs.writeFile(receipt, savedReceipt);
    }
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
  await check("TUI initialization under PTY", async () => {
    const result = await run("dscode", base, false, true);
    assert.equal(result.timedOut, false, result.stdout + result.stderr);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\x1b\[/);
  });
  await check("TUI model reply and clean exit under PTY", async () => {
    const result = await run("dscode", [...base,"reply once"], false, "dialog");
    assert.equal(result.timedOut,false,result.stdout+result.stderr);
    assert.equal(result.code,0,result.stdout+result.stderr);
    assert.match(result.stdout,/standalone ok/);
  });
  if ((process.platform === "darwin" || windows) && process.env.DSCODE_TEST_CLIPBOARD_IMAGE === "1") await check("TUI image paste from host clipboard", async () => {
    try {
      payload = undefined;
      const result = await run("dscode", base, false, "paste");
      assert.equal(result.timedOut, false, result.stdout + result.stderr);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.ok(payload?.input.some(item=>Array.isArray(item.content) && item.content.some(part=>part.type === "input_image")), "model request had no pasted image");
    } finally {
      for (const name of await fs.readdir(scratch)) if (/^pi-clipboard-[\w-]+\.png$/.test(name)) await fs.unlink(path.join(scratch, name));
    }
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
    {name:"find",args:{pattern:"image.png"}},
    {name:"grep",args:{pattern:"USER_EXTENSION_EXECUTED",path:"home/forbidden.js"}},
    {name:"exec_command",args:{cmd:windows
      ? "Get-Location; (Get-Command rg.exe).Source; (Get-Command fd.exe).Source; rg --version; fd --version; if (Get-Command node.exe,bun.exe -ErrorAction SilentlyContinue) { throw 'Runtime unexpectedly available on PATH' }"
      : "pwd; command -v rg; command -v fd; rg --version; fd --version"}},
    {name:"apply_patch",args:{input:"*** Begin Patch\n*** Add File: patched.txt\n+standalone patch\n*** End Patch"}},
    ...["dscode", ...(windows ? ["DSCode.EXE"] : [])].map(executable => ({name:"exec_command",child:true,executable,
      args:{cmd:`${executable} -C "${scratch}${windows ? "\\" : ""}" --base-url ${base[1]} --model standalone-child --effort low --permission auto --tools read,find,grep,exec_command,write_stdin,apply_patch --no-mcp --no-session -p 'Read home/forbidden.js and return file evidence'`,yield_time_ms:0,timeout_ms:0}})),
  ]) {
    await check(`real tool execution: ${tool.child ? `CLI child (${tool.executable})` : tool.name}`, async () => {
      plannedTool = tool; toolIssued = false; toolOutputs = []; childReadIssued = false; childEofSent = false;
      // JSON parent and child must work without extracting a native UI addon.
      const result = await run("dscode", [...base, ...(tool.child ? ["--permission", "full"] : []), "--tools", "read,find,grep,exec_command,write_stdin,apply_patch", "--mode", "json", "-p", "run tool once"], false, false, tool.child === true);
      assert.equal(result.code, 0, result.stderr);
      const events = result.stdout.trim().split("\n").map(line => JSON.parse(line));
      const finished = events.find(event => event.type === "tool_execution_end" && event.toolName === tool.name);
      assert.ok(finished, result.stdout);
      assert.equal(finished.isError, false, JSON.stringify(finished));
      if (tool.name === "read") assert.ok(finished.result.content.some(item => item.type === "image"),JSON.stringify(finished));
      else if (tool.name === "find") assert.match(JSON.stringify(toolOutputs), /image\.png/);
      else if (tool.name === "grep") assert.match(JSON.stringify(toolOutputs), /USER_EXTENSION_EXECUTED/);
      else if (tool.name === "apply_patch") {
        assert.equal(await fs.readFile(path.join(scratch,"patched.txt"),"utf8"),"standalone patch\n");
        assert.equal(payload.tools.find(tool => tool.name === "apply_patch").type,"function");
        const replayedPatch = payload.input.find(item => item.name === "apply_patch");
        assert.equal(replayedPatch.type,"function_call");
        assert.deepEqual(JSON.parse(replayedPatch.arguments),tool.args);
        assert.ok(payload.input.some(item => item.type === "function_call_output" && item.call_id === replayedPatch.call_id));
      }
      else if (tool.child === true) {
        assert.equal(finished.result.details.running, true, JSON.stringify(finished));
        assert.ok(events.some(event => event.type === "tool_execution_end" && event.toolName === "write_stdin" && event.result.details.exitCode === 0));
        assert.ok(JSON.stringify(toolOutputs).includes("standalone ok"));
        assert.ok(childReadIssued);
        assert.deepEqual(childTools, ["apply_patch", "exec_command", "find", "grep", "read", "write_stdin"]);
        assert.match(JSON.stringify(toolOutputs), /USER_EXTENSION_EXECUTED/);
      }
      else {
        assert.match(JSON.stringify(toolOutputs), /dscode-standalone-run-/);
        const normalizedOutput = JSON.stringify(toolOutputs).replace(/\\+/g, "/");
        assert.match(normalizedOutput, /home\/bin\/rg/);
        assert.match(normalizedOutput, /home\/bin\/fd/);
        assert.match(JSON.stringify(toolOutputs), /ripgrep 15\.2\.0/);
        assert.match(JSON.stringify(toolOutputs), /fd 10\.5\.0/);
      }
    });
  }
  await check("auto permissions deny noninteractive CLI children", async () => {
    plannedTool = {name:"exec_command",args:{cmd:`${windows ? "DSCode.EXE" : "dscode"} --permission full -p 'must require parent approval'`}};
    toolIssued=false; toolOutputs=[];
    const result = await run("dscode",[...base,"--permission","auto","--no-mcp","--mode","json","-p","try CLI child"]);
    assert.equal(result.code,0,result.stderr);
    assert.match(JSON.stringify(toolOutputs),/interactive approval UI/);
  });
  if (windows) {
    const target = path.join(scratch, "审批 target [1].txt");
    const remove = `Remove-Item -LiteralPath "${target}" -Force -Confirm:$false`;
    for (const sample of [
      {name:"deletion requires approval",cmd:remove,blocked:true},
      {name:"content clearing requires approval",cmd:`Clear-Content -LiteralPath "${target}"`,blocked:true},
      {name:"pipeline aliases require approval",cmd:`Get-Item -LiteralPath "${target}" | ri -Force`,blocked:true},
      {name:"disabled WhatIf requires approval",cmd:`${remove} -WhatIf:$false`,blocked:true},
      {name:"literal WhatIf previews run without approval",cmd:`${remove} -WhatIf`,blocked:false},
      {name:"WhatIf aliases run without approval",cmd:`${remove} -wi`,blocked:false},
      {name:"environment cleanup runs without approval",cmd:'$env:DSCODE_APPROVAL_TEST="old"; $names=@("DSCODE_APPROVAL_TEST"); foreach ($v in $names) { Remove-Item "env:$v" -ErrorAction SilentlyContinue }; if (Test-Path Env:DSCODE_APPROVAL_TEST) { throw "environment cleanup failed" }; "ENV_CLEANUP_OK"',blocked:false,output:"ENV_CLEANUP_OK"},
      {name:"environment clearing runs without approval",cmd:'$env:DSCODE_APPROVAL_TEST="old"; Clear-Item Env:DSCODE_APPROVAL_TEST; if ($env:DSCODE_APPROVAL_TEST) { throw "environment clearing failed" }; "ENV_CLEAR_OK"',blocked:false,output:"ENV_CLEAR_OK"},
      {name:"environment path lists run without approval",cmd:'$env:DSCODE_APPROVAL_TEST="one"; $env:DSCODE_APPROVAL_OTHER="two"; Remove-Item Env:DSCODE_APPROVAL_TEST, Env:DSCODE_APPROVAL_OTHER; if ($env:DSCODE_APPROVAL_TEST -or $env:DSCODE_APPROVAL_OTHER) { throw "environment list cleanup failed" }; "ENV_LIST_OK"',blocked:false,output:"ENV_LIST_OK"},
      {name:"NoClobber output runs without approval",cmd:`try { Out-File -LiteralPath "${target}" -InputObject replacement -NoClobber -ErrorAction Stop; throw "NoClobber unexpectedly overwrote file" } catch { if ((Get-Content -LiteralPath "${target}" -Raw) -ne "APPROVAL_FIXTURE") { throw } }; "NO_CLOBBER_OK"`,blocked:false,output:"NO_CLOBBER_OK"},
      {name:"mixed environment and file deletion requires approval",cmd:`Remove-Item "Env:DSCODE_APPROVAL_TEST","${target}" -ErrorAction SilentlyContinue`,blocked:true},
      {name:"read-only commands run without approval",cmd:`Get-Content -LiteralPath "${target}"`,blocked:false},
    ]) {
      await check(`PowerShell auto permissions: ${sample.name}`, async () => {
        await fs.writeFile(target,"APPROVAL_FIXTURE");
        plannedTool={name:"exec_command",args:{cmd:sample.cmd}}; toolIssued=false; toolOutputs=[];
        const result=await run("dscode",[...base,"--permission","auto","--no-mcp","--mode","json","-p","try PowerShell command"]);
        assert.equal(result.code,0,result.stderr);
        if (sample.blocked) assert.match(JSON.stringify(toolOutputs),/interactive approval UI/);
        else {
          const events=result.stdout.trim().split("\n").map(line=>JSON.parse(line));
          const finished=events.find(event=>event.type==="tool_execution_end" && event.toolName==="exec_command");
          assert.ok(finished,result.stdout);
          assert.equal(finished.isError,false,JSON.stringify(finished));
          assert.equal(finished.result.details.exitCode,0,JSON.stringify(finished));
          if (sample.output) assert.ok(JSON.stringify(finished.result).includes(sample.output),JSON.stringify(finished));
        }
        assert.equal(await fs.readFile(target,"utf8"),"APPROVAL_FIXTURE");
      });
    }
    for (const approved of [false,true]) {
      await check(`PowerShell RPC approval ${approved ? "allows" : "denies"} deletion`, async () => {
        await fs.writeFile(target,"APPROVAL_FIXTURE");
        plannedTool={name:"exec_command",args:{cmd:remove}}; toolIssued=false; toolOutputs=[];
        let prompted=false;
        const result=await run("dscode",[...base,"--permission","auto","--no-mcp","--mode","rpc"],{
          start:[{id:"powershell-approval",type:"prompt",message:"try PowerShell deletion"}],
          onEvent(event,child) {
            if (event.type==="extension_ui_request" && event.method==="confirm") {
              prompted=true;
              child.stdin.write(JSON.stringify({type:"extension_ui_response",id:event.id,confirmed:approved})+"\n");
            }
            if (event.type==="agent_end") child.stdin.end();
          },
        });
        assert.equal(result.timedOut,false,result.stderr);
        assert.equal(result.code,0,result.stderr);
        assert.ok(prompted,result.stdout);
        if (approved) {
          assert.match(JSON.stringify(toolOutputs),/exit_code: 0/);
          await assert.rejects(fs.access(target),{code:"ENOENT"});
        } else {
          assert.match(JSON.stringify(toolOutputs),/Destructive command denied by user/);
          assert.equal(await fs.readFile(target,"utf8"),"APPROVAL_FIXTURE");
        }
      });
    }
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
        ? {exposure:"direct",command:process.execPath,args:[path.join(scratch,"mcp-server.mjs")]}
        : {exposure:"direct",url:`http://127.0.0.1:${server.address().port}/mcp`}}}));
      plannedTool = {name:"mcp__fixture__echo",args:transport === "stdio" ? {text:"MCP_OK"} : {}}; toolIssued = false; toolOutputs = [];
      const result = await run("dscode", [...base, "--permission", "full", "-p", "run MCP once"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(JSON.stringify(toolOutputs), transport === "stdio" ? /MCP_OK\|DEEPSEEK_API_KEY=unset/ : /HTTP_MCP_OK/);
    });
  }
  plannedTool = undefined;
  await check("native codemode worker calls MCP and records nested history", async () => {
    plannedTool = {name:"codemode",args:{code:'console.log(await tools.mcp__fixture__echo({})); console.log(typeof models);'}};
    toolIssued=false; toolOutputs=[];
    const result = await run("dscode",[...base,"--permission","full","--mode","json","-p","run native script"]);
    assert.equal(result.code,0,result.stderr);
    assert.match(JSON.stringify(toolOutputs),/HTTP_MCP_OK/);
    assert.match(JSON.stringify(toolOutputs),/undefined/);
    assert.equal(payload.tools.find(tool => tool.name === "codemode").type,"function");
    const replayedCode = payload.input.find(item => item.name === "codemode");
    assert.equal(replayedCode.type,"function_call");
    assert.deepEqual(JSON.parse(replayedCode.arguments),plannedTool.args);
    assert.ok(payload.input.some(item => item.type === "function_call_output" && item.call_id === replayedCode.call_id));
    assert.match(result.stdout,/"parentToolCallId":"call_probe(?:\|[^"]*)?"/);
    assert.match(result.stdout,/"nestedCalls"/);
  });
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
    let notificationError;
    let approvalWork;
    let cleanupWork;
    const promptRecord = path.join(scratch, "ui-prompt-hook.json");
    const endRecord = path.join(scratch, "ui-prompt-end-hook.json");
    const hooksPath = path.join(home, "hooks.json");
    // Absolute Node is an explicitly supplied external hook, just like the MCP fixture.
    const hookScript = path.join(scratch, "record-ui-prompt.mjs");
    await fs.writeFile(hookScript, 'import fs from "node:fs"; fs.writeFileSync(process.argv[3], process.argv[2]);');
    const hook = file => ({ command:process.execPath, args:[hookScript,"{payload}",file] });
    await fs.writeFile(hooksPath, JSON.stringify({hooks:{uiPromptStart:[hook(promptRecord)],uiPromptEnd:[hook(endRecord)]}}));
    async function waitForNotification(file) {
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await fs.access(file); return; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        await new Promise(resolve => setTimeout(resolve,20));
      }
      throw new Error(`UI prompt hook did not write ${file}`);
    }
    const result = await run("dscode",[...base,"--mode","rpc"],{
      start:[{id:"prompt",type:"prompt",message:"try MCP"}],
      onEvent(event,child) {
        // MCP approvals are a scoped select dialog in RPC mode; approve once.
        const options = event.type === "extension_ui_request" && event.method === "select" ? event.options ?? [] : [];
        if(options.includes("Allow once")) {
          confirmed=true;
          // Leave the dialog pending until the independent notification has run.
          approvalWork = (async () => {
            await waitForNotification(promptRecord);
            await assert.rejects(fs.access(endRecord), {code:"ENOENT"});
          })().catch(error => { notificationError = error; }).finally(() => {
            child.stdin.write(JSON.stringify({type:"extension_ui_response",id:event.id,value:"Allow once"})+"\n");
          });
        }
        if(event.type === "agent_end") {
          cleanupWork = waitForNotification(endRecord)
            .catch(error => { notificationError = error; })
            .finally(() => child.stdin.end());
        }
      },
    }).finally(() => fs.unlink(hooksPath));
    assert.equal(result.timedOut,false,result.stderr);
    assert.equal(result.code,0,result.stderr);
    assert.ok(confirmed,result.stdout);
    await Promise.all([approvalWork, cleanupWork]);
    assert.ifError(notificationError);
    assert.match(JSON.stringify(toolOutputs),/HTTP_MCP_OK/);
    const notification = JSON.parse(await fs.readFile(promptRecord,"utf8"));
    assert.equal(notification.event,"uiPromptStart");
    assert.match(notification.promptId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(notification.kind,"select");
    assert.equal(notification.mode,"rpc");
    assert.match(notification.title,/Allow MCP tool/);
    const cleanup = JSON.parse(await fs.readFile(endRecord,"utf8"));
    assert.deepEqual(cleanup,{...notification,event:"uiPromptEnd"});
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
  await fs.writeFile(path.join(build, "verification.json"), JSON.stringify({ platform:hostPlatform(), osRelease:os.release(), sha256,
    clipboardTested:process.env.DSCODE_TEST_CLIPBOARD_IMAGE === "1" && (process.platform === "darwin" || windows), scratch, results }, null, 2));
  console.log(`Artifacts: ${build}; isolated runtime files: ${scratch}`);
}
if (results.some(result => !result.passed)) process.exitCode = 1;
