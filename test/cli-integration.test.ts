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
      fixture: { command: process.execPath, args: [path.resolve("test/fixtures/mcp-server.mjs")] },
    } }));
  });

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([
    { toolArgs: [], noTools: false },
    { toolArgs: ["--tools", "read,exec_command,write_stdin,apply_patch"], noTools: false },
    { toolArgs: ["--no-tools", "--tools", "read", "--permission", "plan"], noTools: true },
  ])("sends selected and discovered tools through CLI JSONL ($toolArgs)", async ({ toolArgs, noTools }) => {
    let payload: Record<string, any> | undefined;
    server = http.createServer(async (request, response) => {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      payload = JSON.parse(Buffer.concat(body).toString("utf8")) as Record<string, any>;
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
        path.resolve("node_modules/tsx/dist/cli.mjs"),
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
    expect(execution.stdout).toContain("mock response");
    expect(payload?.model).toBe("deepseek-v4-flash");
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("include");
    expect(payload?.reasoning).toEqual({ effort: "max" });
    expect((payload?.tools ?? []).map((tool: { name: string }) => tool.name).sort()).toEqual(
      noTools ? [] : ["read", "exec_command", "write_stdin", "apply_patch", "mcp__fixture__echo"].sort(),
    );
  }, 15_000);

  it("returns a non-zero CI exit code on provider failure", async () => {
    server = http.createServer(async (_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid test key" } }));
    });
    const address = await listen(server);
    const execution = await spawnCapture(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
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
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
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
