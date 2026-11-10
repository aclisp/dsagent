import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { ptyInvocation, isolatedRuntimeEnvironment, terminatePty } from "./pty.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function removeHandoffFixture(root) {
  // Windows can retain directory handles briefly after the PTY has closed.
  // Bound the retry window; a persistent lock must still fail acceptance.
  await rm(root, { recursive: true, force: true, maxRetries: process.platform === "win32" ? 10 : 0, retryDelay: 100 });
}

/** Offline acceptance of the actual TUI commands and the browser HTTP contract. */
export async function verifyWebHandoff({ executable = process.execPath, args = [path.join(repo, "dist/bundle/cli.js")], parentDirectory = os.tmpdir(), denyReadPaths = [], restrictPath = false } = {}) {
  const root = realpathSync(await mkdtemp(path.join(parentDirectory, "dscode-web-handoff-")));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await mkdir(home);
  await mkdir(workspace);
  await writeFile(path.join(home, "config.json"), JSON.stringify({ cli_auth_credentials_store: "file", sentinel: "preserve" }));
  await writeFile(path.join(home, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
  const wechatDirectory = path.join(home, "channels/wechat");
  await mkdir(wechatDirectory, { recursive: true });
  await writeFile(path.join(wechatDirectory, "credentials.json"), JSON.stringify({
    accountId: "offline-wechat", ownerId: "offline-owner", token: "offline-wechat-token",
    baseUrl: "https://127.0.0.1:1", savedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const requests = [];
  const wecomFrames = [];
  const wecomRequire = createRequire(path.join(repo, "packages/wecom/package.json"));
  const sdkRequire = createRequire(wecomRequire.resolve("@wecom/aibot-node-sdk"));
  const { WebSocketServer } = sdkRequire("ws");
  const im = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(resolve => im.once("listening", resolve));
  const authenticated = new Set();
  im.on("connection", socket => {
    socket.on("close", () => authenticated.delete(socket));
    socket.on("message", bytes => {
      const frame = JSON.parse(bytes.toString()); wecomFrames.push(frame);
      if (frame.cmd === "aibot_subscribe") authenticated.add(socket);
      socket.send(JSON.stringify({ headers: frame.headers, errcode: 0, errmsg: "ok" }));
    });
  });
  const provider = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    if (JSON.stringify(requests.at(-1).input.filter(item => item.role === "user").at(-1)).includes("IM_CREATE_SCHEDULE_FIXTURE")) {
      await writeFile(path.join(workspace, ".dscode/schedules.yaml"), `version: 1\ntasks:\n  - id: handoff-source\n    enabled: true\n    type: once\n    at: "${new Date(Date.now() + 1500).toISOString()}"\n    delivery: source\n    prompt: IM_SCHEDULED_FIXTURE\n`);
    }
    const text = `handoff reply ${requests.length}`;
    const message = { id: "msg_handoff", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [], logprobs: [] }] };
    const events = [
      { type: "response.created", response: { id: "resp_handoff", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
      { type: "response.output_text.delta", item_id: message.id, output_index: 0, content_index: 0, delta: text, logprobs: [] },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.completed", response: { id: "resp_handoff", status: "completed", output: [message], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 } } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const reserve = http.createServer();
  await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  let output = "", stderr = "", exitCode;
  let child, verificationError;
  const waitFor = async (predicate, description) => {
    const deadline = Date.now() + (process.platform === "win32" ? 30_000 : 12_000);
    while (!await predicate()) {
      if (exitCode !== undefined) throw new Error(`TUI exited (${exitCode}) while waiting for ${description}: ${stderr}\n${output.slice(-12000)}`);
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}: ${stderr}\n${output.slice(-16000)}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const send = text => child.stdin.write(`${JSON.stringify({ text })}\n`);
  const command = async (text, expected) => {
    const start = output.length;
    send(`${text}\r`);
    if (expected) await waitFor(() => output.slice(start).includes(expected), expected);
  };
  try {
    const tuiArgs = [...args, "--provider", "deepseek", "--model", "deepseek-flash", "--thinking", "low", "--permission", "auto", "--sandbox", "read-only", "--network", "--no-mcp", "--no-approve", "--base-url", `http://127.0.0.1:${provider.address().port}`];
    let program = executable;
    let programArgs = tuiArgs;
    if (denyReadPaths.length && process.platform === "darwin") {
      const policy = `(version 1)(allow default)(deny file-read* ${denyReadPaths.map(dir => `(subpath ${JSON.stringify(dir)})`).join(" ")})(deny file-write* (require-not (require-any (subpath ${JSON.stringify(root)}) (literal "/dev/null") (literal "/dev/tty"))))`;
      program = "/usr/bin/sandbox-exec";
      programArgs = ["-p", policy, executable, ...tuiArgs];
    }
    const terminal = ptyInvocation(program, programArgs);
    child = spawn(terminal.command, terminal.args, {
      cwd: workspace,
      env: { ...isolatedRuntimeEnvironment(home, root, restrictPath),
        DSCODE_HOME: home, DSCODE_SESSIONS_DIR: path.join(home, "sessions"), DSCODE_CREDENTIALS_STORE: "file",
        DEEPSEEK_API_KEY: "offline-fixture", PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
        NO_PROXY: "127.0.0.1,localhost", TERM: "xterm-256color", TMPDIR: root,
        IM_WECOM_BOT_ID: "offline-bot", IM_WECOM_SECRET: "offline-secret", IM_WECOM_BOT_NAME: "Offline Bot",
        IM_WECOM_WS_URL: `ws://127.0.0.1:${im.address().port}`,
      }, stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { output += stripVTControlCharacters(chunk.toString()); });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const finished = new Promise(resolve => child.once("close", code => { exitCode = code; resolve(code); }));
    child.once("error", error => { stderr += error.message; });
    await waitFor(() => output.includes("DeepSeek Flash"), "TUI readiness");
    await command("/effort high", "Thinking effort: high");
    await command("/permissions ask", "Permission mode: ask");
    await command("/model deepseek/deepseek-v4-pro", "DeepSeek V4 Pro");
    await command("TUI_BEFORE_HANDOFF", "handoff reply 1");
    assert.equal(requests[0].model, "deepseek-v4-pro");
    const failedStart = output.length;
    send(`/web --port ${provider.address().port}\r`);
    await waitFor(() => output.slice(failedStart).toLowerCase().includes("in use"), "occupied-port rollback");
    await command("/web status", "Web is stopped.");
    assert.equal(wecomFrames.length, 0, "a failed startup never activates IM transport");
    await command(`/web --port ${port}`, "Run /tui when you return.");
    await command("/web status", "Scheduler: running");
    assert.ok((await readdir(wechatDirectory)).some(name => name.endsWith(".sqlite")), "WeChat local state initializes in the distributable");
    const origin = `http://127.0.0.1:${port}`;
    const privateUrl = output.match(new RegExp(`${origin}/chat/[A-Za-z0-9_-]+`))?.[0];
    assert.ok(privateUrl, "private URL is shown in TUI");
    const workspaceId = new URL(privateUrl).pathname.split("/").at(-1);
    for (const asset of [privateUrl, `${origin}/chat.js`, `${origin}/chat.css`, `${origin}/marked.esm.js`, `${origin}/favicon.png`]) {
      const response = await fetch(asset);
      assert.equal(response.status, 200, asset);
      assert.ok((await response.arrayBuffer()).byteLength > 0, asset);
    }
    const listing = await (await fetch(`${origin}/v1/sessions?workspaceId=${workspaceId}`)).json();
    let id = listing.sessions[0].session.id;
    const history = () => fetch(`${origin}/v1/sessions/${id}/messages`).then(response => response.json());
    assert.match(JSON.stringify(await history()), /TUI_BEFORE_HANDOFF/);
    const turn = async message => {
      const response = await fetch(`${origin}/v1/sessions/${id}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, clientId: "phone" }) });
      assert.equal(response.status, 202, await response.text());
      const deadline = Date.now() + 8000;
      while ((await (await fetch(`${origin}/v1/sessions/${id}`)).json()).status !== "idle") {
        if (Date.now() > deadline) throw new Error("Web turn did not settle");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    await turn("/effort low");
    await turn("/permissions auto");
    await turn("WEB_CONTINUED");
    assert.equal(requests[1].model, "deepseek-v4-pro");
    assert.match(JSON.stringify(requests[1].input), /TUI_BEFORE_HANDOFF/);
    assert.equal(requests[1].reasoning.effort, "low");
    assert.match(JSON.stringify(requests[1]), /Manage the current workspace's/);
    await command("/effort max", "Thinking effort: max");
    // /reload must retain Web's branch even after the old TUI appended settings
    // to its stale branch. This reproduces the two-runtime last-written hazard.
    assert.equal((await fetch(`${origin}/v1/sessions/${id}`, { method: "DELETE" })).status, 204);
    const reloaded = await fetch(`${origin}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, resumeSessionId: id }) });
    assert.equal(reloaded.status, 201, await reloaded.text());
    assert.match(JSON.stringify(await history()), /WEB_CONTINUED/);
    await command("/tui", "Conversation resumed in the TUI.");
    await command("/permissions", "permission: ask");
    await assert.rejects(fetch(privateUrl));
    await command("TUI_AFTER_HANDOFF", "handoff reply 3");
    assert.equal(requests[2].model, "deepseek-v4-pro");
    assert.equal(requests[2].reasoning.effort, "max");
    assert.match(JSON.stringify(requests[2].input), /WEB_CONTINUED/);
    await command("/web", "Run /tui when you return.");
    const allUrls = output.match(new RegExp(`${origin}/chat/[A-Za-z0-9_-]+`, "g"));
    const nextUrl = allUrls.at(-1);
    assert.equal(nextUrl, privateUrl, "the workspace URL survives repeated handoffs");
    assert.equal((await fetch(privateUrl)).status, 200, "the saved browser URL works after restarting Web");
    const nextWorkspaceId = new URL(nextUrl).pathname.split("/").at(-1);
    const current = await (await fetch(`${origin}/v1/sessions?workspaceId=${nextWorkspaceId}`)).json();
    id = current.sessions[0].session.id;
    assert.equal((await fetch(`${origin}/v1/sessions/${id}`, { method: "DELETE" })).status, 204);
    const cleared = await (await fetch(`${origin}/v1/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: nextWorkspaceId }) })).json();
    assert.notEqual(cleared.id, id);
    await command("/tui", "Conversation resumed in the TUI.");
    await command("TUI_AFTER_CLEAR", "handoff reply 4");
    assert.doesNotMatch(JSON.stringify(requests[3].input), /WEB_CONTINUED|TUI_BEFORE_HANDOFF/);
    assert.equal(requests[3].reasoning.effort, "max");
    const preferences = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    assert.deepEqual(preferences, { cli_auth_credentials_store: "file", sentinel: "preserve",
      web: { host: "127.0.0.1", port, workspaceIds: { [realpathSync(workspace)]: workspaceId } } });
    await command("/web", "Run /tui when you return.");
    assert.equal((await fetch(privateUrl)).status, 200, "the saved URL also serves a different conversation in the workspace");
    const latest = await (await fetch(`${origin}/v1/sessions?workspaceId=${workspaceId}`)).json();
    id = latest.sessions[0].session.id;
    assert.notEqual(id, cleared.id);
    assert.match(JSON.stringify(await history()), /TUI_AFTER_CLEAR/);
    assert.doesNotMatch(JSON.stringify(await history()), /TUI_BEFORE_HANDOFF|WEB_CONTINUED/);
    const scheduleDirectory = path.join(workspace, ".dscode");
    const beforeScheduled = requests.length;
    await writeFile(path.join(scheduleDirectory, "schedules.yaml"), `version: 1\ntasks:\n  - id: handoff-scheduled\n    enabled: true\n    type: once\n    at: "${new Date(Date.now() + 1500).toISOString()}"\n    delivery: session\n    prompt: WEB_SCHEDULED_FIXTURE\n`);
    await waitFor(async () => {
      const status = JSON.parse(await readFile(path.join(scheduleDirectory, "schedules.status.json"), "utf8"));
      return status.tasks.find(task => task.id === "handoff-scheduled")?.lastRun?.status === "completed";
    }, "scheduled continuation completion");
    assert.equal(requests.length, beforeScheduled + 1);
    assert.match(JSON.stringify(requests.at(-1).input), /WEB_SCHEDULED_FIXTURE/);
    assert.match(JSON.stringify(requests.at(-1).input), /TUI_AFTER_CLEAR/);
    assert.match(JSON.stringify(await history()), /WEB_SCHEDULED_FIXTURE/);
    await waitFor(() => authenticated.size === 1, "WeCom authentication");
    const beforeIm = requests.length;
    [...authenticated][0].send(JSON.stringify({ cmd: "aibot_msg_callback", headers: { req_id: "offline-input" },
      body: { msgid: "offline-message", aibotid: "offline-bot", msgtype: "text", chattype: "single", from: { userid: "offline-owner" },
        text: { content: "IM_CREATE_SCHEDULE_FIXTURE" } } }));
    await waitFor(() => wecomFrames.some(frame => frame.cmd === "aibot_respond_msg" && frame.body?.markdown?.content?.includes("handoff reply")), "WeCom reply");
    assert.match(JSON.stringify(requests[beforeIm].input), /IM message: direct=conv-/);
    await waitFor(() => wecomFrames.some(frame => frame.cmd === "aibot_send_msg" && frame.body?.chatid === "offline-owner"), "WeCom scheduled source delivery");
    assert.equal(requests.length, beforeIm + 2);
    assert.match(JSON.stringify(requests.at(-1).input), /IM_SCHEDULED_FIXTURE/);
    send("\x04");
    await waitFor(() => exitCode !== undefined, "TUI exit with owned Web server");
    assert.equal(await finished, 0, stderr);
    await assert.rejects(fetch(nextUrl));
    await waitFor(() => authenticated.size === 0, "IM exit cleanup");
    return "TUI/Web/TUI continuation, startup rollback, scheduled tasks and embedded guide, WeCom SDK input/reply/source delivery, WeChat SQLite/fault isolation, current model and effort, files/assets, clear, preferences, stable workspace URL, and exit cleanup passed";
  } catch (error) {
    try {
      const status = JSON.parse(await readFile(path.join(workspace, ".dscode/schedules.status.json"), "utf8"));
      error.message += `\nSchedule diagnostic: ${JSON.stringify({ valid: status.valid, operational: status.operational, taskCount: status.taskCount,
        tasks: status.tasks.map(task => ({ id: task.id, nextRunAt: task.nextRunAt, lastRun: task.lastRun, lastSkip: task.lastSkip })) })}; model requests: ${requests.length}`;
    } catch { /* Preserve the original acceptance failure. */ }
    verificationError = error;
    throw error;
  } finally {
    try {
      child?.stdin.end();
      if (child && exitCode === undefined) {
        terminatePty(child);
        await new Promise(resolve => child.once("close", resolve));
      }
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
      for (const socket of im.clients) socket.terminate();
      await new Promise(resolve => im.close(resolve));
      await removeHandoffFixture(root);
    } catch (cleanupError) {
      if (verificationError) {
        throw new AggregateError([verificationError, cleanupError],
          `${verificationError.message}\nFixture cleanup also failed: ${cleanupError.message}`, { cause: verificationError });
      }
      throw cleanupError;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await verifyWebHandoff({ args: [path.resolve(process.argv[2] ?? "dist/bundle/cli.js")] }));
}
