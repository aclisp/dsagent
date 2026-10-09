import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyWorkspacePatch } from "../packages/core/src/patch.ts";
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
