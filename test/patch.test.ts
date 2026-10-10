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
