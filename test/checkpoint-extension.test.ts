import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import { createTestTheme } from "./fixtures/theme.ts";

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
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("shows diffs, reports cancelled undo, and restores the latest checkpoint", async () => {
    const tools = new Map<string, ToolDefinition>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    const entries: Array<{ customType: string; data: unknown }> = [];
    const renderers = new Map<string, any>();
    let activeTools = ["read", "exec_command", "write_stdin", "apply_patch"];
    const pi = new Proxy({
      registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      registerEntryRenderer(name: string, renderer: any) { renderers.set(name, renderer); },
      on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
      getActiveTools: () => [...activeTools],
      setActiveTools: (names: string[]) => { activeTools = [...names]; },
    }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as ExtensionAPI;
    const notify = vi.fn();
    const confirm = vi.fn(async () => true);
    const select = vi.fn<(title: string, items: string[]) => Promise<string | undefined>>(async () => undefined);
    const ctx = {
      cwd: root,
      mode: "rpc",
      hasUI: true,
      ui: new Proxy({
        notify,
        confirm,
        select,
        theme: createTestTheme(),
      }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }),
      isProjectTrusted: () => true,
      sessionManager: {
        getBranch: () => entries.map((entry) => ({ type: "custom", ...entry })),
        getSessionFile: () => undefined,
      },
    };
    const extension = createDSCodeExtension(
      parseRuntimeArgs(["-C", root, "--no-mcp", "--permission", "auto"]).options,
    );
    await (typeof extension === "function" ? extension(pi) : extension.factory(pi));
    expect(tools.get("read")?.renderShell).toBe("self");
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    await commands.get("diff")!.handler("history", ctx);
    expect(notify).toHaveBeenCalledWith("No patch checkpoints in this branch.", "info");

    await fs.writeFile(path.join(root, "config.txt"), "timeout = 1000\n");
    const patch = [
      "*** Begin Patch",
      "*** Add File: checkpoint.txt",
      "+after",
      "*** Update File: config.txt",
      "@@",
      "-timeout = 1000",
      "+timeout = 2000",
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
    // Later disk edits must not change the checkpoint's displayed diff.
    await fs.writeFile(path.join(root, "config.txt"), "unrelated\n");
    await commands.get("diff")!.handler("", ctx);
    expect(entries.at(-1)).toMatchObject({
      customType: "dscode-diff",
      data: { patch, files: [
        { path: "checkpoint.txt", status: "added", diff: "+1 after" },
        { path: "config.txt", status: "modified", diff: "-1 timeout = 1000\n+1 timeout = 2000" },
      ] },
    });
    initTheme("dark", false);
    // Pi disables inverse ANSI in non-TTY tests; make its emphasis observable.
    vi.spyOn(Theme.prototype, "inverse").mockImplementation((text) => `⟦${text}⟧`);
    const render = (data: unknown) => renderers.get("dscode-diff")(
      { data }, { expanded: false }, createTestTheme(),
    ).render(120).join("\n");
    const rendered = render(entries.at(-1)!.data);
    expect(rendered).toContain("config.txt (modified)");
    expect(rendered).toContain("⟦1000⟧");
    expect(rendered).toContain("⟦2000⟧");
    expect(render({ checkpointId: "legacy", patch })).toContain("*** Begin Patch");
    await fs.writeFile(path.join(root, "config.txt"), "timeout = 2000\n");

    confirm.mockResolvedValueOnce(false);
    await commands.get("undo")!.handler("", ctx);
    expect(notify).toHaveBeenCalledWith("Undo cancelled.", "info");
    await expect(fs.readFile(path.join(root, "checkpoint.txt"), "utf8")).resolves.toBe("after\n");

    await commands.get("undo")!.handler("", ctx);
    await expect(fs.access(path.join(root, "checkpoint.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(notify).toHaveBeenCalledWith("Restored checkpoint.txt, config.txt", "info");

    const originalDiff = entries.find((entry) => entry.customType === "dscode-diff")!.data as { checkpointId: string };
    const secondPatch = "*** Begin Patch\n*** Add File: second.txt\n+second\n*** End Patch";
    await tools.get("apply_patch")!.execute("call-next", { input: secondPatch }, undefined, undefined, ctx as any);
    // Replaying the current branch must retain older checkpoints and their undo status.
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    await commands.get("diff")!.handler("", ctx);
    expect(entries.at(-1)).toMatchObject({ data: { patch: secondPatch } });
    await commands.get("diff")!.handler(originalDiff.checkpointId, ctx);
    expect(entries.at(-1)!.data).toEqual(originalDiff);
    await expect(fs.access(path.join(root, "checkpoint.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    select.mockImplementationOnce(async (_title, items) => {
      expect(items[0]).toContain("second.txt");
      const older = items.find((item) => item.startsWith(originalDiff.checkpointId));
      expect(older).toContain("(undone)");
      return older;
    });
    await commands.get("diff")!.handler("history", ctx);
    expect(entries.at(-1)!.data).toEqual(originalDiff);
    expect(select).toHaveBeenCalledWith("Patch history — 1–2 of 2, newest first", expect.any(Array));

    const count = entries.length;
    await commands.get("diff")!.handler("history", ctx); // cancelled picker
    await commands.get("diff")!.handler("missing", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Unknown checkpoint: missing"), "warning");
    await commands.get("diff")!.handler("history", { ...ctx, hasUI: false });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/diff <checkpoint-id>"), "info");
    expect(entries).toHaveLength(count);

    for (let index = 0; index < 19; index++) {
      await tools.get("apply_patch")!.execute(`page-${index}`, {
        input: `*** Begin Patch\n*** Add File: page-${index}.txt\n+page\n*** End Patch`,
      }, undefined, undefined, ctx as any);
    }
    select.mockImplementationOnce(async (title, items) => {
      expect(title).toContain("1–10 of 21");
      expect(items).toHaveLength(11);
      expect(items).not.toContain("Newer patches…");
      return "Older patches…";
    }).mockImplementationOnce(async (title, items) => {
      expect(title).toContain("11–20 of 21");
      expect(items).toHaveLength(12);
      return "Newer patches…";
    }).mockResolvedValueOnce("Older patches…")
      .mockResolvedValueOnce("Older patches…")
      .mockImplementationOnce(async (title, items) => {
        expect(title).toContain("21–21 of 21");
        expect(items).toHaveLength(2);
        expect(items).not.toContain("Older patches…");
        return items[0];
      });
    await commands.get("diff")!.handler("history", ctx);
    expect(entries.at(-1)!.data).toEqual(originalDiff);
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
