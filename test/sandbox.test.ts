import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSandboxedCommand } from "../packages/core/src/sandbox.js";

describe("macOS Seatbelt sandbox", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-sandbox-root-"));
    outside = path.join(os.homedir(), `.dscode-sandbox-outside-${randomUUID()}`);
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== "darwin")(
    "allows workspace writes and denies writes outside it",
    async () => {
      const output: Buffer[] = [];
      const result = await executeSandboxedCommand(
        `printf allowed > inside.txt; printf denied > '${path.join(outside, "blocked.txt")}'`,
        root,
        { mode: "workspace-write", network: false },
        { onData: (data) => output.push(data) },
      );

      expect(result.exitCode).not.toBe(0);
      await expect(fs.readFile(path.join(root, "inside.txt"), "utf8")).resolves.toBe("allowed");
      await expect(fs.access(path.join(outside, "blocked.txt"))).rejects.toThrow();
    },
  );

  it.skipIf(process.platform !== "darwin")("denies writes in read-only mode", async () => {
    const result = await executeSandboxedCommand(
      "printf denied > blocked.txt",
      root,
      { mode: "read-only", network: false },
      { onData: () => {} },
    );
    expect(result.exitCode).not.toBe(0);
    await expect(fs.access(path.join(root, "blocked.txt"))).rejects.toThrow();
  });
});
