import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capturePatchCheckpoint, restoreCheckpoint } from "../packages/core/src/checkpoint.js";
import { applyWorkspacePatch } from "../packages/core/src/patch.js";
import { Workspace } from "../packages/core/src/workspace.js";

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
