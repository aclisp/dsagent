import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("DSCode Pi integration", () => {
  let server: http.Server | undefined;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-cli-mcp-"));
    await fs.writeFile(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: {
      fixture: { exposure: "direct", command: process.execPath, args: [path.resolve("test/fixtures/mcp-server.mjs")] },
    } }));
  });

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(["src/cli.ts", "dist/bundle/cli.js"])("runs Pi MCP CLI without model auth or DSCode argument parsing (%s)", async (entry) => {
    const env = { PATH: process.env.PATH, HOME: root, DSCODE_HOME: root, DSCODE_PROVIDER: "invalid-for-model-parser", PI_OFFLINE: "1" };
    const result = await spawnCapture(process.execPath, [path.resolve(entry), "mcp", "add", "local", "-l", "--cwd", root, "--", process.execPath, "--version"], env, root);
    expect(result.exitCode, result.stderr).toBe(0);
    const config = JSON.parse(await fs.readFile(path.join(root, ".pi/mcp.json"), "utf8"));
    expect(config.mcpServers.local).toMatchObject({ command: process.execPath, args: ["--version"], cwd: root });
    await expect(fs.stat(path.join(root, ".dscode/mcp.json"))).rejects.toThrow();
  }, 15_000);

  it.each([
    { toolArgs: [], noTools: false },
    { toolArgs: ["--tools", "read,exec_command,write_stdin,apply_patch"], noTools: false },
    { toolArgs: ["--no-tools", "--tools", "read", "--permission", "ask"], noTools: true },
  ])("sends selected and discovered tools through CLI JSONL ($toolArgs)", async ({ toolArgs, noTools }) => {
    let payload: Record<string, any> | undefined;
    server = http.createServer(async (request, response) => {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      payload = JSON.parse(Buffer.concat(body).toString("utf8")) as Record<string, any>;
      if (payload.tools?.some((tool: { type: string; name: string }) => tool.type === "custom" && tool.name !== "apply_patch")) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Only apply_patch supports custom tools" } }));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });

      const message = {
        id: "msg_dscode_test",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "mock response",
            annotations: [],
            logprobs: [],
          },
        ],
      };
      sendEvent(response, {
        type: "response.created",
        response: { id: "resp_dscode_test", status: "in_progress", output: [] },
      });
      sendEvent(response, {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      });
      sendEvent(response, {
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: "mock response",
        logprobs: [],
      });
      sendEvent(response, {
        type: "response.output_item.done",
        output_index: 0,
        item: message,
      });
      sendEvent(response, {
        type: "response.completed",
        response: {
          id: "resp_dscode_test",
          status: "completed",
          output: [message],
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens: 3,
            output_tokens_details: { reasoning_tokens: 1 },
            total_tokens: 13,
          },
        },
      });
      response.end();
    });
    const address = await listen(server);
    const execution = await spawnCapture(
      process.execPath,
      [
        "src/cli.ts",
        "-C",
        root,
        ...toolArgs,
        "--base-url",
        `http://127.0.0.1:${address.port}`,
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--no-approve",
        "reply once",
      ],
      {
        ...process.env,
        DSCODE_HOME: root,
        DSCODE_SESSIONS_DIR: path.join(root, "sessions"),
        DSCODE_PROVIDER: "deepseek",
        DSCODE_MODEL: "deepseek-v4-flash",
        DEEPSEEK_API_KEY: "test-only-key",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    );

    expect(execution.exitCode, execution.stderr).toBe(0);
    expect(execution.stderr).not.toContain("built-in extension `mcp` was not loaded");
    expect(execution.stdout).toContain("mock response");
    expect(payload?.model).toBe("deepseek-v4-flash");
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("include");
    expect(payload?.reasoning).toEqual({ effort: "max" });
    expect((payload?.tools ?? []).map((tool: { name: string }) => tool.name).sort()).toEqual(
      noTools ? [] : [...(toolArgs.length ? ["read", "exec_command", "write_stdin", "apply_patch"] : ["read", "exec_command", "write_stdin", "apply_patch", "codemode"]), "mcp__fixture__echo"].sort(),
    );
    if (!noTools && !toolArgs.length) {
      expect(payload?.tools.find((tool: { name: string }) => tool.name === "codemode"))
        .toMatchObject({ type: "function", parameters: { properties: { code: { type: "string" } } } });
    }
    if (!noTools) {
      expect(payload?.tools.find((tool: { name: string }) => tool.name === "apply_patch"))
        .toMatchObject({ type: "function", parameters: { properties: { input: { type: "string" } } } });
    }
  }, 15_000);

  it.each(["src/cli.ts", "dist/bundle/cli.js"])("launches a writable background CLI child from %s", async (entry) => {
    await fs.writeFile(path.join(root, "evidence.txt"), "FILE_EVIDENCE_SENTINEL");
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ cli_auth_credentials_store: "file" }));
    const payloads: Array<Record<string, any>> = [];
    let parentStep = 0;
    let childStep = 0;
    let port = 0;
    let sequence = 0;
    server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      payloads.push(payload);
      const parent = payload.model === "deepseek-flash";
      let tool: { name: string; args: Record<string, unknown> } | undefined;
      if (parent) {
        const history = JSON.stringify(payload.input);
        if (parentStep++ === 0) {
          tool = { name: "exec_command", args: {
            cmd: `dscode --base-url http://127.0.0.1:${port} --model deepseek-v4-pro --effort low --permission full --sandbox danger-full-access --network --tools read,apply_patch,exec_command,write_stdin --no-mcp --no-extensions --no-session --no-approve -p 'Create child.txt and verify the change'`,
            yield_time_ms: 0, timeout_ms: 0,
          } };
        } else if (parentStep === 2) {
          tool = { name: "write_stdin", args: { process_id: /process_id: (\d+)/.exec(history)?.[1], eof: true, yield_time_ms: 0 } };
        } else if (parentStep === 3) {
          tool = { name: "read", args: { path: "evidence.txt" } };
        } else if (!history.includes("CHILD_DONE")) {
          const processId = /process_id: (\d+)/.exec(history)?.[1];
          tool = { name: "write_stdin", args: { process_id: processId, yield_time_ms: 2_000 } };
        }
      } else {
        // Keep the child busy while the parent's launch yields and its next tool runs.
        await new Promise(resolve => setTimeout(resolve, 100));
        if (childStep++ === 0) tool = { name: "apply_patch", args: { input: "*** Begin Patch\n*** Add File: child.txt\n+CHILD_EDIT_OK\n*** End Patch" } };
        else if (childStep === 2) tool = { name: "exec_command", args: { cmd: "printf CHILD_COMMAND_OK" } };
      }
      respondOnce(response, tool
        ? { id: `fc_${++sequence}`, call_id: `call_${sequence}`, type: "function_call", status: "completed", name: tool.name, arguments: JSON.stringify(tool.args) }
        : { id: `msg_${++sequence}`, type: "message", status: "completed", role: "assistant", content: [
          { type: "output_text", text: parent ? "Parent collected child findings" : "CHILD_DONE", annotations: [], logprobs: [] },
        ] });
    });
    port = (await listen(server)).port;
    const execution = await spawnCapture(process.execPath, [
      entry, "-C", root, "--base-url", `http://127.0.0.1:${port}`,
      "--model", "deepseek-flash", "--tools", "read,exec_command,write_stdin", "--no-mcp", "--no-extensions",
      "--permission", "full", "--sandbox", "read-only", "--effort", "high",
      "--mode", "json", "--print", "--no-session", "--no-approve", "Delegate and collect the result",
    ], { ...process.env, DSCODE_HOME: root, DSCODE_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "test-only-key",
      PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" });
    expect(execution.exitCode, execution.stderr).toBe(0);
    const events = execution.stdout.trim().split("\n").map(line => JSON.parse(line));
    const launched = events.find(event => event.type === "tool_execution_end" && event.toolName === "exec_command");
    expect(launched.result.details).toMatchObject({ running: true, sandbox: "trusted dscode (child CLI permissions)" });
    expect(events.some(event => event.type === "tool_execution_end" && event.toolName === "read")).toBe(true);
    expect(execution.stdout).toContain("CHILD_DONE");
    expect(await fs.readFile(path.join(root, "child.txt"), "utf8")).toBe("CHILD_EDIT_OK\n");
    const children = payloads.filter(payload => payload.model === "deepseek-v4-pro");
    expect(children).toHaveLength(3);
    expect(children[0]!.reasoning.effort).toBe("low");
    expect(children[0]!.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(["apply_patch", "exec_command", "read", "write_stdin"]);
    expect(JSON.stringify(children[2]!.input)).toContain("CHILD_COMMAND_OK");
  }, 20_000);

  it("returns a non-zero CI exit code on provider failure", async () => {
    server = http.createServer(async (_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid test key" } }));
    });
    const address = await listen(server);
    const execution = await spawnCapture(
      process.execPath,
      [
        "src/cli.ts",
        "--base-url",
        `http://127.0.0.1:${address.port}`,
        "--mode",
        "json",
        "--print",
        "--no-session",
        "--no-approve",
        "this request must fail",
      ],
      {
        ...process.env,
        DSCODE_PROVIDER: "deepseek",
        DSCODE_MODEL: "deepseek-v4-flash",
        DEEPSEEK_API_KEY: "invalid-test-key",
        DSCODE_HOME: root,
        DSCODE_SESSIONS_DIR: path.join(root, "sessions"),
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    );

    expect(execution.exitCode).not.toBe(0);
    expect(`${execution.stdout}\n${execution.stderr}`).toContain("invalid test key");
  }, 15_000);
});

function sendEvent(response: http.ServerResponse, event: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve mock server address"));
        return;
      }
      resolve({ port: address.port });
    });
  });
}

function spawnCapture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function respondOnce(response: http.ServerResponse, item: Record<string, any>): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  sendEvent(response, { type: "response.created", response: { id: "resp_child", status: "in_progress", output: [] } });
  sendEvent(response, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  if (item.type === "message") sendEvent(response, {
    type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0,
    delta: item.content[0].text, logprobs: [],
  });
  sendEvent(response, { type: "response.output_item.done", output_index: 0, item });
  sendEvent(response, { type: "response.completed", response: {
    id: "resp_child", status: "completed", output: [item],
    usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13 },
  } });
  response.end();
}
