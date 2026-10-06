import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.ts";
import { createAgentSessionHost } from "../packages/http-adapter/src/agent-session-host.ts";

describe("DSCode children through managed processes", () => {
  let root: string;
  let server: http.Server;
  let baseUrl: string;
  let requests: any[];
  let file: string;
  let authorizations: (string | undefined)[];
  let registry: ManagedProcessRegistry;
  let plannedTools: { name: string; arguments: Record<string, unknown> }[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-process-integration-"));
    await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ cli_auth_credentials_store: "file" }));
    await fs.writeFile(path.join(root, "settings.json"), JSON.stringify({ cacheWarming: "off" }));
    vi.stubEnv("DSCODE_HOME", root);
    vi.stubEnv("DSCODE_PROVIDER", "deepseek");
    vi.stubEnv("DEEPSEEK_API_KEY", "isolated-test-key");
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("DSCODE_SUBAGENT_DEPTH", "0");
    requests = [];
    authorizations = [];
    file = "child.txt";
    plannedTools = [{ name: "apply_patch", arguments: { input: `*** Begin Patch\n*** Add File: ${file}\n+CHILD_RESULT\n*** End Patch` } }];
    server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(payload);
      authorizations.push(request.headers.authorization);
      const plannedTool = plannedTools[requests.length - 1];
      const item = plannedTool
        ? { id: `fc_${requests.length}`, call_id: `call_${requests.length}`, type: "function_call", status: "completed", name: plannedTool.name,
          arguments: JSON.stringify(plannedTool.arguments) }
        : { id: "msg_done", type: "message", status: "completed", role: "assistant", content: [
          { type: "output_text", text: "CHILD_FINISHED", annotations: [], logprobs: [] },
        ] };
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [
        { type: "response.created", response: { id: "resp", status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        ...(item.type === "message" ? [{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "CHILD_FINISHED", logprobs: [] }] : []),
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp", status: "completed", output: [item], usage: {
          input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 13,
        } } },
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    registry = new ManagedProcessRegistry();
  });

  afterEach(async () => {
    await registry.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  function command(extra: string) {
    return `dscode --base-url ${baseUrl} --provider deepseek --model child-model --effort low --tools apply_patch --no-mcp --no-extensions --no-approve --no-session ${extra}`;
  }

  it("enforces one child level in the real CLI without restricting child commands or edits", async () => {
    plannedTools = [
      { name: "exec_command", arguments: { cmd: "dscode --permission full -p 'grandchild'", yield_time_ms: 0, timeout_ms: 0 } },
      { name: "exec_command", arguments: { cmd: "printf ORDINARY_CHILD_COMMAND", yield_time_ms: 1_000 } },
      plannedTools[0]!,
    ];
    const launched = await registry.start(command("--tools exec_command,apply_patch --permission full -p 'do the task without grandchildren'"), {
      cwd: root, sandbox: { mode: "read-only", network: false }, yieldTimeMs: 0, timeoutMs: 0, thinkingLevel: "max",
    });
    const completed = await registry.interact(launched.processId, { eof: true, yieldTimeMs: 5_000 });
    expect(completed).toMatchObject({ running: false, exitCode: 0 });
    expect(requests).toHaveLength(4);
    expect(JSON.stringify(requests[1].input)).toContain("DSCode child depth limit reached (maximum depth: 1)");
    expect(JSON.stringify(requests[2].input)).toContain("ORDINARY_CHILD_COMMAND");
    expect(await fs.readFile(path.join(root, file), "utf8")).toBe("CHILD_RESULT\n");
  }, 15_000);

  it("lets an HTTP host launch a child with independent model and editing permissions", async () => {
    const host = await createAgentSessionHost({ cwd: root, runtimeArgs: ["--no-mcp", "--sandbox", "read-only", "--permission", "ask"] });
    try {
      const execute = host.session.agent.state.tools.find(tool => tool.name === "exec_command")!;
      const poll = host.session.agent.state.tools.find(tool => tool.name === "write_stdin")!;
      const launched = await execute.execute("launch", { cmd: command("--permission full -p 'create a file'"), yield_time_ms: 0, timeout_ms: 0 });
      const processId = (launched.details as { processId: string }).processId;
      expect(launched.details).toMatchObject({ running: true });
      const completed = await poll.execute("collect", { process_id: processId, eof: true, yield_time_ms: 5_000 });
      expect(completed.details).toMatchObject({ running: false, exitCode: 0 });
      expect(JSON.stringify(completed.content)).toContain("CHILD_FINISHED");
      expect(await fs.readFile(path.join(root, file), "utf8")).toBe("CHILD_RESULT\n");
      expect(requests[0]).toMatchObject({ model: "child-model", reasoning: { effort: "low" } });
      expect(host.session.model!.id).not.toBe("child-model");
    } finally { await host.dispose(); }
  }, 15_000);

  it("uses saved file credentials from the child's configured home", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    await fs.writeFile(path.join(root, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: "stored-test-key" } }));
    const launched = await registry.start(command("--permission full -p 'create a file'"), {
      cwd: root, sandbox: { mode: "read-only", network: false }, yieldTimeMs: 0, timeoutMs: 0, thinkingLevel: "max",
    });
    const completed = await registry.interact(launched.processId, { eof: true, yieldTimeMs: 5_000 });
    expect(completed).toMatchObject({ running: false, exitCode: 0 });
    expect(authorizations[0]).toBe("Bearer stored-test-key");
    expect(await fs.readFile(path.join(root, file), "utf8")).toBe("CHILD_RESULT\n");
  }, 15_000);

  it("reports a blocked print-mode approval without accepting stdin as confirmation", async () => {
    const result = await registry.start(command("--permission ask -p 'create a file'"), {
      cwd: root, sandbox: { mode: "read-only", network: false }, yieldTimeMs: 0, timeoutMs: 0, thinkingLevel: "max",
    });
    const completed = await registry.interact(result.processId, { eof: true, yieldTimeMs: 5_000 });
    expect(completed).toMatchObject({ running: false, exitCode: 0 });
    expect(JSON.stringify(requests[1].input)).toContain("interactive approval UI");
    await expect(fs.access(path.join(root, file))).rejects.toThrow();
  }, 15_000);

  it("round-trips an RPC approval through stdin, then collects the result and closes the child", async () => {
    const launched = await registry.start(command("--permission ask --mode rpc"), {
      cwd: root, sandbox: { mode: "read-only", network: false }, yieldTimeMs: 0, timeoutMs: 0, thinkingLevel: "max",
    });
    const events: any[] = [];
    let partial = "";
    function capture(output: string) {
      partial += output;
      const lines = partial.split("\n");
      partial = lines.pop()!;
      for (const line of lines) {
        try { events.push(JSON.parse(line)); } catch { /* Non-protocol diagnostics. */ }
      }
    }
    capture(launched.output === "(no new output)" ? "" : launched.output);
    capture((await registry.interact(launched.processId, { chars: JSON.stringify({ type: "prompt", message: "create a file" }) + "\n", yieldTimeMs: 0 })).output.replace("(no new output)", ""));
    await vi.waitFor(async () => {
      capture((await registry.interact(launched.processId, { yieldTimeMs: 20 })).output.replace("(no new output)", ""));
      expect(events.some(event => event.type === "extension_ui_request" && event.method === "confirm")).toBe(true);
    }, { timeout: 5_000 });
    const approval = events.find(event => event.type === "extension_ui_request" && event.method === "confirm");
    expect(approval.title).toContain(file);
    await expect(fs.access(path.join(root, file))).rejects.toThrow();
    capture((await registry.interact(launched.processId, { chars: JSON.stringify({ type: "extension_ui_response", id: approval.id, confirmed: true }) + "\n", yieldTimeMs: 0 })).output.replace("(no new output)", ""));
    await vi.waitFor(async () => {
      capture((await registry.interact(launched.processId, { yieldTimeMs: 20 })).output.replace("(no new output)", ""));
      expect(events.some(event => event.type === "agent_settled")).toBe(true);
    }, { timeout: 5_000 });
    expect(JSON.stringify(events)).toContain("CHILD_FINISHED");
    expect(await fs.readFile(path.join(root, file), "utf8")).toBe("CHILD_RESULT\n");
    expect(await registry.interact(launched.processId, { eof: true, yieldTimeMs: 2_000 })).toMatchObject({ running: false, exitCode: 0 });
  }, 15_000);
});
