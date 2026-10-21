import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("lists only the last settled turn by default and keeps retries in the same turn", async () => {
    const harness = await createPatchHarness(root);
    await harness.emit({ type: "agent_start" });
    const older = await harness.patch("older.txt");
    await harness.settle();
    await harness.emit({ type: "agent_start" });
    const first = await harness.patch("first.txt");
    await harness.emit({ type: "agent_end", messages: [] });
    // The loop can restart for retry, compaction, or queued continuation without settling.
    await harness.emit({ type: "agent_start" });
    const second = await harness.patch("second.txt");

    await harness.list("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`● ${older}  older.txt`, "info");
    await harness.settle();
    await harness.list("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`● ${first}  first.txt\n● ${second}  second.txt`, "info");
    await harness.list("all", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`● ${older}  older.txt\n● ${first}  first.txt\n● ${second}  second.txt`, "info");
    expect(harness.entries.filter((entry) => entry.customType === "dscode-checkpoint-turn")).toEqual([
      { customType: "dscode-checkpoint-turn", data: { checkpointIds: [older] } },
      { customType: "dscode-checkpoint-turn", data: { checkpointIds: [first, second] } },
    ]);

    const resumed = await createPatchHarness(root, harness.entries);
    await resumed.emit({ type: "session_start", reason: "resume" });
    await resumed.list("", resumed.ctx);
    expect(resumed.notify).toHaveBeenLastCalledWith(`● ${first}  first.txt\n● ${second}  second.txt`, "info");
  });

  it("persists an empty last turn instead of falling back to earlier checkpoints", async () => {
    const harness = await createPatchHarness(root);
    await harness.emit({ type: "agent_start" });
    const older = await harness.patch("older.txt");
    await harness.settle();
    await harness.emit({ type: "agent_start" });
    await harness.settle();
    await harness.list("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith("No checkpoints were created in the last turn.", "info");
    await harness.list("all", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`● ${older}  older.txt`, "info");

    const resumed = await createPatchHarness(root, harness.entries);
    await resumed.emit({ type: "session_start", reason: "reload" });
    await resumed.list("", resumed.ctx);
    expect(resumed.notify).toHaveBeenLastCalledWith("No checkpoints were created in the last turn.", "info");
  });

  it("includes checkpoints from an aborted turn and keeps undo working one checkpoint at a time", async () => {
    const harness = await createPatchHarness(root);
    await harness.emit({ type: "agent_start" });
    const older = await harness.patch("older.txt");
    await harness.settle();
    await harness.emit({ type: "agent_start" });
    const latest = await harness.patch("latest.txt");
    await harness.settle(true);
    await harness.list("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`● ${latest}  latest.txt`, "info");
    await harness.undo("", harness.ctx);
    await expect(fs.access(path.join(root, "latest.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(root, "older.txt"), "utf8")).resolves.toBe("saved\n");
    await harness.list("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`↶ ${latest}  latest.txt`, "info");
    await harness.emit({ type: "session_start", reason: "reload" });
    await harness.list("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`↶ ${latest}  latest.txt`, "info");
    await harness.undo("", harness.ctx);
    await expect(fs.access(path.join(root, "older.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await harness.list("all", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`↶ ${older}  older.txt\n↶ ${latest}  latest.txt`, "info");
  });

  it("restores the last turn and full history from the selected session branch", async () => {
    const harness = await createPatchHarness(root);
    await harness.emit({ type: "agent_start" });
    const older = await harness.patch("older.txt");
    await harness.settle();
    const earlierBranch = [...harness.entries];
    await harness.emit({ type: "agent_start" });
    await harness.patch("other-branch.txt");
    await harness.settle();
    harness.entries.splice(0, harness.entries.length, ...earlierBranch);
    await harness.emit({ type: "session_tree", newLeafId: "earlier", oldLeafId: "later" });
    await harness.list("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`● ${older}  older.txt`, "info");
    await harness.list("all", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`● ${older}  older.txt`, "info");
    harness.entries.length = 0;
    await harness.emit({ type: "session_start", reason: "new" });
    await harness.list("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith("No checkpoints were created in the last turn.", "info");
    await harness.list("all", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith("No patch checkpoints in this branch.", "info");
  });

  it("keeps legacy checkpoints available without inventing their turn boundaries", async () => {
    const harness = await createPatchHarness(root);
    const legacy = await harness.patch("legacy.txt");
    harness.entries.push({ customType: "dscode-checkpoint-turn", data: { checkpointIds: [123] } });
    await harness.emit({ type: "session_start", reason: "resume" });
    await harness.list("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(
      "Last-turn checkpoint information is unavailable. Use /checkpoints all to list this branch's checkpoints.", "info",
    );
    await harness.list("all", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith(`● ${legacy}  legacy.txt`, "info");
    await harness.emit({ type: "agent_start" });
    await harness.settle();
    await harness.list("", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith("No checkpoints were created in the last turn.", "info");
  });

  it("offers the all argument and explains unsupported arguments", async () => {
    const harness = await createPatchHarness(root);
    expect(harness.commands.get("checkpoints")!.getArgumentCompletions!("a")).toEqual([
      { value: "all", label: "all — list every checkpoint in the current branch" },
    ]);
    expect(harness.commands.get("checkpoints")!.getArgumentCompletions!("x")).toEqual([]);
    await harness.list("unknown", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith("Usage: /checkpoints [all]", "warning");
    await harness.list(" all ", harness.ctx);
    expect(harness.notify).toHaveBeenLastCalledWith("No patch checkpoints in this branch.", "info");
  });

  it("reports partial writes without creating a checkpoint or claiming undo support", async () => {
    const { tool, ctx, entries, undo, notify } = await createPatchHarness(root);
    const failedPath = path.join(root, "failed.txt");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === failedPath) throw new Error("disk full");
      return rename(from, to);
    });
    const error = await tool.execute("partial", {
      input: "*** Begin Patch\n*** Add File: saved.txt\n+saved\n*** Add File: failed.txt\n+failed\n*** End Patch",
    }, undefined, undefined, ctx).catch((error: unknown) => error);
    const message = (error as Error).message;
    expect(message).toContain("write failed.txt: disk full");
    expect(message).toContain("- write saved.txt");
    expect(message).toContain("No checkpoint was created for this patch");
    expect(message).toContain("/undo cannot restore this patch's changes");
    expect(entries).toEqual([]);
    await undo("", ctx);
    expect(notify).toHaveBeenCalledWith("No patch checkpoint is available to undo.", "info");
    await expect(fs.readFile(path.join(root, "saved.txt"), "utf8")).resolves.toBe("saved\n");

    const rendered = tool.renderResult!({ content: [{ type: "text", text: message }], details: undefined },
      { expanded: true, isPartial: false }, createTestTheme(), {
        args: {}, toolCallId: "partial", invalidate() {}, lastComponent: undefined, state: undefined,
        cwd: root, executionStarted: true, argsComplete: true, isPartial: false, expanded: true,
        showImages: false, isError: true, durationMs: 0, outputPad: 0,
      }).render(200).join("\n");
    expect(rendered).toContain("write failed.txt: disk full");
    expect(rendered).toContain("- write saved.txt");
    expect(rendered).toContain("No checkpoint was created");
  });

  it.each(["destination write", "source deletion"] as const)("reports a failed move without a checkpoint: %s", async (failureKind) => {
    const { tool, ctx, entries, undo, notify } = await createPatchHarness(root);
    const source = path.join(root, "old.txt");
    const destination = path.join(root, "moved.txt");
    await fs.writeFile(source, "before\n");
    if (failureKind === "destination write") {
      vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("destination blocked"));
    } else {
      const rm = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
        if (String(file) === source) throw new Error("source deletion blocked");
        return rm(file, options);
      });
    }
    const error = await tool.execute("move", {
      input: "*** Begin Patch\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** End Patch",
    }, undefined, undefined, ctx).catch((error: unknown) => error);
    expect((error as Error).message).toContain("No checkpoint was created for this patch. /undo cannot restore this patch's changes.");
    await expect(fs.readFile(source, "utf8")).resolves.toBe("before\n");
    if (failureKind === "destination write") {
      expect((error as Error).message).toContain("write moved.txt: destination blocked");
      expect((error as Error).message).toContain("File operations completed before failure:\n(none)");
      await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect((error as Error).message).toContain("delete old.txt: source deletion blocked");
      expect((error as Error).message).toContain("File operations completed before failure:\n- write moved.txt");
      await expect(fs.readFile(destination, "utf8")).resolves.toBe("after\n");
    }
    expect(entries).toEqual([]);
    await undo("", ctx);
    expect(notify).toHaveBeenCalledWith("No patch checkpoint is available to undo.", "info");
  });

  it("creates a checkpoint for a successful move and restores its source on undo", async () => {
    const { tool, ctx, entries, undo } = await createPatchHarness(root);
    await fs.writeFile(path.join(root, "old.txt"), "before\n");
    const result = await tool.execute("move", {
      input: "*** Begin Patch\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** End Patch",
    }, undefined, undefined, ctx);
    expect(result.details).toMatchObject({ files: ["old.txt", "moved.txt"], additions: 1, deletions: 1 });
    expect(entries).toHaveLength(1);
    await expect(fs.access(path.join(root, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(root, "moved.txt"), "utf8")).resolves.toBe("after\n");
    await undo("", ctx);
    await expect(fs.readFile(path.join(root, "old.txt"), "utf8")).resolves.toBe("before\n");
    await expect(fs.access(path.join(root, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("rejects a symbolic link without saving a checkpoint (dangling: %s)", async (dangling) => {
    const { tool, ctx, entries } = await createPatchHarness(root);
    if (!dangling) await fs.writeFile(path.join(root, "target.txt"), "before\n");
    await fs.symlink("target.txt", path.join(root, "link.txt"), "file");
    await expect(tool.execute("link", {
      input: "*** Begin Patch\n*** Add File: earlier.txt\n+not written\n*** Update File: link.txt\n@@\n-before\n+after\n*** End Patch",
    }, undefined, undefined, ctx)).rejects.toThrow("Cannot patch symbolic link: link.txt");
    expect(entries).toEqual([]);
    await expect(fs.readlink(path.join(root, "link.txt"))).resolves.toBe("target.txt");
    await expect(fs.access(path.join(root, "earlier.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    if (!dangling) {
      await expect(fs.readFile(path.join(root, "target.txt"), "utf8")).resolves.toBe("before\n");
    }
  });

  it("reports completed writes when after-snapshot capture fails", async () => {
    const { tool, ctx, entries } = await createPatchHarness(root);
    const target = path.join(root, "saved.txt");
    let written = false;
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(to) === target) written = true;
    });
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation(async (file) => {
      if (written && String(file) === target) throw new Error("snapshot read blocked");
      return stat(file);
    });
    await expect(tool.execute("snapshot", {
      input: "*** Begin Patch\n*** Add File: saved.txt\n+saved\n*** End Patch",
    }, undefined, undefined, ctx)).rejects.toThrow(
      "File operations completed for: saved.txt\nCheckpoint capture failed: snapshot read blocked\nNo checkpoint was created",
    );
    expect(entries).toEqual([]);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("saved\n");
  });

  it("reports unconfirmed checkpoint persistence while retaining session undo", async () => {
    const { tool, ctx, entries, appendEntry, undo } = await createPatchHarness(root);
    appendEntry.mockImplementationOnce(() => { throw new Error("session write blocked"); });
    const error = await tool.execute("persist", {
      input: "*** Begin Patch\n*** Add File: saved.txt\n+saved\n*** End Patch",
    }, undefined, undefined, ctx).catch((error: unknown) => error);
    expect((error as Error).message).toContain("File operations completed for: saved.txt");
    expect((error as Error).message).toContain("session write blocked");
    expect((error as Error).message).toContain("Checkpoint persistence was not confirmed. /undo remains available in this session.");
    expect(entries).toEqual([]);
    await expect(fs.readFile(path.join(root, "saved.txt"), "utf8")).resolves.toBe("saved\n");
    await undo("", ctx);
    await expect(fs.access(path.join(root, "saved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves validation errors before file operations begin", async () => {
    const { tool, ctx, entries } = await createPatchHarness(root);
    await expect(tool.execute("invalid", {
      input: "*** Add File: invalid.txt\n+invalid",
    }, undefined, undefined, ctx)).rejects.toThrow(/^Patch must start with \*\*\* Begin Patch$/);
    expect(entries).toEqual([]);
    await expect(fs.access(path.join(root, "invalid.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not apply or checkpoint the valid prefix of a patch with trailing directives", async () => {
    const { tool, ctx, entries } = await createPatchHarness(root);
    await expect(tool.execute("trailing", {
      input: "*** Begin Patch\n*** Add File: first.txt\n+first\n*** End Patch\n*** Add File: ignored.txt\n+ignored",
    }, undefined, undefined, ctx)).rejects.toThrow("Patch contains unexpected content after *** End Patch");
    expect(entries).toEqual([]);
    await expect(fs.access(path.join(root, "first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(root, "ignored.txt"))).rejects.toMatchObject({ code: "ENOENT" });
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

async function createPatchHarness(root: string, entries: Array<{ customType: string; data: unknown }> = []) {
  const tools = new Map<string, ToolDefinition>();
  type Command = {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
  };
  const commands = new Map<string, Command>();
  const handlers = new Map<string, Array<(event: ExtensionEvent, ctx: ExtensionContext) => unknown>>();
  const appendEntry = vi.fn((customType: string, data: unknown) => { entries.push({ customType, data }); });
  const pi = new Proxy({
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    on(name: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    appendEntry,
    getActiveTools: () => ["apply_patch"],
    getAllTools: () => [...tools.values()],
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as ExtensionAPI;
  const notify = vi.fn();
  const ctx = {
    cwd: root, mode: "rpc", hasUI: true,
    ui: new Proxy({ notify, confirm: async () => true, theme: createTestTheme() }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined,
    }),
    isProjectTrusted: () => true,
    sessionManager: {
      getBranch: () => entries.map((entry) => ({ type: "custom", ...entry })),
      getSessionFile: () => undefined,
      buildSessionProjection: () => ({ messages: [] }),
    },
  } as unknown as ExtensionToolContext;
  const extension = createDSCodeExtension(parseRuntimeArgs(["-C", root, "--no-mcp", "--permission", "auto"]).options);
  await (typeof extension === "function" ? extension(pi) : extension.factory(pi));
  const tool = tools.get("apply_patch")!;
  const emit = async (event: ExtensionEvent) => {
    for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx);
  };
  const settle = async (aborted = false) => {
    await emit({ type: "agent_end", messages: [] });
    await emit({ type: "agent_settled", aborted });
  };
  const patch = async (file: string) => {
    const result = await tool.execute(file, {
      input: `*** Begin Patch\n*** Add File: ${file}\n+saved\n*** End Patch`,
    }, undefined, undefined, ctx);
    return (result.details as { checkpointId: string }).checkpointId;
  };
  return { tool, ctx, entries, appendEntry, notify, commands, emit, settle, patch,
    undo: commands.get("undo")!.handler, list: commands.get("checkpoints")!.handler };
}
