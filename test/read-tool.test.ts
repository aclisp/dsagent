import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createReadToolDefinition,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.js";
import { createDSCodeReadTool } from "../packages/core/src/read-tool.js";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.js";
import { createTestTheme } from "./fixtures/theme.js";

const theme = Object.assign(createTestTheme(), { bold: (text: string) => text });
const context = { isError: false, isPartial: false } as Parameters<NonNullable<ReturnType<typeof createDSCodeReadTool>["renderCall"]>>[2];

describe("DSCode read presentation", () => {
  it("uses a compact shell with inclusive ranges and handles partial arguments", () => {
    const tool = createDSCodeReadTool(process.cwd());
    expect(tool.renderShell).toBe("self");
    for (const [args, expected] of [
      [{ path: "file.ts", offset: 10, limit: 20 }, "• Read file.ts:10-29"],
      [{ path: "file.ts", limit: 20 }, "• Read file.ts:1-20"],
      [{ path: "file.ts", offset: 10 }, "• Read file.ts:10…"],
      [{}, "• Read file"],
    ] as const) {
      expect(tool.renderCall!(args as Parameters<NonNullable<typeof tool.renderCall>>[0], theme, context).render(100).join("\n")).toContain(expected);
    }
  });

  it("summarizes success, expands content, and exposes errors", () => {
    const tool = createDSCodeReadTool(process.cwd());
    const result = { content: [{ type: "text" as const, text: "one\ntwo" }], details: undefined };
    const render = (expanded: boolean, isError = false) => tool.renderResult!(
      result, { expanded, isPartial: false }, theme, { ...context, isError },
    ).render(100).join("\n");
    expect(render(false)).toContain("2 output lines · Ctrl+O to expand");
    expect(render(false)).not.toContain("one");
    expect(render(true)).toContain("└ one");
    expect(render(false, true)).toContain("└ one");
  });

  it("retains pi's slicing and continuation notice using the live working directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-read-"));
    try {
      await fs.writeFile(path.join(root, "sample.txt"), "one\ntwo\nthree\nfour");
      const tool = createDSCodeReadTool("/unused-initial-directory");
      const result = await tool.execute("read-1", { path: "sample.txt", offset: 2, limit: 1 },
        undefined, undefined, { cwd: root } as ExtensionContext);
      expect(result.content).toEqual([{ type: "text", text: "two\n\n[2 more lines in file. Use offset=3 to continue.]" }]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the registered DSCode read tool in a real Pi AgentSession", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-read-session-"));
    try {
      const agentDir = path.join(root, "agent");
      await fs.mkdir(agentDir);
      const settingsManager = SettingsManager.create(root, agentDir, { projectTrusted: true });
      const resourceLoader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager,
        extensionFactories: [createDSCodeExtension(
          parseRuntimeArgs(["-C", root, "--no-mcp"]).options,
          { planMode: false, planTool: false },
        )],
      });
      await resourceLoader.reload();
      const modelRuntime = await ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
      });
      const { session } = await createAgentSession({
        cwd: root,
        agentDir,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(root),
        modelRuntime,
        tools: ["read"],
      });
      try {
        // Pi's core read has the same name but no self-render shell. Inspecting
        // the real session registry ensures the extension definition wins.
        expect(createReadToolDefinition(root).renderShell).toBeUndefined();
        expect(session.getActiveToolNames()).toContain("read");
        expect(session.getToolDefinition("read")?.renderShell).toBe("self");
      } finally {
        session.dispose();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
