import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyWorkspacePatch } from "../packages/core/src/patch.js";
import { Workspace } from "../packages/core/src/workspace.js";

describe("applyWorkspacePatch", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-patch-"));
    workspace = new Workspace(root);
    await workspace.initialize();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("adds, updates, moves, and deletes files", async () => {
    await fs.writeFile(path.join(root, "value.txt"), "alpha\nbeta\ngamma\n");
    await fs.writeFile(path.join(root, "remove.txt"), "remove me\n");

    const result = await applyWorkspacePatch(
      workspace,
      [
        "*** Begin Patch",
        "*** Update File: value.txt",
        "*** Move to: moved.txt",
        "@@",
        " alpha",
        "-beta",
        "+BETA",
        " gamma",
        "*** Add File: added.txt",
        "+new file",
        "*** Delete File: remove.txt",
        "*** End Patch",
      ].join("\n"),
    );

    await expect(fs.readFile(path.join(root, "moved.txt"), "utf8")).resolves.toBe(
      "alpha\nBETA\ngamma\n",
    );
    await expect(fs.readFile(path.join(root, "added.txt"), "utf8")).resolves.toBe("new file\n");
    await expect(fs.access(path.join(root, "value.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(root, "remove.txt"))).rejects.toThrow();
    expect(result).toMatchObject({ additions: 2, deletions: 2 });
  });

  it("validates every hunk before mutating the workspace", async () => {
    await fs.writeFile(path.join(root, "value.txt"), "original\n");
    await expect(
      applyWorkspacePatch(
        workspace,
        [
          "*** Begin Patch",
          "*** Add File: should-not-exist.txt",
          "+new",
          "*** Update File: value.txt",
          "@@",
          "-missing",
          "+replacement",
          "*** End Patch",
        ].join("\n"),
      ),
    ).rejects.toThrow("Patch context not found");

    await expect(fs.access(path.join(root, "should-not-exist.txt"))).rejects.toThrow();
    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("original\n");
  });

  it("rejects paths outside the workspace", async () => {
    await expect(
      applyWorkspacePatch(
        workspace,
        "*** Begin Patch\n*** Add File: ../outside.txt\n+bad\n*** End Patch",
      ),
    ).rejects.toThrow("workspace-relative");
  });
});
