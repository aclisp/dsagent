import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturePatchCheckpoint, restoreCheckpoint } from "../packages/core/src/checkpoint.ts";
import { applyWorkspacePatch } from "../packages/core/src/patch.ts";
import { Workspace } from "../packages/core/src/workspace.ts";

describe("patch checkpoints", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-checkpoint-"));
    workspace = new Workspace(root);
    await workspace.initialize();
    await fs.writeFile(path.join(root, "existing.txt"), "before\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("restores modified and newly created files", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      "-before",
      "+after",
      "*** Add File: new.txt",
      "+created",
      "*** End Patch",
    ].join("\n");
    const checkpoint = await capturePatchCheckpoint(workspace, patch, async () => {
      await applyWorkspacePatch(workspace, patch);
    });

    await restoreCheckpoint(workspace, checkpoint);
    await expect(fs.readFile(path.join(root, "existing.txt"), "utf8")).resolves.toBe("before\n");
    await expect(fs.access(path.join(root, "new.txt"))).rejects.toThrow();
  });

  it("captures parsed sources and move targets once, excluding directive-like file content", async () => {
    await fs.writeFile(path.join(root, "removed.txt"), "removed\n");
    const patch = [
      "*** Begin Patch", "*** Add File: new.txt",
      "+*** Update File: phantom-update.txt", "+*** Move to: phantom-move.txt",
      "+*** Delete File: phantom-delete.txt", "+*** End Patch",
      "*** Update File: existing.txt", "@@", "-before", "+after",
      "*** Update File: existing.txt", "*** Move to: moved.txt",
      "*** Delete File: removed.txt", "*** End Patch", " \t", "",
    ].join("\r\n");
    const checkpoint = await capturePatchCheckpoint(workspace, patch, async () => {
      await applyWorkspacePatch(workspace, patch);
    });
    const expectedPaths = ["new.txt", "existing.txt", "moved.txt", "removed.txt"];
    expect(checkpoint.before.map((snapshot) => snapshot.path)).toEqual(expectedPaths);
    expect(checkpoint.after.map((snapshot) => snapshot.path)).toEqual(expectedPaths);
    expect(checkpoint.before.map((snapshot) => snapshot.content)).toEqual([null, "before\n", null, "removed\n"]);
    expect(checkpoint.after.map((snapshot) => snapshot.content)).toEqual([
      "*** Update File: phantom-update.txt\n*** Move to: phantom-move.txt\n*** Delete File: phantom-delete.txt\n*** End Patch\n",
      null, "after\n", null,
    ]);
    await restoreCheckpoint(workspace, checkpoint);
    await expect(fs.readFile(path.join(root, "existing.txt"), "utf8")).resolves.toBe("before\n");
    await expect(fs.readFile(path.join(root, "removed.txt"), "utf8")).resolves.toBe("removed\n");
    await expect(fs.access(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(root, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a malformed patch before taking snapshots or invoking the writer", async () => {
    const resolve = vi.spyOn(workspace, "resolvePatchPath");
    const apply = vi.fn(async () => {});
    try {
      await expect(capturePatchCheckpoint(workspace, [
        "*** Begin Patch", "*** Update File: existing.txt", "@@", "-before", "+after",
        "*** End Patch", "*** Add File: ignored.txt", "+ignored",
      ].join("\n"), apply)).rejects.toThrow("Patch contains unexpected content after *** End Patch");
      expect(resolve).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(root, "existing.txt"), "utf8")).resolves.toBe("before\n");
    } finally {
      resolve.mockRestore();
    }
  });

  it.each([false, true])("refuses to replace a symbolic link during undo (force: %s)", async (force) => {
    const patch = [
      "*** Begin Patch", "*** Add File: new.txt", "+created",
      "*** Update File: existing.txt", "@@", "-before", "+after", "*** End Patch",
    ].join("\n");
    const checkpoint = await capturePatchCheckpoint(workspace, patch, async () => {
      await applyWorkspacePatch(workspace, patch);
    });
    // Identical text would pass the ordinary content conflict check.
    await fs.writeFile(path.join(root, "target.txt"), "after\n");
    await fs.rm(path.join(root, "existing.txt"));
    await fs.symlink("target.txt", path.join(root, "existing.txt"), "file");

    await expect(restoreCheckpoint(workspace, checkpoint, force)).rejects.toThrow(
      "Cannot patch symbolic link: existing.txt",
    );
    await expect(fs.readlink(path.join(root, "existing.txt"))).resolves.toBe("target.txt");
    await expect(fs.readFile(path.join(root, "target.txt"), "utf8")).resolves.toBe("after\n");
    await expect(fs.readFile(path.join(root, "new.txt"), "utf8")).resolves.toBe("created\n");
  });

  it("protects edits made after the checkpoint", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: existing.txt",
      "@@",
      "-before",
      "+after",
      "*** End Patch",
    ].join("\n");
    const checkpoint = await capturePatchCheckpoint(workspace, patch, async () => {
      await applyWorkspacePatch(workspace, patch);
    });
    await fs.writeFile(path.join(root, "existing.txt"), "newer user edit\n");

    await expect(restoreCheckpoint(workspace, checkpoint)).rejects.toThrow(
      "changed after the checkpoint",
    );
    await expect(fs.readFile(path.join(root, "existing.txt"), "utf8")).resolves.toBe(
      "newer user edit\n",
    );
  });
});
