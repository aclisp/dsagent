import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionHandler, InputEvent, InputEventResult, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult, UIPromptEndEvent, UIPromptStartEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHooks } from "../packages/core/src/hooks.ts";

const promptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function nodeHook(script: string, ...args: string[]) {
  return { command: process.execPath, args: ["-e", script, ...args] };
}

function recordHook(message: string) {
  return nodeHook("require('fs').appendFileSync('hooks.log', process.argv[1] + '\\n')", message);
}

describe("DSCode hooks", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function hookSetup(globalHooks: object, projectHooks: object = {}, trusted = true, initialize = true) {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-input-hooks-"));
    const home = path.join(root, "home");
    await fs.mkdir(home);
    await fs.mkdir(path.join(root, ".dscode"));
    await fs.writeFile(path.join(root, "hooks.log"), "");
    vi.stubEnv("DSCODE_HOME", home);
    await fs.writeFile(path.join(home, "hooks.json"), JSON.stringify({ hooks: globalHooks }));
    await fs.writeFile(path.join(root, ".dscode", "hooks.json"), JSON.stringify({ hooks: projectHooks }));
    const on = vi.fn();
    registerHooks({ on } as unknown as ExtensionAPI, () => ({ sandbox: "danger-full-access", network: false }));
    const ctx = { cwd: root, mode: "tui", isProjectTrusted: () => trusted } as unknown as ExtensionContext;
    const start = on.mock.calls.find(([name]) => name === "session_start")![1];
    if (initialize) await start({ type: "session_start" }, ctx);
    return { on, ctx };
  }

  async function hookLog() {
    return fs.readFile(path.join(root!, "hooks.log"), "utf8");
  }

  async function inputSetup(globalHooks: unknown[], projectHooks: unknown[] = [], trusted = true) {
    const { on, ctx } = await hookSetup({ input: globalHooks }, { input: projectHooks }, trusted);
    const input = on.mock.calls.find(([name]) => name === "input")![1] as ExtensionHandler<InputEvent, InputEventResult>;
    return (event: InputEvent) => input(event, ctx);
  }

  it.each([false, true])("records tool arguments and error status without result content (isError=%s)", async (isError) => {
    const record = {
      command: process.execPath,
      args: ["-e", "require('fs').appendFileSync('tools.jsonl', process.argv[1] + '\\n')", "{payload}"],
    };
    const { on, ctx } = await hookSetup({ beforeTool: [record], afterTool: [record] });
    const before = on.mock.calls.find(([name]) => name === "tool_call")![1] as ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
    const after = on.mock.calls.find(([name]) => name === "tool_result")![1] as ExtensionHandler<ToolResultEvent, ToolResultEventResult>;
    const call = {
      toolName: "mcp__fixture__echo",
      toolCallId: "call-1/1",
      parentToolCallId: "call-1",
      input: { text: "hello 'quoted'\n中文 {tool} {cwd} {payload} $& $` $'", options: { limit: 0, enabled: false }, paths: ["a", "b"] },
    };
    await expect(before({ type: "tool_call", ...call }, ctx)).resolves.toBeUndefined();
    await expect(after({
      type: "tool_result", ...call, isError,
      content: [
        { type: "text", text: "private tool output" },
        { type: "image", data: "cHJpdmF0ZQ==", mimeType: "image/png" },
      ],
      details: { private: "result details" },
      structuredContent: { private: "structured result" },
    }, ctx)).resolves.toBeUndefined();
    const payloads = (await fs.readFile(path.join(root!, "tools.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(payloads).toEqual([
      { event: "beforeTool", tool: call.toolName, toolCallId: call.toolCallId, parentToolCallId: call.parentToolCallId, input: call.input },
      { event: "afterTool", tool: call.toolName, toolCallId: call.toolCallId, parentToolCallId: call.parentToolCallId, input: call.input, isError },
    ]);
  });

  it("records top-level results with only afterTool configured", async () => {
    const { on, ctx } = await hookSetup({ afterTool: [{
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('tool.json', process.argv[1])", "{payload}"],
    }] });
    const after = on.mock.calls.find(([name]) => name === "tool_result")![1] as ExtensionHandler<ToolResultEvent, ToolResultEventResult>;
    await after({ type: "tool_result", toolName: "exec_command", toolCallId: "call-2", input: { cmd: "exit 1" }, isError: true, content: [], details: {} }, ctx);
    expect(JSON.parse(await fs.readFile(path.join(root!, "tool.json"), "utf8"))).toEqual({
      event: "afterTool", tool: "exec_command", toolCallId: "call-2", input: { cmd: "exit 1" }, isError: true,
    });
  });

  describe.each([
    ["uiPromptStart", "ui_prompt_start"],
    ["uiPromptEnd", "ui_prompt_end"],
  ] as const)("%s", (hookName, eventType) => {
    async function promptSetup(globalHooks: unknown[], projectHooks: unknown[] = [], trusted = true, initialize = true) {
      const { on, ctx } = await hookSetup({ [hookName]: globalHooks }, { [hookName]: projectHooks }, trusted, initialize);
      const prompt = on.mock.calls.find(([name]) => name === eventType)![1] as ExtensionHandler<UIPromptStartEvent | UIPromptEndEvent>;
      return async (kind: UIPromptStartEvent["kind"], title?: string, mode: ExtensionContext["mode"] = "tui") => {
        if (eventType === "ui_prompt_end") {
          await on.mock.calls.find(([name]) => name === "ui_prompt_start")![1]({ type: "ui_prompt_start", kind, title }, { ...ctx, mode });
        }
        return prompt({ type: eventType, reason: "ui_prompt", kind, ...(title !== undefined ? { title } : {}) }, { ...ctx, mode });
      };
    }

    it.each(["confirm", "select", "input", "editor", "custom"] as const)("notifies for %s prompts with metadata", async (kind) => {
      const prompt = await promptSetup([{
        command: process.execPath,
        args: ["-e", "require('fs').writeFileSync('prompt.json', process.argv[1])", "{payload}"],
      }]);
      await prompt(kind, kind === "custom" ? undefined : "Allow action?", "rpc");
      const payload = JSON.parse(await fs.readFile(path.join(root!, "prompt.json"), "utf8"));
      expect(payload).toEqual({
        event: hookName,
        promptId: expect.stringMatching(promptIdPattern),
        kind,
        ...(kind !== "custom" ? { title: "Allow action?" } : {}),
        mode: "rpc",
      });
    });

    it("runs global prompt hooks before trusted project prompt hooks", async () => {
      const prompt = await promptSetup([recordHook("global")], [recordHook("project")]);
      await expect(prompt("confirm", "Approve?")).resolves.toBeUndefined();
      expect(await hookLog()).toBe("global\nproject\n");
    });

    it("ignores untrusted project prompt hooks but still runs global hooks", async () => {
      const prompt = await promptSetup([recordHook("global")], [recordHook("project")], false);
      await prompt("custom");
      expect(await hookLog()).toBe("global\n");
    });

    it("accepts prompts without prompt hooks configured", async () => {
      const { on, ctx } = await hookSetup({ input: [] });
      if (eventType === "ui_prompt_end") {
        await on.mock.calls.find(([name]) => name === "ui_prompt_start")![1]({ type: "ui_prompt_start", kind: "confirm" }, ctx);
      }
      await expect(on.mock.calls.find(([name]) => name === eventType)![1]({ type: eventType, kind: "confirm" }, ctx)).resolves.toBeUndefined();
    });

    it("does not load or run prompt hooks before session_start", async () => {
      const prompt = await promptSetup([recordHook("prompt")], [], true, false);
      await prompt("select");
      expect(await hookLog()).toBe("");
    });

    it.each([
      { hook: nodeHook("process.stderr.write('sound failed'); process.exitCode = 7"), expected: "sound failed" },
      { hook: { ...nodeHook("setTimeout(() => {}, 1000)"), timeoutMs: 100 }, expected: "timed out" },
    ])("reports prompt hook failure without returning an approval decision: $expected", async ({ expected, hook }) => {
      const prompt = await promptSetup([hook]);
      await expect(prompt("confirm")).rejects.toThrow(expected);
    });
  });

  it("pairs unique IDs across two sessions in the same workspace and repeated prompts", async () => {
    const record = {
      command: process.execPath,
      args: ["-e", "require('fs').appendFileSync('prompts.jsonl', process.argv[1] + '\\n')", "{payload}"],
    };
    const { on, ctx } = await hookSetup({ uiPromptStart: [record], uiPromptEnd: [record] });
    const secondOn = vi.fn();
    registerHooks({ on: secondOn } as unknown as ExtensionAPI, () => ({ sandbox: "danger-full-access", network: false }));
    await secondOn.mock.calls.find(([name]) => name === "session_start")![1]({ type: "session_start" }, ctx);
    const start = { type: "ui_prompt_start", kind: "confirm", title: "Same title" };
    const end = { ...start, type: "ui_prompt_end" };
    const firstStart = on.mock.calls.find(([name]) => name === start.type)![1];
    const firstEnd = on.mock.calls.find(([name]) => name === end.type)![1];
    const secondStart = secondOn.mock.calls.find(([name]) => name === start.type)![1];
    const secondEnd = secondOn.mock.calls.find(([name]) => name === end.type)![1];
    await firstStart(start, ctx);
    await secondStart(start, ctx);
    await firstEnd(end, ctx);
    await secondEnd(end, ctx);
    // Capture IDs before queued commands execute, even for a rapid next prompt.
    await Promise.all([firstStart(start, ctx), firstEnd(end, ctx), firstStart(start, ctx), firstEnd(end, ctx)]);
    const payloads = (await fs.readFile(path.join(root!, "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(payloads).toHaveLength(8);
    const ids = payloads.map(payload => payload.promptId);
    expect(ids.every(id => promptIdPattern.test(id))).toBe(true);
    expect(ids[0]).toBe(ids[2]);
    expect(ids[1]).toBe(ids[3]);
    expect(ids[4]).toBe(ids[5]);
    expect(ids[6]).toBe(ids[7]);
    expect(new Set([ids[0], ids[1], ids[4], ids[6]]).size).toBe(4);
    expect(payloads.map(payload => payload.event)).toEqual([
      "uiPromptStart", "uiPromptStart", "uiPromptEnd", "uiPromptEnd",
      "uiPromptStart", "uiPromptEnd", "uiPromptStart", "uiPromptEnd",
    ]);
  });

  it("ignores unmatched and duplicate end events", async () => {
    const { on, ctx } = await hookSetup({ uiPromptEnd: [recordHook("cleared")] });
    const start = on.mock.calls.find(([name]) => name === "ui_prompt_start")![1];
    const end = on.mock.calls.find(([name]) => name === "ui_prompt_end")![1];
    await end({ type: "ui_prompt_end", kind: "confirm" }, ctx);
    expect(await hookLog()).toBe("");
    await start({ type: "ui_prompt_start", kind: "confirm" }, ctx);
    await end({ type: "ui_prompt_end", kind: "confirm" }, ctx);
    await end({ type: "ui_prompt_end", kind: "confirm" }, ctx);
    expect(await hookLog()).toBe("cleared\n");
  });

  it("finishes start hooks before running end hooks", async () => {
    const { on, ctx } = await hookSetup({
      uiPromptStart: [nodeHook("setTimeout(() => require('fs').appendFileSync('hooks.log', 'created\\n'), 150)")],
      uiPromptEnd: [recordHook("cleared")],
    });
    const started = on.mock.calls.find(([name]) => name === "ui_prompt_start")![1]({ type: "ui_prompt_start", kind: "confirm" }, ctx);
    const ended = on.mock.calls.find(([name]) => name === "ui_prompt_end")![1]({ type: "ui_prompt_end", kind: "confirm" }, ctx);
    await Promise.all([started, ended]);
    expect(await hookLog()).toBe("created\ncleared\n");
  });

  it("still runs cleanup after a start hook fails", async () => {
    const { on, ctx } = await hookSetup({
      uiPromptStart: [nodeHook("process.stderr.write('creation failed'); process.exitCode = 7")],
      uiPromptEnd: [recordHook("cleared")],
    });
    const started = on.mock.calls.find(([name]) => name === "ui_prompt_start")![1]({ type: "ui_prompt_start", kind: "confirm" }, ctx);
    const ended = on.mock.calls.find(([name]) => name === "ui_prompt_end")![1]({ type: "ui_prompt_end", kind: "confirm" }, ctx);
    await expect(started).rejects.toThrow("creation failed");
    await expect(ended).resolves.toBeUndefined();
    expect(await hookLog()).toBe("cleared\n");
  });

  it("runs end hooks even when the turn signal has been aborted", async () => {
    const { on, ctx } = await hookSetup({ uiPromptEnd: [{
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('cleared.txt', process.argv[1])", "{cwd}"],
    }] });
    const controller = new AbortController();
    controller.abort();
    await on.mock.calls.find(([name]) => name === "ui_prompt_start")![1](
      { type: "ui_prompt_start", kind: "confirm" }, { ...ctx, signal: controller.signal },
    );
    await on.mock.calls.find(([name]) => name === "ui_prompt_end")![1](
      { type: "ui_prompt_end", kind: "confirm" }, { ...ctx, signal: controller.signal },
    );
    await expect(fs.readFile(path.join(root!, "cleared.txt"), "utf8")).resolves.toBe(root);
  });

  it.each(["interactive", "rpc"] as const)("allows only text customization for %s input", async (source) => {
    const input = await inputSetup([{
      command: process.execPath,
      args: ["-e", "const p = JSON.parse(process.argv[1]); if (Object.keys(p).sort().join(',') !== 'event,text') process.exit(1); process.stdout.write(p.text + '\\n\\nPlease respond in Chinese.');", "{payload}"],
    }]);
    const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
    await expect(input({ type: "input", text: "hello 'quoted'", source, streamingBehavior: "steer", images }))
      .resolves.toEqual({ action: "transform", text: "hello 'quoted'\n\nPlease respond in Chinese." });
  });

  it("chains global and trusted project text replacements", async () => {
    const append = "process.stdout.write(JSON.parse(process.argv[1]).text + process.argv[2])";
    const input = await inputSetup(
      [nodeHook(append, "{payload}", " global")],
      [nodeHook(append, "{payload}", " project")],
    );
    await expect(input({ type: "input", text: "hello", source: "rpc", streamingBehavior: "followUp" }))
      .resolves.toEqual({ action: "transform", text: "hello global project" });
  });

  it("ignores project hooks in an untrusted workspace", async () => {
    const input = await inputSetup([], [recordHook("project")], false);
    await expect(input({ type: "input", text: "hello", source: "interactive" })).resolves.toEqual({ action: "continue" });
    expect(await hookLog()).toBe("");
  });

  it.each(["", " \n\t"])("keeps the input on empty or whitespace-only stdout: %s", async (stdout) => {
    const input = await inputSetup([nodeHook("process.stdout.write(process.argv[1])", stdout)]);
    await expect(input({ type: "input", text: "hello", source: "interactive" })).resolves.toEqual({ action: "continue" });
  });

  it("does not customize extension-generated input", async () => {
    const input = await inputSetup([recordHook("input")]);
    await expect(input({ type: "input", text: "hello", source: "extension" })).resolves.toEqual({ action: "continue" });
    expect(await hookLog()).toBe("");
  });

  it("treats JSON as plain text rather than Pi actions", async () => {
    const input = await inputSetup([nodeHook("process.stdout.write(process.argv[1])", '{"action":"handled","images":[]}')]);
    await expect(input({ type: "input", text: "hello", source: "rpc" }))
      .resolves.toEqual({ action: "transform", text: '{"action":"handled","images":[]}' });
  });

  it.each([
    { hook: nodeHook("process.stderr.write('hook failed'); process.exitCode = 7"), expected: "hook failed" },
    { hook: { ...nodeHook("setTimeout(() => {}, 1000)"), timeoutMs: 100 }, expected: "timed out" },
    { hook: nodeHook("process.stdout.write('x'.repeat(20001))"), expected: "truncated" },
  ])("reports failed input hooks: $expected", async ({ expected, hook }) => {
    const input = await inputSetup([hook]);
    await expect(input({ type: "input", text: "hello", source: "rpc" })).rejects.toThrow(expected);
  });

  it(
    "runs trusted hooks in the sandbox and blocks on beforeTool failure",
    async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-hooks-"));
      await fs.mkdir(path.join(root, ".dscode"));
      await fs.writeFile(
        path.join(root, ".dscode", "hooks.json"),
        JSON.stringify({
          hooks: {
            beforeTool: [
              {
                command: "node",
                args: [
                  "-e",
                  "require('fs').writeFileSync('hook.txt', process.env.DEEPSEEK_API_KEY ?? 'unset')",
                ],
              },
              {
                command: "node",
                args: ["-e", "process.stderr.write('policy blocked'); process.exit(7)"],
              },
            ],
          },
        }),
      );
      vi.stubEnv("DSCODE_HOME", path.join(root, "home"));
      vi.stubEnv("DEEPSEEK_API_KEY", "must-not-leak");

      const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
      const pi = {
        on(event: string, handler: (event: any, ctx: ExtensionContext) => any) {
          const current = handlers.get(event) ?? [];
          current.push(handler);
          handlers.set(event, current);
        },
      } as unknown as ExtensionAPI;
      const ctx = {
        cwd: root,
        signal: undefined,
        isProjectTrusted: () => true,
      } as unknown as ExtensionContext;
      registerHooks(pi, () => ({
        sandbox: process.platform === "win32" ? "danger-full-access" : "workspace-write",
        network: false,
      }));

      await handlers.get("session_start")![0]!({ type: "session_start" }, ctx);

      const decision = await handlers.get("tool_call")![0]!(
        { type: "tool_call", toolName: "apply_patch", input: {} },
        ctx,
      );
      expect(decision).toEqual({ block: true, reason: expect.stringContaining("policy blocked") });
      await expect(fs.readFile(path.join(root, "hook.txt"), "utf8")).resolves.toBe("unset");
    },
    30_000,
  );
});
