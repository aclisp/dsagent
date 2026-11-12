import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { ManagedProcessRegistry, type ManagedProcessResult } from "../packages/core/src/managed-process.ts";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import { createAnsiTestTheme } from "./fixtures/theme.ts";

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
  const theme = createAnsiTestTheme();
  const rendered = tool.renderResult(result, { expanded, isPartial: false }, theme, { isError, isPartial: false })
    .render(1000).join("\n");
  return {
    text: rendered.split("\n").map((line: string) => stripTerminalSequences(line).trimEnd()).join("\n"),
    red: [...rendered.matchAll(/\x1b\[31m([^\x1b]*)\x1b\[39m/g)].map((match) => match[1]),
  };
}

const base: ManagedProcessResult = {
  processId: "1", running: false, output: "command output", exitCode: 0, sandbox: "host",
};

describe.each(["exec_command", "write_stdin"])("%s result presentation", (name) => {
  it.each([0, 1])("omits exit timing for an ordinary exit with code %i", async (exitCode) => {
    const details = { ...base, exitCode, exitedAfterMs: 200 };
    const { tool, result } = await execute(name, details);
    const text = [
      "command output", "process_id: 1", "status: completed", `exit_code: ${exitCode}`, "sandbox: host",
    ].join("\n");
    expect(result.content).toEqual([{ type: "text", text }]);
    expect(render(tool, result, true).text).not.toContain("main_process_exit:");
    expect(result.details).toEqual(details);
  });

  it.each(["\r\n", "\r"])("renders output with %j as line breaks while preserving the model's original output", async (ending) => {
    const output = `first${ending}${ending}second\nthird`;
    const details = { ...base, output, outputLineCount: output.split("\n").length, exitCode: 1 };
    const { tool, result } = await execute(name, details);
    expect(render(tool, result, false).text).toContain("4 output lines");
    const expanded = render(tool, result, true);
    expect(expanded.text.split("\n")).toEqual([
      "  └ first", "", "    second", "    third",
      "    process_id: 1", "    status: completed", "    exit_code: 1", "    sandbox: host",
    ]);
    expect(expanded.red).toEqual(["1"]);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(details.output) });
    expect(result.details?.output).toBe(details.output);
  });

  it.each([0, 1])("distinguishes empty output from a printed placeholder with %i actual lines", async (outputLineCount) => {
    const { tool, result } = await execute(name, {
      ...base, output: "(process completed)", outputLineCount, exitCode: 1,
    });
    expect(render(tool, result, false).text).toContain(
      `exit 1 · ${outputLineCount === 0 ? "no output" : "1 output line"} · host`,
    );
    expect(render(tool, result, true).text).toContain("(process completed)");
  });

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
    expect(expanded.text).toContain("exit_code: null");
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
    expect(result.content).toEqual([{ type: "text", text: [
      "command output", "process_id: 1", "status: running", "Use write_stdin to poll or interact.", "sandbox: host",
    ].join("\n") }]);
  });

  it.each([0, 1_010])("reports signal termination after %i ms without a timeout", async (exitedAfterMs) => {
    const details: ManagedProcessResult = { ...base, exitCode: null, exitSignal: "SIGTERM", exitedAfterMs };
    const { tool, result } = await execute(name, details);
    const exit = `main_process_exit: terminated by SIGTERM, ${exitedAfterMs} ms after start`;
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(exit) });
    expect(render(tool, result, true).text).toContain(exit);
    expect(JSON.stringify(result.content)).not.toContain("exit_signal:");
    expect(JSON.stringify(result.content)).not.toContain("process_exited_after_ms:");
    expect(JSON.stringify(result.content)).not.toContain("timeout_reason:");
  });

  it("reports a signal even if exit timing is unavailable", async () => {
    const { result } = await execute(name, { ...base, exitCode: null, exitSignal: "SIGTERM" });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("main_process_exit: terminated by SIGTERM") });
    expect(JSON.stringify(result.content)).not.toContain("ms after start");
  });

  it.each([null, 1])("keeps a timeout with exit %s collapsed and expands its details on demand", async (exitCode) => {
    const details = { ...base, exitCode, timedOut: true };
    const { tool, result } = await execute(name, details);
    const collapsed = render(tool, result, false);
    expect(collapsed.text).toMatch(/^  └ timed out · 1 output line · host · .* to expand$/);
    expect(collapsed.red).toEqual(["timed out"]);

    const expanded = render(tool, result, true);
    expect(expanded.text).toContain("command output");
    expect(expanded.text).toContain("timed_out: true");
    expect(expanded.text).toContain("status: completed");
    expect(expanded.text).toContain(`exit_code: ${exitCode}`);
    expect(expanded.red).toEqual(exitCode === null ? ["timed_out: true"] : ["1", "timed_out: true"]);
    expect(result.details).toEqual(details);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("command output") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("timed_out: true") });
    expect(JSON.stringify(result.content)).not.toContain("\\u001b");
    expect(result.isError).not.toBe(true);
  });

  it.each([0, 1])("counts %i actual output lines for a timeout with a completion placeholder", async (outputLineCount) => {
    const { tool, result } = await execute(name, {
      ...base, output: "(process completed)", outputLineCount, exitCode: null, timedOut: true,
    });
    const collapsed = render(tool, result, false);
    expect(collapsed.text).toContain(`timed out · ${outputLineCount === 0 ? "no output" : "1 output line"} · host · `);
    expect(collapsed.text.split("\n")).toHaveLength(1);
    expect(collapsed.text).toContain("to expand");
    expect(collapsed.text).not.toContain("(process completed)");
    expect(collapsed.red).toEqual(["timed out"]);
    expect(render(tool, result, true).text).toContain("(process completed)");
  });

  it.each(["\n", "\r\n", "\r"])("counts timeout output with %j line breaks and preserves the sandbox", async (ending) => {
    const output = `first${ending}${ending}[stderr] diagnostic${ending}`;
    const { tool, result } = await execute(name, { ...base, output, timedOut: true, sandbox: "workspace-write" });
    const collapsed = render(tool, result, false);
    expect(collapsed.text).toMatch(/^  └ timed out · 3 output lines · workspace-write · .* to expand$/);
    expect(collapsed.red).toEqual(["timed out"]);
    expect(result.details?.output).toBe(output);
  });

  it("keeps the timeout summary while the process is still stopping", async () => {
    const { exitCode: _exitCode, ...stopping } = { ...base, running: true, timedOut: true };
    const { tool, result } = await execute(name, stopping);
    const collapsed = render(tool, result, false);
    expect(collapsed.text).toMatch(/^  └ timed out · 1 output line · host · .* to expand$/);
    expect(collapsed.red).toEqual(["timed out"]);
  });

  it("distinguishes waiting for output from a main process that is still running", async () => {
    const details = { ...base, running: true, exitedAfterMs: 200 };
    const { tool, result } = await execute(name, details);
    expect(render(tool, result, false).text).toContain("waiting for output · process 1 · host");
    const expanded = render(tool, result, true);
    expect(expanded.text).toContain("status: running");
    expect(expanded.text).toContain("exit_code: 0");
    const exit = "main_process_exit: exited 200 ms after start; waiting for output pipes to close";
    expect(expanded.text).toContain(exit);
    expect(expanded.text).not.toContain("timeout_reason:");
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining(exit) });
    expect(result.details).toEqual(details);
  });

  it("reports a signal while waiting for output pipes", async () => {
    const details: ManagedProcessResult = {
      ...base, running: true, exitCode: null, exitSignal: "SIGTERM", exitedAfterMs: 200,
    };
    const { result } = await execute(name, details);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        "main_process_exit: terminated by SIGTERM, 200 ms after start; waiting for output pipes to close",
      ),
    });
  });

  it.each([0, 3])("explains a timeout after the main process exited with code %i", async (exitCode) => {
    const details: ManagedProcessResult = {
      ...base, exitCode, exitedAfterMs: 200, timedOut: true, timeoutReason: "output_open",
    };
    const { tool, result } = await execute(name, details);
    const collapsed = render(tool, result, false);
    expect(collapsed.text).toContain("timed out waiting for output · 1 output line · host");
    expect(collapsed.red).toEqual(["timed out waiting for output"]);
    const expanded = render(tool, result, true);
    expect(expanded.text).toContain(`exit_code: ${exitCode}`);
    expect(expanded.text).toContain("main_process_exit: exited 200 ms after start");
    expect(expanded.text).toContain("timeout_reason: output pipes were still open after the main process exited.");
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("main_process_exit: exited 200 ms after start") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("output pipes were still open") });
    expect(result.details).toEqual(details);
    expect(JSON.stringify(result.content)).not.toContain("\\u001b");
  });

  it("explains a deadline reached before the main process exited", async () => {
    const details: ManagedProcessResult = {
      ...base, exitCode: null, exitSignal: "SIGTERM", exitedAfterMs: 1_010,
      timedOut: true, timeoutReason: "process_running",
    };
    const { tool, result } = await execute(name, details);
    expect(render(tool, result, false).text).toContain("timed out · 1 output line · host");
    const expanded = render(tool, result, true);
    expect(expanded.text).toContain("main_process_exit: terminated by SIGTERM, 1010 ms after start");
    expect(expanded.text).toContain("timeout_reason: main process was still running at the deadline.");
    expect(expanded.text).not.toContain("background processes");
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("main_process_exit: terminated by SIGTERM, 1010 ms after start"),
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("main process was still running at the deadline") });
  });

  it("reports a graceful exit after the process was still running at the deadline", async () => {
    const { result } = await execute(name, {
      ...base, exitedAfterMs: 1_010, timedOut: true, timeoutReason: "process_running",
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("exit_code: 0") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("main_process_exit: exited 1010 ms after start") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("main process was still running at the deadline") });
  });

  it("does not invent an exit while a timed-out process is still running", async () => {
    const { exitCode: _exitCode, ...stopping } = { ...base, running: true };
    const { result } = await execute(name, { ...stopping, timedOut: true, timeoutReason: "process_running" });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("timed_out: true") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("main process was still running at the deadline") });
    expect(JSON.stringify(result.content)).not.toContain("main_process_exit:");
  });

  it("explains waiting for output after a timed-out process exits", async () => {
    const { result } = await execute(name, {
      ...base, running: true, exitCode: null, exitSignal: "SIGTERM", exitedAfterMs: 1_010,
      timedOut: true, timeoutReason: "process_running",
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        "main_process_exit: terminated by SIGTERM, 1010 ms after start; waiting for output pipes to close",
      ),
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("main process was still running at the deadline") });
  });

  it.each([false, true])("preserves error presentation for process launch failures with timedOut=%s", async (timedOut) => {
    const { tool, result } = await execute(name, {
      ...base, output: "[error] spawn ENOENT", exitCode: -2, processError: "spawn ENOENT", timedOut,
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

describe.each([false, true])("stdin failures with timedOut=%s", (timedOut) => {
  it.each(["\r\n", "\r"])("preserves stdin error details with %j while highlighting only generated error fields", async (ending) => {
    const { exitCode: _exitCode, ...running } = { ...base, running: true };
    const details = {
      ...running, writeError: `write EPIPE${ending}pipe closed`,
      ...(timedOut ? { running: false, exitCode: null, timedOut: true } : {}),
    };
    const { tool, result } = await execute("write_stdin", details);
    expect(result.isError).toBe(true);
    expect(result.details).toEqual(details);
    for (const expanded of [false, true]) {
      const rendered = render(tool, result, expanded);
      expect(rendered.red).toEqual(["write EPIPE", "pipe closed", ...(timedOut ? ["timed_out: true"] : [])]);
      expect(rendered.text.split("\n").some((line: string) => line.trim() === "")).toBe(false);
      expect(rendered.text).toContain(`status: ${timedOut ? "completed" : "running"}`);
      expect(rendered.text).toContain("command output");
      expect(rendered.text).toContain("stdin_write_error:");
    }
  });
});
