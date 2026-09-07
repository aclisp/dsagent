import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.js";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.js";
import { createTestTheme } from "./fixtures/theme.js";

describe("checkpoint extension commands", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-checkpoint-extension-"));
    home = path.join(root, "home");
    await fs.mkdir(home);
    vi.stubEnv("DSCODE_HOME", home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("shows diffs, reports cancelled undo, and restores the latest checkpoint", async () => {
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const entries: Array<{ customType: string; data: unknown }> = [];
    let activeTools = ["read", "exec_command", "write_stdin", "apply_patch"];
    const pi = new Proxy({
      registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => { activeTools = [...names]; },
    }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as ExtensionAPI;
    const notify = vi.fn();
    const confirm = vi.fn(async () => true);
    const ctx = {
      cwd: root,
      mode: "rpc",
      hasUI: true,
      ui: new Proxy({
        notify,
        confirm,
        theme: createTestTheme(),
      }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }),
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
    };
    const extension = createDSCodeExtension(
      parseRuntimeArgs(["-C", root, "--no-mcp", "--permission", "auto"]).options,
    );
    await (typeof extension === "function" ? extension(pi) : extension.factory(pi));
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);

    const patch = [
      "*** Begin Patch",
      "*** Add File: checkpoint.txt",
      "+after",
      "*** End Patch",
    ].join("\n");
    const result = await tools.get("apply_patch")!.execute(
      "call-1",
      { input: patch },
      undefined,
      undefined,
      ctx as any,
    );
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Applied checkpoint") });
    await commands.get("diff")!.handler("", ctx);
    expect(entries.at(-1)).toMatchObject({
      customType: "dscode-diff",
      data: { patch },
    });

    confirm.mockResolvedValueOnce(false);
    await commands.get("undo")!.handler("", ctx);
    expect(notify).toHaveBeenCalledWith("Undo cancelled.", "info");
    await expect(fs.readFile(path.join(root, "checkpoint.txt"), "utf8")).resolves.toBe("after\n");

    await commands.get("undo")!.handler("", ctx);
    await expect(fs.access(path.join(root, "checkpoint.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(notify).toHaveBeenCalledWith("Restored checkpoint.txt", "info");
  });

  it("explains force overwrite in the confirmation request", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const tools = new Map<string, ToolDefinition>();
    const pi = new Proxy({
      registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      appendEntry() {},
      getActiveTools: () => ["apply_patch"],
      setActiveTools() {},
    }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as ExtensionAPI;
    const confirm = vi.fn(async () => false);
    const ctx = {
      cwd: root,
      mode: "rpc",
      hasUI: true,
      ui: new Proxy({ confirm, theme: createTestTheme() }, {
        get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined,
      }),
      isProjectTrusted: () => true,
      sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
    };
    const extension = createDSCodeExtension(
      parseRuntimeArgs(["-C", root, "--no-mcp", "--permission", "auto"]).options,
    );
    await (typeof extension === "function" ? extension(pi) : extension.factory(pi));
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    const patch = [
      "*** Begin Patch",
      "*** Add File: force.txt",
      "+after",
      "*** End Patch",
    ].join("\n");
    await tools.get("apply_patch")!.execute("call-2", { input: patch }, undefined, undefined, ctx as any);
    await commands.get("undo")!.handler("--force", ctx);
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(/^Undo /),
      expect.stringContaining("--force will overwrite changes made after this checkpoint."),
    );
  });
});
