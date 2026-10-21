import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatchBudget, readPatchFile } from "../packages/core/src/patch-limits.ts";
import { applyWorkspacePatch } from "../packages/core/src/patch.ts";
import { Workspace } from "../packages/core/src/workspace.ts";

describe("patch preparation cancellation", () => {
  let root: string;
  let workspace: Workspace;
  let controller: AbortController;
  const reason = new Error("cancel requested");

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-patch-cancel-"));
    workspace = new Workspace(root);
    await workspace.initialize();
    controller = new AbortController();
    await fs.writeFile(path.join(root, "value.txt"), "before\n");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects an already cancelled patch before touching files", async () => {
    controller.abort(reason);
    await expect(applyWorkspacePatch(workspace,
      "*** Begin Patch\n*** Delete File: value.txt\n*** End Patch", undefined, controller.signal,
    )).rejects.toBe(reason);
    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("before\n");
  });

  it.each(["write", "delete"] as const)("checks cancellation after final path validation before the first %s", async (kind) => {
    const resolve = workspace.resolvePatchPath.bind(workspace);
    vi.spyOn(workspace, "resolvePatchPath").mockImplementation(async (userPath, allowMissing) => {
      const absolute = await resolve(userPath, allowMissing);
      if (userPath === path.join(root, "value.txt")) controller.abort(reason);
      return absolute;
    });
    await expect(applyWorkspacePatch(workspace, [
      "*** Begin Patch",
      ...(kind === "write" ? ["*** Update File: value.txt", "@@", "-before", "+after"] : ["*** Delete File: value.txt"]),
      "*** Add File: later.txt", "+later", "*** End Patch",
    ].join("\n"), undefined, controller.signal)).rejects.toBe(reason);
    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("before\n");
    await expect(fs.access(path.join(root, "later.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["open", "stat", "read"] as const)("closes the preparation handle when cancelled during %s", async (phase) => {
    const file = path.join(root, "value.txt");
    const handle = await fs.open(file, "r");
    const stat = handle.stat.bind(handle);
    const read = handle.read.bind(handle);
    const close = vi.spyOn(handle, "close");
    vi.spyOn(fs, "open").mockImplementationOnce(async () => {
      if (phase === "open") controller.abort(reason);
      return handle;
    });
    vi.spyOn(handle, "stat").mockImplementation(async (...args) => {
      const result = await stat(...args);
      if (phase === "stat") controller.abort(reason);
      return result;
    });
    const readSpy = vi.spyOn(handle, "read").mockImplementation(async (...args) => {
      const result = await read(...args);
      controller.abort(reason);
      return result;
    });
    await expect(readPatchFile(file, "value.txt", new PatchBudget(), controller.signal)).rejects.toBe(reason);
    if (phase !== "read") expect(readSpy).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    await expect(fs.readFile(file, "utf8")).resolves.toBe("before\n");
  });

  it("waits for an in-flight read before closing and reporting cancellation", async () => {
    const file = path.join(root, "value.txt");
    const handle = await fs.open(file, "r");
    const read = handle.read.bind(handle);
    const close = vi.spyOn(handle, "close");
    vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(handle, "read").mockImplementationOnce(async (...args) => {
      started();
      await gate;
      return read(...args);
    });
    let settled = false;
    const result = readPatchFile(file, "value.txt", new PatchBudget(), controller.signal)
      .finally(() => { settled = true; });
    await reading;
    controller.abort(reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    release();
    await expect(result).rejects.toBe(reason);
    expect(close).toHaveBeenCalledOnce();
  });
});
