import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCodingTools } from "../src/tools.js";
import { Workspace } from "../src/workspace.js";

describe("coding tools", () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-tools-"));
    workspace = new Workspace(root);
    await workspace.initialize();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes, reads, and edits a file", async () => {
    const tools = new Map(createCodingTools(workspace).map((tool) => [tool.name, tool]));
    const write = tools.get("write_file")!;
    const read = tools.get("read_file")!;
    const edit = tools.get("edit_file")!;

    await write.execute("1", { path: "src/value.ts", content: "export const value = 1;\n" });
    const readResult = await read.execute("2", { path: "src/value.ts" });
    expect(readResult.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("export const value = 1;"),
    });

    await edit.execute("3", {
      path: "src/value.ts",
      old_text: "value = 1",
      new_text: "value = 2",
    });
    await expect(fs.readFile(path.join(root, "src/value.ts"), "utf8")).resolves.toContain("value = 2");
  });

  it("refuses ambiguous edits", async () => {
    await fs.writeFile(path.join(root, "values.txt"), "same\nsame\n");
    const edit = createCodingTools(workspace).find((tool) => tool.name === "edit_file")!;
    await expect(
      edit.execute("1", {
        path: "values.txt",
        old_text: "same",
        new_text: "different",
      }),
    ).rejects.toThrow("occurs 2 times");
  });

  it("refuses list globs outside the workspace", async () => {
    const list = createCodingTools(workspace).find((tool) => tool.name === "list_files")!;
    await expect(list.execute("1", { pattern: "../**/*" })).rejects.toThrow("escapes workspace");
  });

  it("exposes the V4 minimal harness with a freeform patch path", async () => {
    const tools = createCodingTools(workspace, "minimal");
    expect(tools.map((tool) => tool.name)).toEqual(["exec_command", "apply_patch"]);

    const patch = tools[1]!;
    await patch.execute("1", {
      input: [
        "*** Begin Patch",
        "*** Add File: src/minimal.ts",
        "+export const minimal = true;",
        "*** End Patch",
      ].join("\n"),
    });

    await expect(fs.readFile(path.join(root, "src/minimal.ts"), "utf8")).resolves.toBe(
      "export const minimal = true;\n",
    );
  });
});
