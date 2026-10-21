import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturePatchCheckpoint, restoreCheckpoint } from "../packages/core/src/checkpoint.ts";
import { PATCH_LIMITS, PatchBudget, readPatchFile } from "../packages/core/src/patch-limits.ts";
import { applyWorkspacePatch } from "../packages/core/src/patch.ts";
import { Workspace } from "../packages/core/src/workspace.ts";

const defaults = { ...PATCH_LIMITS };
const patch = (...lines: string[]): string => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

describe("patch capacity limits", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    Object.assign(PATCH_LIMITS, { inputBytes: 512, fileBytes: 16, totalBytes: 64 });
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-patch-limits-"));
    workspace = new Workspace(root);
    await workspace.initialize();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    Object.assign(PATCH_LIMITS, defaults);
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each([0, 1])("enforces the input boundary (extra bytes: %s)", async (extra) => {
    const input = patch("*** Add File: new.txt", "+x") + "\n";
    const padded = input + " ".repeat(PATCH_LIMITS.inputBytes - Buffer.byteLength(input) + extra);
    if (extra) {
      await expect(applyWorkspacePatch(workspace, padded)).rejects.toThrow("Patch input is 513 bytes; limit is 512 bytes");
      await expect(fs.access(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await applyWorkspacePatch(workspace, padded);
      await expect(fs.readFile(path.join(root, "new.txt"), "utf8")).resolves.toBe("x\n");
    }
  });

  it("counts UTF-8 bytes rather than characters in patch input", async () => {
    const input = patch("*** Add File: new.txt", "+中文");
    PATCH_LIMITS.inputBytes = input.length;
    await expect(applyWorkspacePatch(workspace, input)).rejects.toThrow(`Patch input is ${Buffer.byteLength(input)} bytes`);
    await expect(fs.access(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([16, 17])("checks original file size before writes: %s bytes", async (bytes) => {
    const content = "a".repeat(bytes - 1) + "\n";
    await fs.writeFile(path.join(root, "value.txt"), content);
    const input = patch("*** Add File: first.txt", "+x", "*** Delete File: value.txt");
    if (bytes === 16) {
      await applyWorkspacePatch(workspace, input);
      await expect(fs.access(path.join(root, "value.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(applyWorkspacePatch(workspace, input)).rejects.toThrow("Cannot patch value.txt: 17 bytes exceeds the per-file limit of 16 bytes");
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(content);
      await expect(fs.access(path.join(root, "first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("checks generated file size including UTF-8 and its final newline", async () => {
    PATCH_LIMITS.fileBytes = 6;
    await expect(applyWorkspacePatch(workspace, patch("*** Add File: new.txt", "+中文")))
      .rejects.toThrow("Cannot patch new.txt: 7 bytes exceeds the per-file limit of 6 bytes");
    await expect(fs.access(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([16, 17])("checks newly generated file size: %s bytes", async (bytes) => {
    const input = patch("*** Add File: new.txt", "+" + "x".repeat(bytes - 1));
    if (bytes === 16) {
      await applyWorkspacePatch(workspace, input);
      await expect(fs.readFile(path.join(root, "new.txt"))).resolves.toHaveLength(16);
    } else {
      await expect(applyWorkspacePatch(workspace, input)).rejects.toThrow("per-file limit");
      await expect(fs.access(path.join(root, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects an oversized updated file before earlier operations run", async () => {
    await fs.writeFile(path.join(root, "value.txt"), "a".repeat(15) + "\n");
    await expect(applyWorkspacePatch(workspace, patch(
      "*** Add File: first.txt", "+x", "*** Update File: value.txt", "@@",
      "-" + "a".repeat(15), "+" + "b".repeat(16),
    ))).rejects.toThrow("Cannot patch value.txt: 17 bytes exceeds the per-file limit of 16 bytes");
    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("a".repeat(15) + "\n");
    await expect(fs.access(path.join(root, "first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([13, 14])("combines original snapshots and planned writes without double charging reads: %s bytes", async (limit) => {
    PATCH_LIMITS.totalBytes = limit;
    await fs.writeFile(path.join(root, "value.txt"), "before\n");
    const input = patch("*** Update File: value.txt", "@@", "-before", "+after!");
    const capture = () => capturePatchCheckpoint(workspace, input, async (budget) => {
      await applyWorkspacePatch(workspace, input, budget);
    });
    if (limit === 13) {
      await expect(capture()).rejects.toThrow("14 bytes exceeds the limit of 13 bytes");
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("before\n");
    } else {
      const checkpoint = await capture();
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("after!\n");
      await restoreCheckpoint(workspace, checkpoint);
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("before\n");
    }
  });

  it("rejects many small files whose combined originals and writes exceed the budget", async () => {
    PATCH_LIMITS.totalBytes = 55;
    const actions: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      await fs.writeFile(path.join(root, `${index}.txt`), "before\n");
      actions.push(`*** Update File: ${index}.txt`, "@@", "-before", "+after!");
    }
    await expect(applyWorkspacePatch(workspace, patch(...actions)))
      .rejects.toThrow("56 bytes exceeds the limit of 55 bytes");
    for (let index = 0; index < 4; index += 1) {
      await expect(fs.readFile(path.join(root, `${index}.txt`), "utf8")).resolves.toBe("before\n");
    }
  });

  it("bounds the combined before snapshots without invoking the writer", async () => {
    PATCH_LIMITS.totalBytes = 13;
    await fs.writeFile(path.join(root, "a.txt"), "before\n");
    await fs.writeFile(path.join(root, "b.txt"), "before\n");
    const apply = vi.fn(async () => {});
    await expect(capturePatchCheckpoint(workspace, patch("*** Delete File: a.txt", "*** Delete File: b.txt"), apply))
      .rejects.toThrow("14 bytes exceeds the limit of 13 bytes");
    expect(apply).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(root, "a.txt"), "utf8")).resolves.toBe("before\n");
    await expect(fs.readFile(path.join(root, "b.txt"), "utf8")).resolves.toBe("before\n");
  });

  it("coalesces ordinary repeated updates within the budget", async () => {
    PATCH_LIMITS.totalBytes = 8;
    await fs.writeFile(path.join(root, "value.txt"), "old\n");
    await applyWorkspacePatch(workspace, patch(
      "*** Update File: value.txt", "@@", "-old", "+mid",
      "*** Update File: value.txt", "@@", "-mid", "+new",
    ));
    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("new\n");
  });

  it.each(["file", "total"] as const)("validates saved undo contents against the %s limit before modifying files", async (kind) => {
    await fs.writeFile(path.join(root, "value.txt"), "before\n");
    const input = patch("*** Add File: new.txt", "+x", "*** Update File: value.txt", "@@", "-before", "+x");
    const checkpoint = await capturePatchCheckpoint(workspace, input, async (budget) => {
      await applyWorkspacePatch(workspace, input, budget);
    });
    if (kind === "file") PATCH_LIMITS.fileBytes = 6;
    else PATCH_LIMITS.totalBytes = 10;
    await expect(restoreCheckpoint(workspace, checkpoint, true))
      .rejects.toThrow(kind === "file" ? "per-file limit" : "Patch content budget exceeded");
    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("x\n");
    await expect(fs.readFile(path.join(root, "new.txt"), "utf8")).resolves.toBe("x\n");
  });

  it.each([19, 20])("counts intermediate writes in a move chain: %s bytes", async (limit) => {
    PATCH_LIMITS.totalBytes = limit;
    await fs.writeFile(path.join(root, "old.txt"), "keep\n");
    await fs.writeFile(path.join(root, "middle.txt"), "gone\n");
    const input = patch("*** Delete File: middle.txt", "*** Update File: old.txt", "*** Move to: middle.txt",
      "*** Update File: middle.txt", "*** Move to: final.txt");
    if (limit === 19) {
      await expect(applyWorkspacePatch(workspace, input)).rejects.toThrow("20 bytes exceeds the limit of 19 bytes");
      await expect(fs.readFile(path.join(root, "old.txt"), "utf8")).resolves.toBe("keep\n");
      await expect(fs.readFile(path.join(root, "middle.txt"), "utf8")).resolves.toBe("gone\n");
      await expect(fs.access(path.join(root, "final.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await applyWorkspacePatch(workspace, input);
      await expect(fs.access(path.join(root, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(root, "middle.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(root, "final.txt"), "utf8")).resolves.toBe("keep\n");
    }
  });

  it("rejects an oversized file from metadata without reading it and closes the handle", async () => {
    const file = path.join(root, "value.txt");
    await fs.writeFile(file, "x".repeat(17));
    const handle = await fs.open(file, "r");
    const read = vi.spyOn(handle, "read");
    const close = vi.spyOn(handle, "close");
    vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
    await expect(readPatchFile(file, "value.txt", new PatchBudget())).rejects.toThrow("per-file limit");
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["file", "total"] as const)("bounds growing files while reading against the %s limit", async (kind) => {
    const file = path.join(root, "value.txt");
    const budget = new PatchBudget(kind === "total" ? 60 : 0);
    await fs.writeFile(file, "x".repeat(100));
    const handle = await fs.open(file, "r");
    const stat = await handle.stat();
    stat.size = 1;
    vi.spyOn(handle, "stat").mockResolvedValue(stat);
    const read = vi.spyOn(handle, "read");
    const close = vi.spyOn(handle, "close");
    vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
    await expect(readPatchFile(file, "value.txt", budget)).rejects.toThrow(kind === "file" ? "per-file limit" : "Patch content budget exceeded");
    const firstRead = await read.mock.results[0]?.value;
    expect(firstRead?.bytesRead).toBe(kind === "file" ? 17 : 5);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the file handle when reading fails", async () => {
    const file = path.join(root, "value.txt");
    await fs.writeFile(file, "x");
    const handle = await fs.open(file, "r");
    vi.spyOn(handle, "read").mockRejectedValueOnce(new Error("read failed"));
    const close = vi.spyOn(handle, "close");
    vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
    await expect(readPatchFile(file, "value.txt", new PatchBudget())).rejects.toThrow("read failed");
    expect(close).toHaveBeenCalledOnce();
  });
});
