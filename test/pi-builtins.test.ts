import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.js";
import { dscodePiBuiltinOverrides } from "../packages/core/src/pi-builtins.js";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.js";

describe("DSCode Pi built-ins", () => {
  it("replaces Pi's MCP and codemode stack before loading, including reload and explicit paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-pi-builtins-"));
    try {
      const agentDir = path.join(root, "agent");
      await fs.mkdir(agentDir);
      const upstreamFactory = vi.fn(() => { throw new Error("Upstream built-in must not load"); });
      const upstreamBuiltins: InlineExtension[] = ["mcp", "codemode", "tool-search"].map((name) => ({
        name, builtin: true, factory: upstreamFactory,
      }));
      const settingsManager = SettingsManager.create(root, agentDir, { projectTrusted: true });
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager,
        additionalExtensionPaths: ["builtin:mcp", "builtin:codemode", "builtin:tool-search"],
        extensionFactories: [
          ...upstreamBuiltins,
          ...dscodePiBuiltinOverrides,
          createDSCodeExtension(parseRuntimeArgs(["-C", root, "--no-mcp"]).options),
        ],
      });
      for (let reload = 0; reload < 2; reload++) {
        await loader.reload();
        const result = loader.getExtensions();
        expect(result.errors).toEqual([]);
        expect(result.warnings ?? []).toEqual([]);
        const tools = result.extensions.flatMap((extension) => [...extension.tools.keys()]);
        expect(tools).toContain("exec_command");
        expect(tools).not.toContain("codemode");
        expect(tools).not.toContain("tool_search");
        const mcpCommands = result.extensions.flatMap((extension) => [...extension.commands.keys()])
          .filter((name) => name === "mcp");
        expect(mcpCommands).toEqual(["mcp"]);
        expect(result.runtime.pendingVirtualModelRegistrations).toEqual([]);
      }
      expect(upstreamFactory).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
