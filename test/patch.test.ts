import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyWorkspacePatch, PatchApplicationError } from "../packages/core/src/patch.ts";
import { Workspace } from "../packages/core/src/workspace.ts";

describe("applyWorkspacePatch", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-patch-"));
    workspace = new Workspace(root);
    await workspace.initialize();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe.each(["\n", "\r\n"])("patch termination with %j endings", (ending) => {
    it.each([
      "extra text",
      "*** Add File: ignored.txt\n+ignored",
      "*** Begin Patch\n*** Add File: ignored.txt\n+ignored\n*** End Patch",
      "*** End Patch",
      "\n \t\nextra text",
    ])("rejects trailing content without applying the valid prefix: %j", async (trailing) => {
      await fs.writeFile(path.join(root, "value.txt"), "before\n");
      await expect(applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Add File: first.txt", "+not written",
        "*** Update File: value.txt", "@@", "-before", "+after", "*** End Patch", trailing,
      ].join("\n").replaceAll("\n", ending))).rejects.toThrow(
        "Patch contains unexpected content after *** End Patch",
      );
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("before\n");
      await expect(fs.access(path.join(root, "first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(root, "ignored.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["", "\n", "\n \t\n"])("accepts a whitespace-only suffix: %j", async (suffix) => {
      const result = await applyWorkspacePatch(workspace, (
        "*** Begin Patch\n*** Add File: added.txt\n+content  \n*** End Patch" + suffix
      ).replaceAll("\n", ending));
      expect(result).toEqual({ files: ["added.txt"], additions: 1, deletions: 0 });
      await expect(fs.readFile(path.join(root, "added.txt"), "utf8")).resolves.toBe("content  \n");
    });
  });

  it.each(["write", "rename", "delete"] as const)("reports completed operations when a later %s fails", async (failureKind) => {
    await fs.writeFile(path.join(root, "removed.txt"), "remove me\n");
    const failedPath = path.join(root, "failed.txt");
    await fs.writeFile(failedPath, "before\n");
    const failure = new Error("simulated filesystem failure");
    if (failureKind === "write") {
      const writeFile = fs.writeFile.bind(fs);
      vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
        if (String(file).includes(".failed.txt.dscode-")) throw failure;
        return writeFile(file, data, options);
      });
    } else if (failureKind === "rename") {
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(to) === failedPath) throw failure;
        return rename(from, to);
      });
    } else {
      const rm = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
        if (String(file) === failedPath) throw failure;
        return rm(file, options);
      });
    }
    const error = await applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Add File: first.txt", "+saved", "*** Delete File: removed.txt",
      ...(failureKind === "delete" ? ["*** Delete File: failed.txt"] : ["*** Update File: failed.txt", "@@", "-before", "+after"]),
      "*** Add File: later.txt", "+not attempted", "*** End Patch",
    ].join("\n")).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(PatchApplicationError);
    expect(error).toMatchObject({ cause: failure, message: expect.stringContaining("simulated filesystem failure") });
    expect((error as Error).message).toContain(`${failureKind === "delete" ? "delete" : "write"} failed.txt`);
    expect((error as Error).message).toContain("- write first.txt\n- delete removed.txt");
    expect((error as Error).message).toContain("not rolled back");
    expect((error as Error).message).toContain("failed operation's state was not verified");
    await expect(fs.readFile(path.join(root, "first.txt"), "utf8")).resolves.toBe("saved\n");
    await expect(fs.access(path.join(root, "removed.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(failedPath, "utf8")).resolves.toBe("before\n");
    await expect(fs.access(path.join(root, "later.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports no completed operations when the first file operation fails", async () => {
    const failure = new Error("rename blocked");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
    const error = await applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Add File: first.txt", "+not saved",
      "*** Add File: later.txt", "+not attempted", "*** End Patch",
    ].join("\n")).catch((error: unknown) => error);
    expect(error).toMatchObject({ cause: failure, message: expect.stringContaining("File operations completed before failure:\n(none)") });
    await expect(fs.access(path.join(root, "first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(root, "later.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["mkdir", "write", "chmod", "rename"] as const)("preserves the move source when destination %s fails", async (failureKind) => {
    await fs.writeFile(path.join(root, "old.txt"), "before\n");
    const destination = path.join(root, "nested/moved.txt");
    const failure = new Error("destination blocked");
    if (failureKind === "mkdir") {
      vi.spyOn(fs, "mkdir").mockRejectedValueOnce(failure);
    } else if (failureKind === "write") {
      vi.spyOn(fs, "writeFile").mockRejectedValueOnce(failure);
    } else if (failureKind === "chmod") {
      vi.spyOn(fs, "chmod").mockRejectedValueOnce(failure);
    } else {
      vi.spyOn(fs, "rename").mockRejectedValueOnce(failure);
    }
    const error = await applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Update File: old.txt", "*** Move to: nested/moved.txt",
      "@@", "-before", "+after", "*** Add File: later.txt", "+not attempted", "*** End Patch",
    ].join("\n")).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PatchApplicationError);
    expect(error).toMatchObject({ cause: failure });
    expect((error as Error).message).toContain(`write ${path.join("nested", "moved.txt")}: destination blocked`);
    expect((error as Error).message).toContain("File operations completed before failure:\n(none)");
    await expect(fs.readFile(path.join(root, "old.txt"), "utf8")).resolves.toBe("before\n");
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(root, "later.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(root, { recursive: true })).resolves.not.toEqual(
      expect.arrayContaining([expect.stringContaining(".dscode-")]),
    );
  });

  it.skipIf(process.platform === "win32").each([
    { name: "update", moves: [], target: "script.sh", edit: true },
    { name: "move", moves: ["nested/script.sh"], target: "nested/script.sh", edit: false },
    { name: "edit and move", moves: ["nested/script.sh"], target: "nested/script.sh", edit: true },
    { name: "chained moves", moves: ["middle.sh", "nested/script.sh"], target: "nested/script.sh", edit: true },
    { name: "same-path move", moves: ["script.sh"], target: "script.sh", edit: true },
  ])("preserves ordinary executable permissions across $name", async ({ moves, target, edit }) => {
    const source = path.join(root, "script.sh");
    await fs.writeFile(source, "#!/bin/sh\necho before\n");
    // Group write also detects accidental filtering by the common umask 022.
    await fs.chmod(source, 0o775);
    const actions = ["*** Update File: script.sh"];
    if (moves.length) actions.push(`*** Move to: ${moves[0]}`);
    if (edit) actions.push("@@", "-echo before", "+echo after");
    for (let index = 1; index < moves.length; index++) {
      actions.push(`*** Update File: ${moves[index - 1]}`, `*** Move to: ${moves[index]}`);
    }
    await applyWorkspacePatch(workspace, ["*** Begin Patch", ...actions, "*** End Patch"].join("\n"));

    const destination = path.join(root, target);
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o775);
    await expect(fs.readFile(destination, "utf8")).resolves.toBe(
      `#!/bin/sh\necho ${edit ? "after" : "before"}\n`,
    );
    for (const file of new Set(["script.sh", ...moves])) {
      if (file !== target) await expect(fs.access(path.join(root, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.skipIf(process.platform === "win32")("keeps moved permissions separate from a recreated source", async () => {
    const source = path.join(root, "script.sh");
    await fs.writeFile(source, "original\n");
    await fs.chmod(source, 0o775);
    await fs.writeFile(path.join(root, "default.txt"), "default\n");
    const defaultMode = (await fs.stat(path.join(root, "default.txt"))).mode & 0o777;
    await applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Update File: script.sh", "*** Move to: moved.sh",
      "*** Add File: script.sh", "+new", "*** Update File: script.sh", "*** Move to: new.sh",
      "*** End Patch",
    ].join("\n"));
    expect((await fs.stat(path.join(root, "moved.sh"))).mode & 0o777).toBe(0o775);
    expect((await fs.stat(path.join(root, "new.sh"))).mode & 0o777).toBe(defaultMode);
    await expect(fs.readFile(path.join(root, "new.sh"), "utf8")).resolves.toBe("new\n");
    await expect(fs.access(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains both files and reports the saved destination when source deletion fails", async () => {
    const source = path.join(root, "old.txt");
    await fs.writeFile(source, "before\n");
    const rm = fs.rm.bind(fs);
    const failure = new Error("source deletion blocked");
    vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (String(file) === source) throw failure;
      return rm(file, options);
    });
    const error = await applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Update File: old.txt", "*** Move to: moved.txt", "@@", "-before", "+after",
      "*** Add File: later.txt", "+not attempted", "*** End Patch",
    ].join("\n")).catch((error: unknown) => error);
    expect(error).toMatchObject({ cause: failure });
    expect((error as Error).message).toContain("delete old.txt: source deletion blocked");
    expect((error as Error).message).toContain("File operations completed before failure:\n- write moved.txt");
    expect((error as Error).message).not.toContain("- delete old.txt");
    await expect(fs.readFile(source, "utf8")).resolves.toBe("before\n");
    await expect(fs.readFile(path.join(root, "moved.txt"), "utf8")).resolves.toBe("after\n");
    await expect(fs.access(path.join(root, "later.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saves the moved contents before recreating the source path", async () => {
    await fs.writeFile(path.join(root, "old.txt"), "before\n");
    const result = await applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Update File: old.txt", "*** Move to: moved.txt",
      "*** Add File: old.txt", "+recreated", "*** End Patch",
    ].join("\n"));
    expect(result).toEqual({ files: ["old.txt", "moved.txt"], additions: 1, deletions: 0 });
    await expect(fs.readFile(path.join(root, "old.txt"), "utf8")).resolves.toBe("recreated\n");
    await expect(fs.readFile(path.join(root, "moved.txt"), "utf8")).resolves.toBe("before\n");
  });

  it.each([false, true])("executes chained moves in order (final write failure: %s)", async (fail) => {
    await fs.writeFile(path.join(root, "old.txt"), "before\n");
    await fs.writeFile(path.join(root, "middle.txt"), "discard\n");
    if (fail) {
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(to) === path.join(root, "final.txt")) throw new Error("final destination blocked");
        return rename(from, to);
      });
    }
    const outcome = await applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Delete File: middle.txt",
      "*** Update File: old.txt", "*** Move to: middle.txt", "@@", "-before", "+after",
      "*** Update File: middle.txt", "*** Move to: final.txt", "*** End Patch",
    ].join("\n")).catch((error: unknown) => error);
    await expect(fs.access(path.join(root, "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    if (fail) {
      expect(outcome).toBeInstanceOf(PatchApplicationError);
      expect((outcome as Error).message).toContain("- delete middle.txt\n- write middle.txt\n- delete old.txt");
      await expect(fs.readFile(path.join(root, "middle.txt"), "utf8")).resolves.toBe("after\n");
      await expect(fs.access(path.join(root, "final.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(outcome).toEqual({ files: ["middle.txt", "old.txt", "final.txt"], additions: 1, deletions: 2 });
      await expect(fs.access(path.join(root, "middle.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(path.join(root, "final.txt"), "utf8")).resolves.toBe("after\n");
    }
  });

  it("treats a move to the source path as an update", async () => {
    await fs.writeFile(path.join(root, "value.txt"), "before\n");
    await applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Update File: value.txt", "*** Move to: value.txt",
      "@@", "-before", "+after", "*** End Patch",
    ].join("\n"));
    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("after\n");
  });

  it("still coalesces repeated updates when there is no move", async () => {
    await fs.writeFile(path.join(root, "value.txt"), "before\n");
    const rename = vi.spyOn(fs, "rename");
    await applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Update File: value.txt", "@@", "-before", "+middle",
      "*** Update File: value.txt", "@@", "-middle", "+after", "*** End Patch",
    ].join("\n"));
    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("after\n");
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it.each(["existing destination", "later invalid hunk"])("validates the whole move patch before writing: %s", async (failureKind) => {
    await fs.writeFile(path.join(root, "old.txt"), "before\n");
    await fs.writeFile(path.join(root, "other.txt"), "other\n");
    if (failureKind === "existing destination") {
      await fs.writeFile(path.join(root, "moved.txt"), "keep\n");
    }
    await expect(applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Add File: first.txt", "+not written",
      "*** Update File: old.txt", "*** Move to: moved.txt", "@@", "-before", "+after",
      "*** Update File: other.txt", "@@", "-missing", "+changed", "*** End Patch",
    ].join("\n"))).rejects.toThrow(
      failureKind === "existing destination" ? "Move destination already exists" : "Patch context not found",
    );
    await expect(fs.readFile(path.join(root, "old.txt"), "utf8")).resolves.toBe("before\n");
    await expect(fs.readFile(path.join(root, "other.txt"), "utf8")).resolves.toBe("other\n");
    await expect(fs.access(path.join(root, "first.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    if (failureKind === "existing destination") {
      await expect(fs.readFile(path.join(root, "moved.txt"), "utf8")).resolves.toBe("keep\n");
    } else {
      await expect(fs.access(path.join(root, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    }
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

  describe("symbolic link paths", () => {
    describe.each([false, true])("dangling link: %s", (dangling) => {
      it.each([
        { name: "add", action: ["*** Add File: link.txt", "+replacement"] },
        { name: "update", action: ["*** Update File: link.txt", "@@", "-before", "+after"] },
        { name: "delete", action: ["*** Delete File: link.txt"] },
        { name: "move source", action: ["*** Update File: link.txt", "*** Move to: moved.txt"] },
        { name: "move destination", action: ["*** Update File: source.txt", "*** Move to: link.txt"] },
      ])("rejects $name before any workspace mutation", async ({ action }) => {
        const target = path.join(root, "target.txt");
        if (!dangling) await fs.writeFile(target, "before\n");
        await fs.writeFile(path.join(root, "source.txt"), "source\n");
        await fs.symlink("target.txt", path.join(root, "link.txt"), "file");
        await expect(applyWorkspacePatch(workspace, [
          "*** Begin Patch", "*** Add File: earlier.txt", "+not written", ...action, "*** End Patch",
        ].join("\n"))).rejects.toThrow("Cannot patch symbolic link: link.txt");

        await expect(fs.readlink(path.join(root, "link.txt"))).resolves.toBe("target.txt");
        await expect(fs.readFile(path.join(root, "source.txt"), "utf8")).resolves.toBe("source\n");
        await expect(fs.access(path.join(root, "earlier.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.access(path.join(root, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        if (dangling) {
          await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          await expect(fs.readFile(target, "utf8")).resolves.toBe("before\n");
        }
      });
    });

    it("rechecks for a symbolic link introduced after validation", async () => {
      const target = path.join(root, "target.txt");
      const file = path.join(root, "value.txt");
      await fs.writeFile(target, "target\n");
      await fs.writeFile(file, "before\n");
      const resolvePatchPath = workspace.resolvePatchPath.bind(workspace);
      vi.spyOn(workspace, "resolvePatchPath").mockImplementation(async (userPath, allowMissing) => {
        if (userPath === file) {
          await fs.rm(file);
          await fs.symlink("target.txt", file, "file");
        }
        return resolvePatchPath(userPath, allowMissing);
      });
      await expect(applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@", "-before", "+after", "*** End Patch",
      ].join("\n"))).rejects.toThrow("Cannot patch symbolic link");
      await expect(fs.readlink(file)).resolves.toBe("target.txt");
      await expect(fs.readFile(target, "utf8")).resolves.toBe("target\n");
    });

    it("still edits regular files through a directory alias inside the workspace", async () => {
      await fs.mkdir(path.join(root, "real"));
      await fs.writeFile(path.join(root, "real/value.txt"), "before\n");
      await fs.symlink("real", path.join(root, "alias"), "dir");
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: alias/value.txt", "@@", "-before", "+after", "*** End Patch",
      ].join("\n"));
      expect((await fs.lstat(path.join(root, "alias"))).isSymbolicLink()).toBe(true);
      await expect(fs.readFile(path.join(root, "real/value.txt"), "utf8")).resolves.toBe("after\n");
    });
  });

  describe("hunk headers", () => {
    const original = "function first() {\n  return 1;\n}\n\nfunction second() {\n  return 1;\n}\n";
    const updatedSecond = original.replace("function second() {\n  return 1;", "function second() {\n  return 2;");

    it.each(["\n", "\r\n"])("uses a textual anchor to select repeated code with %j endings", async (ending) => {
      await fs.writeFile(path.join(root, "value.txt"), original.replaceAll("\n", ending));
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@ function second() {",
        "-  return 1;", "+  return 2;", "*** End Patch",
      ].join("\n"));

      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        updatedSecond.replaceAll("\n", ending),
      );
    });

    it("does not mistake a comment containing the anchor for the anchor line", async () => {
      const commented = "// function second() {\n  return 1;\n\n" + original;
      await fs.writeFile(path.join(root, "value.txt"), commented);
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@ function second() {",
        "-  return 1;", "+  return 2;", "*** End Patch",
      ].join("\n"));

      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        "// function second() {\n  return 1;\n\n" + updatedSecond,
      );
    });

    it("tolerates trailing whitespace in anchors while preserving the original line", async () => {
      const spaced = original.replace("function second() {", "function second() {  ");
      await fs.writeFile(path.join(root, "value.txt"), spaced);
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@ function second() {",
        "-  return 1;", "+  return 2;", "*** End Patch",
      ].join("\n"));

      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        updatedSecond.replace("function second() {", "function second() {  "),
      );
    });

    it.each([
      { header: "function missing() {", source: original, error: "Patch anchor not found" },
      { header: "function second() {", source: original.replace("function second() {\n  return 1;", "function second() {\n  return 3;"), error: "Patch context not found" },
    ])("rejects an unmatched anchor or following context before writing: $header", async ({ header, source, error }) => {
      await fs.writeFile(path.join(root, "value.txt"), source);
      await expect(applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Add File: added.txt", "+new",
        "*** Update File: value.txt", `@@ ${header}`,
        "-  return 1;", "+  return 2;", "*** End Patch",
      ].join("\n"))).rejects.toThrow(error);

      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(source);
      await expect(fs.access(path.join(root, "added.txt"))).rejects.toThrow();
    });

    it("advances textual anchors after preceding hunks change the line count", async () => {
      const source = "section\nfirst\n\nsection\nold\n";
      await fs.writeFile(path.join(root, "value.txt"), source);
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@",
        "-first", "+first", "+extra", "@@ section", "-old", "+second", "*** End Patch",
      ].join("\n"));

      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        "section\nfirst\nextra\n\nsection\nsecond\n",
      );
    });

    it.each(["section", "section  "])("rejects duplicate anchors, including whitespace variants: %j", async (secondAnchor) => {
      const source = `section\nold\n\n${secondAnchor}\nold\n`;
      await fs.writeFile(path.join(root, "value.txt"), source);
      await expect(applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Add File: added.txt", "+new",
        "*** Update File: value.txt", "@@ section", "-old", "+new", "*** End Patch",
      ].join("\n"))).rejects.toThrow("Patch anchor is ambiguous");
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(source);
      await expect(fs.access(path.join(root, "added.txt"))).rejects.toThrow();
    });

    it("does not broaden anchor matching to ignore indentation", async () => {
      const source = "  section\nold\n";
      await fs.writeFile(path.join(root, "value.txt"), source);
      await expect(applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@ section", "-old", "+new", "*** End Patch",
      ].join("\n"))).rejects.toThrow("Patch anchor not found");
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(source);
    });

    it("inserts immediately after a textual anchor", async () => {
      await fs.writeFile(path.join(root, "value.txt"), original);
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@ function second() {",
        "+  log();", "*** End Patch",
      ].join("\n"));

      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        original.replace("function second() {\n", "function second() {\n  log();\n"),
      );
    });

    it("requires an EOF replacement to follow its textual anchor", async () => {
      await fs.writeFile(path.join(root, "value.txt"), "section\nold\nmiddle\nold\n");
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@ section",
        "-old", "+new", "*** End of File", "*** End Patch",
      ].join("\n"));
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        "section\nold\nmiddle\nnew\n",
      );

      await expect(applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@ new",
        "-new", "+other", "*** End of File", "*** End Patch",
      ].join("\n"))).rejects.toThrow("Patch context not found at end of file");
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        "section\nold\nmiddle\nnew\n",
      );
    });

    it.each([
      { name: "bare header", source: "alpha\nbeta\n", header: "@@", eof: false, expected: "new\nalpha\nbeta\n" },
      { name: "numeric hint", source: "alpha\nbeta\n", header: "@@ -2", eof: false, expected: "alpha\nnew\nbeta\n" },
      { name: "unified-style hint", source: "alpha\nbeta\n", header: "@@ -2,0 +2,1 @@ descriptive text", eof: false, expected: "alpha\nnew\nbeta\n" },
      { name: "substring header", source: "function second() {\n}\n", header: "@@ second", eof: false, expected: "function second() {\nnew\n}\n" },
      { name: "repeated header", source: "section\nalpha\nsection\nbeta\n", header: "@@ section", eof: false, expected: "section\nnew\nalpha\nsection\nbeta\n" },
      { name: "missing header", source: "alpha\nbeta\n", header: "@@ missing", eof: false, expected: "new\nalpha\nbeta\n" },
      { name: "missing EOF header", source: "alpha\nbeta\n", header: "@@ missing", eof: true, expected: "alpha\nbeta\nnew\n" },
    ])("preserves insertion-only behavior with a $name", async ({ source, header, eof, expected }) => {
      await fs.writeFile(path.join(root, "value.txt"), source);
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", header, "+new",
        ...(eof ? ["*** End of File"] : []), "*** End Patch",
      ].join("\n"));
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(expected);
    });

    it.each(["@@ -6", "@@ -6,1 +6,1 @@", "@@ -6,1 +6,1 @@ function second() {"])(
      "preserves the numeric search hint in %s",
      async (header) => {
        await fs.writeFile(path.join(root, "value.txt"), original);
        await applyWorkspacePatch(workspace, [
          "*** Begin Patch", "*** Update File: value.txt", header,
          "-  return 1;", "+  return 2;", "*** End Patch",
        ].join("\n"));
        await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(updatedSecond);
      },
    );

    it("retains fallback matching when a numeric hint is beyond the file", async () => {
      await fs.writeFile(path.join(root, "value.txt"), original);
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@ -100",
        "-  return 1;", "+  return 2;", "*** End Patch",
      ].join("\n"));
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        original.replace("return 1;", "return 2;"),
      );
    });

    it("rejects a complete standard unified diff", async () => {
      await fs.writeFile(path.join(root, "value.txt"), original);
      await expect(applyWorkspacePatch(workspace, [
        "--- a/value.txt", "+++ b/value.txt", "@@ -6,1 +6,1 @@",
        "-  return 1;", "+  return 2;",
      ].join("\n"))).rejects.toThrow("Patch must start with *** Begin Patch");
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(original);
    });
  });

  it.each([
    ["CRLF with an LF patch", "alpha\r\nbeta\r\ngamma\r\n", "\n", "alpha\r\nBETA\r\nGAMMA\r\n"],
    ["CRLF with a CRLF patch", "alpha\r\nbeta\r\ngamma\r\n", "\r\n", "alpha\r\nBETA\r\nGAMMA\r\n"],
    ["CRLF without a final newline", "alpha\r\nbeta\r\ngamma", "\n", "alpha\r\nBETA\r\nGAMMA"],
    ["LF with a CRLF patch", "alpha\nbeta\ngamma\n", "\r\n", "alpha\nBETA\nGAMMA\n"],
    ["mixed endings starting with CRLF", "alpha\r\nbeta\ngamma\n", "\n", "alpha\r\nBETA\r\nGAMMA\r\n"],
    ["mixed endings starting with LF", "alpha\nbeta\r\ngamma\r\n", "\n", "alpha\nBETA\nGAMMA\n"],
  ])("uses the file's first newline convention: %s", async (_name, original, patchEnding, expected) => {
    await fs.writeFile(path.join(root, "value.txt"), original);
    const result = await applyWorkspacePatch(workspace, [
      "*** Begin Patch",
      "*** Update File: value.txt",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      "@@",
      "-gamma",
      "+GAMMA",
      "*** End Patch",
    ].join(patchEnding));

    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(expected);
    expect(result).toMatchObject({ additions: 2, deletions: 2 });
  });

  it.each(["alpha\r\nbeta\r\n", "alpha\r\nbeta\ngamma"])(
    "preserves move-only content exactly: %j",
    async (original) => {
      await fs.writeFile(path.join(root, "value.txt"), original);
      const result = await applyWorkspacePatch(workspace, [
        "*** Begin Patch",
        "*** Update File: value.txt",
        "*** Move to: moved.txt",
        "*** End Patch",
      ].join("\n"));

      await expect(fs.readFile(path.join(root, "moved.txt"), "utf8")).resolves.toBe(original);
      await expect(fs.access(path.join(root, "value.txt"))).rejects.toThrow();
      expect(result).toMatchObject({ additions: 0, deletions: 0 });
    },
  );

  it.each([
    ["alpha\r\nbeta", "alpha\r\nbeta\r\ngamma"],
    ["alpha\r\nbeta\r\n", "alpha\r\nbeta\r\ngamma\r\n"],
    ["alpha", "alpha\ngamma"],
    ["", "gamma"],
  ])("uses the detected ending for EOF insertion: %j", async (original, expected) => {
    await fs.writeFile(path.join(root, "value.txt"), original);
    await applyWorkspacePatch(workspace, [
      "*** Begin Patch",
      "*** Update File: value.txt",
      "@@",
      "+gamma",
      "*** End of File",
      "*** End Patch",
    ].join("\r\n"));

    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(expected);
  });

  it("defaults new files to LF even with a CRLF patch", async () => {
    await applyWorkspacePatch(workspace, [
      "*** Begin Patch",
      "*** Add File: added.txt",
      "+alpha",
      "+beta",
      "*** End Patch",
    ].join("\r\n"));

    await expect(fs.readFile(path.join(root, "added.txt"), "utf8")).resolves.toBe("alpha\nbeta\n");
  });

  describe.each(["\n", "\r\n"])("UTF-8 BOM with %j line endings", (ending) => {
    it.each([
      {
        name: "replaces the first line",
        original: "\uFEFFalpha\nbeta\n",
        hunk: ["-alpha", "+ALPHA"],
        expected: "\uFEFFALPHA\nbeta\n",
      },
      {
        name: "preserves the first line used as context",
        original: "\uFEFFalpha\nbeta\n",
        hunk: [" alpha", "-beta", "+BETA"],
        expected: "\uFEFFalpha\nBETA\n",
      },
      {
        name: "matches the first occurrence before a later duplicate",
        original: "\uFEFFalpha\nbeta\nalpha\n",
        hunk: ["-alpha", "+ALPHA"],
        expected: "\uFEFFALPHA\nbeta\nalpha\n",
      },
      {
        name: "prepends text after the BOM",
        original: "\uFEFFalpha\nbeta\n",
        hunk: ["+intro"],
        expected: "\uFEFFintro\nalpha\nbeta\n",
      },
      {
        name: "edits later lines without changing the BOM",
        original: "\uFEFFalpha\nbeta\n",
        hunk: ["-beta", "+BETA"],
        expected: "\uFEFFalpha\nBETA\n",
      },
      {
        name: "preserves an absent final newline",
        original: "\uFEFFalpha\nbeta",
        hunk: ["-alpha", "+ALPHA"],
        expected: "\uFEFFALPHA\nbeta",
      },
      {
        name: "retains the BOM when deleting all text",
        original: "\uFEFFalpha\n",
        hunk: ["-alpha"],
        expected: "\uFEFF",
      },
      {
        name: "leaves interior U+FEFF characters untouched",
        original: "\uFEFFalpha\nbet\uFEFFa\n",
        hunk: ["-alpha", "+ALPHA", " bet\uFEFFa"],
        expected: "\uFEFFALPHA\nbet\uFEFFa\n",
      },
    ])("$name", async ({ original, hunk, expected }) => {
      await fs.writeFile(path.join(root, "value.txt"), original.replaceAll("\n", ending));
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch",
        "*** Update File: value.txt",
        "@@",
        ...hunk,
        "*** End Patch",
      ].join("\n"));

      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        expected.replaceAll("\n", ending),
      );
    });
  });

  it("treats a BOM-only file as empty text when inserting at EOF", async () => {
    await fs.writeFile(path.join(root, "value.txt"), "\uFEFF");
    await applyWorkspacePatch(workspace, [
      "*** Begin Patch",
      "*** Update File: value.txt",
      "@@",
      "+alpha",
      "*** End of File",
      "*** End Patch",
    ].join("\n"));

    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe("\uFEFFalpha");
  });

  describe.each(["\n", "\r\n"])("EOF and blank lines with %j endings", (ending) => {
    it.each(["", "\n"])("anchors replacement at EOF and preserves final newline %j", async (final) => {
      await fs.writeFile(path.join(root, "value.txt"), ("\uFEFFalpha\nmiddle\nalpha" + final).replaceAll("\n", ending));
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@ -1",
        "-alpha", "+ALPHA", "*** End of File", "*** End Patch",
      ].join("\n"));
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        ("\uFEFFalpha\nmiddle\nALPHA" + final).replaceAll("\n", ending),
      );
    });

    it("rejects EOF context that only matches earlier, without writing any files", async () => {
      const original = ["alpha", "middle", ""].join(ending);
      await fs.writeFile(path.join(root, "value.txt"), original);
      await expect(applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Add File: added.txt", "+new",
        "*** Update File: value.txt", "@@", "-alpha", "+ALPHA",
        "*** End of File", "*** End Patch",
      ].join("\n"))).rejects.toThrow("Patch context not found at end of file");
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(original);
      await expect(fs.access(path.join(root, "added.txt"))).rejects.toThrow();
    });

    it("keeps whitespace-tolerant matching at EOF", async () => {
      await fs.writeFile(path.join(root, "value.txt"), ["alpha", "alpha  ", ""].join(ending));
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@",
        "-alpha", "+ALPHA", "*** End of File", "*** End Patch",
      ].join("\n"));
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        ["alpha", "ALPHA", ""].join(ending),
      );
    });

    it.each([
      { name: "replace", hunk: ["-", "+hello"], expected: "hello\n" },
      { name: "prepend", hunk: ["+hello"], expected: "hello\n\n" },
      { name: "delete", hunk: ["-"], expected: "" },
    ])("can $name a single blank line", async ({ hunk, expected }) => {
      await fs.writeFile(path.join(root, "value.txt"), ending);
      await applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Update File: value.txt", "@@", ...hunk, "*** End Patch",
      ].join("\n"));
      await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
        expected.replaceAll("\n", ending),
      );
    });
  });

  it.each(["\n", "\r\n"])("preserves original context whitespace with %j endings", async (ending) => {
    const original = ["\uFEFF\tbefore();  ", "\told();", "\tbetween();\t", "\tremove();", "\tafter();  ", ""].join(ending);
    await fs.writeFile(path.join(root, "value.txt"), original);
    await applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Update File: value.txt", "@@",
      " \tbefore();", "-\told();", "+    updated();  ",
      " \tbetween();", "-\tremove();", " \tafter();",
      "*** End of File", "*** End Patch",
    ].join("\n"));

    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(
      ["\uFEFF\tbefore();  ", "    updated();  ", "\tbetween();\t", "\tafter();  ", ""].join(ending),
    );
  });

  it.each([
    { name: "context indentation", hunk: ["     keep();", "-\told();", "+\tupdated();"] },
    { name: "deleted-line indentation", hunk: [" \tkeep();", "-    old();", "+    updated();"] },
  ])("rejects mismatched $name before writing any files", async ({ hunk }) => {
    const original = "\tkeep();\n\told();\n";
    await fs.writeFile(path.join(root, "value.txt"), original);
    await expect(applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Add File: added.txt", "+new",
      "*** Update File: value.txt", "@@", ...hunk, "*** End Patch",
    ].join("\n"))).rejects.toThrow("Patch context not found");

    await expect(fs.readFile(path.join(root, "value.txt"), "utf8")).resolves.toBe(original);
    await expect(fs.access(path.join(root, "added.txt"))).rejects.toThrow();
  });

  describe.each([
    { name: "UTF-16LE with BOM", bytes: Buffer.from("\uFEFFalpha\n", "utf16le") },
    { name: "UTF-16BE with BOM", bytes: Buffer.from("\uFEFFalpha\n", "utf16le").swap16() },
    { name: "UTF-16LE without BOM", bytes: Buffer.from("alpha\n", "utf16le") },
    { name: "UTF-16BE without BOM", bytes: Buffer.from("alpha\n", "utf16le").swap16() },
    { name: "GBK Chinese text", bytes: Buffer.from([0xd6, 0xd0]) },
    { name: "Big5 Chinese text", bytes: Buffer.from([0xa4, 0xa4]) },
    { name: "truncated UTF-8", bytes: Buffer.from([0xe4, 0xb8]) },
    { name: "NUL-containing text", bytes: Buffer.from("alpha\0beta") },
  ])("unsupported encoding: $name", ({ bytes }) => {
    it.each([
      { name: "insert", action: ["*** Update File: value.txt", "@@", "+new"] },
      { name: "move", action: ["*** Update File: value.txt", "*** Move to: moved.txt"] },
      { name: "delete", action: ["*** Delete File: value.txt"] },
    ])("rejects $name before any workspace mutation", async ({ action }) => {
      await fs.writeFile(path.join(root, "value.txt"), bytes);
      await expect(applyWorkspacePatch(workspace, [
        "*** Begin Patch", "*** Add File: added.txt", "+new", ...action, "*** End Patch",
      ].join("\n"))).rejects.toThrow(
        "Cannot patch value.txt: only UTF-8 text files are supported. Convert the file to UTF-8 first.",
      );

      await expect(fs.readFile(path.join(root, "value.txt"))).resolves.toEqual(bytes);
      await expect(fs.access(path.join(root, "added.txt"))).rejects.toThrow();
      await expect(fs.access(path.join(root, "moved.txt"))).rejects.toThrow();
    });
  });

  it.each(["", "\uFEFF"])("accepts UTF-8 Unicode text with BOM %j", async (bom) => {
    await fs.writeFile(path.join(root, "value.txt"), `${bom}中文 café 😀\r\n`);
    await applyWorkspacePatch(workspace, [
      "*** Begin Patch", "*** Update File: value.txt", "@@",
      "-中文 café 😀", "+繁體 café 🌟", "*** End Patch",
    ].join("\n"));
    await expect(fs.readFile(path.join(root, "value.txt"))).resolves.toEqual(
      Buffer.from(`${bom}繁體 café 🌟\r\n`, "utf8"),
    );
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

  it.each([
    "../outside.txt",
    "src/../../outside.txt",
    "..",
    ...(path.sep === "\\" ? ["..\\outside.txt", "src\\..\\..\\outside.txt"] : []),
  ])("rejects paths outside the workspace: %s", async (file) => {
    await expect(
      applyWorkspacePatch(
        workspace,
        `*** Begin Patch\n*** Add File: ${file}\n+bad\n*** End Patch`,
      ),
    ).rejects.toThrow("workspace-relative");
  });
});
