import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { MCPManager } from "../src/mcp.js";

describe("MCPManager", () => {
  let root: string | undefined;
  const originalKey = process.env.DEEPSEEK_API_KEY;

  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });

  it("loads trusted project tools and strips the model key from stdio", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-mcp-"));
    await fs.mkdir(path.join(root, ".dscode"));
    await fs.writeFile(
      path.join(root, ".dscode", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [path.resolve("test/fixtures/mcp-server.mjs")],
          },
        },
      }),
    );
    process.env.DEEPSEEK_API_KEY = "must-not-leak";

    const tools = new Map<string, ToolDefinition>();
    let active: string[] = [];
    const pi = {
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
      getActiveTools() {
        return active;
      },
      setActiveTools(names: string[]) {
        active = names;
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: root,
      isProjectTrusted: () => true,
    } as unknown as ExtensionContext;
    const manager = new MCPManager();
    try {
      await manager.connectConfigured(pi, ctx);
      expect(manager.status()).toContain("fixture: connected (1 tools)");
      expect(active).toContain("mcp__fixture__echo");
      const tool = tools.get("mcp__fixture__echo");
      expect(tool).toBeDefined();
      const result = await tool!.execute("call-1", { text: "hello" }, undefined, undefined, ctx);
      expect(result.content).toEqual([
        { type: "text", text: "hello|key=unset" },
      ]);
    } finally {
      await manager.close();
    }
  });
});
