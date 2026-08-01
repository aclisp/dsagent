import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDSCodeRpcClient,
  getDSCodeRpcEntryPath,
} from "../packages/core/src/rpc-client.js";

describe("@thinkany/dscode-core package boundary", () => {
  it("keeps the CLI and core package versions in lockstep", () => {
    const cli = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
    const core = JSON.parse(
      fs.readFileSync(path.resolve("packages/core/package.json"), "utf8"),
    );

    expect(core.version).toBe(cli.version);
  });

  it("creates an RPC client that targets the bundled worker", () => {
    const client = createDSCodeRpcClient({ cwd: process.cwd() });

    expect(client).toBeDefined();
    expect(getDSCodeRpcEntryPath()).toMatch(/packages\/core\/(?:src|dist)\/rpc-entry\.(?:ts|js)$/);
  });
});
