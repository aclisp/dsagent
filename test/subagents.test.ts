import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSubagentTools } from "../packages/core/src/subagents.js";
import type { DSCodeRuntimeOptions } from "../packages/core/src/runtime-options.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function assistant(content: string, stopReason = "stop", errorMessage?: string): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: content ? [{ type: "text", text: content }] : [],
      stopReason,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    },
  });
}

async function delegate(stdout: string, exitCode: number, stderr = "") {
  vi.stubEnv("DSCODE_SUBAGENT_DEPTH", "0");
  // The real CLI entrypoint is a JavaScript file; do not resolve Vitest's entrypoint.
  vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, "/fixture/cli.js"]);
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit("close", exitCode);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
  let tool: ToolDefinition | undefined;
  registerSubagentTools({
    registerTool: (definition: ToolDefinition) => { tool = definition; },
    registerCommand: () => {},
  } as unknown as ExtensionAPI, {
    providerId: "deepseek", modelId: "deepseek-v4-flash", baseUrl: "http://localhost",
    transport: "responses", promptContract: "engineering", sandbox: "workspace-write", network: false,
  } as DSCodeRuntimeOptions);
  return tool!.execute("audit", { tasks: [{ role: "explorer", task: "Inspect the repository" }] },
    undefined, undefined, { cwd: "/fixture" } as ExtensionToolContext);
}

describe("delegated child results", () => {
  it.each([
    { jsonl: assistant("", "error", "401: provider rejected the API key"), expected: "401: provider rejected the API key" },
    { jsonl: [assistant("Investigating"), assistant("", "error", "Rate limit exceeded")].join("\n"), expected: "Rate limit exceeded" },
    { jsonl: assistant("Partial answer", "error", "Connection lost"), expected: "Partial answer\nConnection lost" },
    { jsonl: assistant("", "error"), expected: "Request error" },
    { jsonl: assistant("", "aborted"), expected: "Request aborted" },
  ])("preserves failed child diagnostics: $expected", async ({ jsonl, expected }) => {
    const result = await delegate(jsonl, 1);
    expect(result.details).toMatchObject({ results: [{ success: false, output: expected }] });
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(expected) }]);
  });

  it("keeps the final successful answer and ignores non-protocol output", async () => {
    const result = await delegate(["startup noise", assistant("Investigating"), assistant("Done")].join("\n"), 0);
    expect(result.details).toMatchObject({ results: [{ success: true, output: "Done" }] });
  });

  it("keeps stderr for failures before a JSON message is emitted", async () => {
    const result = await delegate("", 1, "Cannot load native module");
    expect(result.details).toMatchObject({ results: [{ success: false, output: "Cannot load native module" }] });
  });
});
