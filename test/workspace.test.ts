import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../packages/core/src/workspace.js";

describe("Workspace", () => {
  let root: string;
  let outside: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-workspace-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-outside-"));
    workspace = new Workspace(root);
    await workspace.initialize();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("resolves existing and new paths in the workspace", async () => {
    await fs.writeFile(path.join(root, "hello.ts"), "hello");
    await expect(workspace.resolve("hello.ts")).resolves.toBe(path.join(root, "hello.ts"));
    await expect(workspace.resolve("src/new.ts", true)).resolves.toBe(path.join(root, "src/new.ts"));
  });

  it("rejects lexical traversal", async () => {
    await expect(workspace.resolve("../secret.txt", true)).rejects.toThrow("escapes workspace");
  });

  it("rejects symlinks that escape the workspace", async () => {
    await fs.symlink(outside, path.join(root, "outside"));
    await expect(workspace.resolve("outside/file.txt", true)).rejects.toThrow(
      "resolves outside workspace",
    );
  });
});

