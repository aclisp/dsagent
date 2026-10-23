import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { ManagedProcessRegistry, type ManagedProcessResult } from "../packages/core/src/managed-process.ts";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";

afterEach(() => vi.restoreAllMocks());

async function execute(name: string, details: ManagedProcessResult) {
  const tools = new Map<string, any>();
  const pi = new Proxy({
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    getThinkingLevel: () => "low",
  }, {
    get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined,
  }) as unknown as ExtensionAPI;
  const extension = createDSCodeExtension(parseRuntimeArgs(["--permission", "full"]).options);
  await (typeof extension === "function" ? extension(pi) : extension.factory(pi));
  vi.spyOn(ManagedProcessRegistry.prototype, "start").mockResolvedValue(details);
  vi.spyOn(ManagedProcessRegistry.prototype, "interact").mockResolvedValue(details);
  const tool = tools.get(name);
  const result: AgentToolResult<ManagedProcessResult> = await tool.execute(
    "call", name === "exec_command" ? { cmd: "command" } : { process_id: "1" },
    undefined, undefined, { cwd: process.cwd() },
  );
  return { tool, result };
}

function render(tool: any, result: AgentToolResult<unknown>, expanded: boolean, isError = result.isError === true) {
  const fg = vi.fn((color: string, text: string) => color === "error" ? `\x1b[31m${text}\x1b[39m` : text);
  const theme = { fg, bold: (text: string) => text } as unknown as Theme;
  const rendered = tool.renderResult(result, { expanded, isPartial: false }, theme, { isError, isPartial: false })
    .render(1000).join("\n");
  return {
    text: rendered.split("\n").map((line: string) => stripTerminalSequences(line).trimEnd()).join("\n"),
    red: [...rendered.matchAll(/\x1b\[31m([^\x1b]*)\x1b\[39m/g)].map((match) => match[1]),
    fg,
  };
}

const base: ManagedProcessResult = {
  processId: "1", running: false, output: "command output", exitCode: 0, sandbox: "host",
};

describe.each(["exec_command", "write_stdin"])("%s result presentation", (name) => {
  it.each([0, 1, 2])("keeps exit %i collapsed and colors only a non-zero exit number", async (exitCode) => {
    const output = "[stderr] diagnostic\nexit_code: 7\ntimed_out: true\nstdin_write_error: printed by command";
    const { tool, result } = await execute(name, { ...base, output, exitCode });
    const collapsed = render(tool, result, false);
    expect(collapsed.text).toContain(`exit ${exitCode} · 4 output lines · host`);
    expect(collapsed.text).not.toContain("diagnostic");
    expect(collapsed.text).toContain("to expand");
    expect(collapsed.red).toEqual(exitCode === 0 ? [] : [String(exitCode)]);

    const expanded = render(tool, result, true);
    expect(expanded.text).toContain(output.split("\n").join("\n    "));
    expect(expanded.text).toContain(`exit_code: ${exitCode}`);
    expect(expanded.red).toEqual(exitCode === 0 ? [] : [String(exitCode)]);
    expect(expanded.fg).toHaveBeenCalledWith("toolOutput", "exit_code: 7");
    expect(JSON.stringify(result.content)).not.toContain("\\u001b");
    expect(result.isError).not.toBe(true);
  });

  it("keeps an unavailable exit code neutral without calling it a crash", async () => {
    const { tool, result } = await execute(name, { ...base, exitCode: null });
    const collapsed = render(tool, result, false);
    expect(collapsed.text).toContain("exit ?");
    expect(collapsed.text).not.toContain("command output");
    expect(collapsed.red).toEqual([]);
    const expanded = render(tool, result, true);
    expect(expanded.fg).toHaveBeenCalledWith("dim", "null");
    expect(expanded.red).toEqual([]);
  });

  it("keeps running status and its output neutral", async () => {
    const { exitCode: _exitCode, ...running } = { ...base, running: true };
    const { tool, result } = await execute(name, running);
    expect(render(tool, result, false).text).toContain("running · process 1 · host");
    const expanded = render(tool, result, true);
    expect(expanded.text).toContain("status: running");
    expect(expanded.text).not.toContain("exit_code:");
    expect(expanded.red).toEqual([]);
  });

  it.each([null, 1])("exposes a timeout with exit %s without coloring ordinary output red", async (exitCode) => {
    const { tool, result } = await execute(name, { ...base, exitCode, timedOut: true });
    for (const expanded of [false, true]) {
      const rendered = render(tool, result, expanded);
      expect(rendered.text).toContain("command output");
      expect(rendered.text).toContain("timed_out: true");
      expect(rendered.red).toEqual(exitCode === null ? ["timed_out: true"] : ["1", "timed_out: true"]);
      expect(rendered.fg).toHaveBeenCalledWith("toolOutput", "command output");
      expect(rendered.fg).toHaveBeenCalledWith("toolOutput", "status: completed");
    }
  });

  it("preserves error presentation for process launch failures", async () => {
    const { tool, result } = await execute(name, {
      ...base, output: "[error] spawn ENOENT", exitCode: -2, processError: "spawn ENOENT",
    });
    const rendered = render(tool, result, false);
    expect(rendered.text).toContain("[error] spawn ENOENT");
    expect(rendered.red.some((line) => line.includes("spawn ENOENT"))).toBe(true);
  });

  it("preserves text-only tool errors without needing process details", async () => {
    const { tool } = await execute(name, base);
    const message = "The operation was denied.";
    const rendered = render(tool, { content: [{ type: "text", text: message }], details: undefined }, false, true);
    expect(rendered.text).toContain(message);
    expect(rendered.red.some((line) => line.includes(message))).toBe(true);
  });
});

it("preserves stdin error details while highlighting only the error message", async () => {
  const { exitCode: _exitCode, ...running } = { ...base, running: true };
  const details = { ...running, writeError: "write EPIPE\npipe closed" };
  const { tool, result } = await execute("write_stdin", details);
  expect(result.isError).toBe(true);
  expect(result.details).toEqual(details);
  for (const expanded of [false, true]) {
    const rendered = render(tool, result, expanded);
    expect(rendered.red).toEqual(["write EPIPE", "pipe closed"]);
    expect(rendered.text).toContain("status: running");
    expect(rendered.fg).toHaveBeenCalledWith("toolOutput", "command output");
    expect(rendered.fg).toHaveBeenCalledWith("toolOutput", "stdin_write_error: ");
  }
});
