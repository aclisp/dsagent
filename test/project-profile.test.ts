import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProjectCommands } from "../packages/core/src/project-profile.js";

describe("discoverProjectCommands", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("discovers package scripts without executing them", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-profile-"));
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          test: "vitest",
          typecheck: "tsc --noEmit",
          deploy: "do-not-auto-suggest",
        },
      }),
    );

    await expect(discoverProjectCommands(root)).resolves.toEqual([
      "pnpm test",
      "pnpm typecheck",
    ]);
  });
});
