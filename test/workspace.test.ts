import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../packages/core/src/workspace.ts";

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

  it.each(["resolve", "resolvePatchPath"] as const)("%s accepts names beginning with two dots", async (method) => {
    await fs.writeFile(path.join(root, "..notes"), "notes");
    await fs.mkdir(path.join(root, "..directory"));
    await fs.writeFile(path.join(root, "..directory/existing.txt"), "existing");

    for (const file of ["..notes", "..directory/existing.txt", "nested/../..notes"]) {
      await expect(workspace[method](file)).resolves.toBe(path.resolve(root, file));
    }
    for (const file of ["..new", "..directory/new.txt", "..missing/nested/new.txt"]) {
      await expect(workspace[method](file, true)).resolves.toBe(path.join(root, file));
    }
  });

  it.each(["..", "../secret.txt", "../../secret.txt"])("rejects lexical traversal: %s", async (file) => {
    await expect(workspace.resolve(file, true)).rejects.toThrow("escapes workspace");
    await expect(workspace.resolvePatchPath(file, true)).rejects.toThrow("escapes workspace");
  });

  it("rejects symlinks that escape the workspace", async () => {
    await fs.writeFile(path.join(outside, "existing.txt"), "outside");
    await fs.symlink(outside, path.join(root, "outside"));
    await fs.symlink(path.dirname(root), path.join(root, "parent"));
    for (const file of ["outside/existing.txt", "outside/new.txt", "parent"]) {
      await expect(workspace.resolve(file, true)).rejects.toThrow("resolves outside workspace");
      await expect(workspace.resolvePatchPath(file, true)).rejects.toThrow("resolves outside workspace");
    }
  });

  it("accepts directory aliases whose real path begins with two dots", async () => {
    await fs.mkdir(path.join(root, "..directory"));
    await fs.writeFile(path.join(root, "..directory/existing.txt"), "existing");
    await fs.symlink(path.join(root, "..directory"), path.join(root, "alias"));
    await expect(workspace.resolvePatchPath("alias/existing.txt")).resolves.toBe(
      path.join(root, "alias/existing.txt"),
    );
    await expect(workspace.resolvePatchPath("alias/new.txt", true)).resolves.toBe(
      path.join(root, "alias/new.txt"),
    );
  });
});

