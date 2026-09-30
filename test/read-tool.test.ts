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
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { createDSCodeReadTool } from "../packages/core/src/read-tool.ts";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import { createTestTheme } from "./fixtures/theme.ts";

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

  it("reveals the full long path and requested range when expanded", () => {
    const tool = createDSCodeReadTool(process.cwd());
    const filePath = `${"long-directory/".repeat(12)}file.txt`;
    const args = { path: filePath, offset: 10, limit: 20 };
    const render = (expanded: boolean) => tool.renderCall!(args, theme, { ...context, expanded })
      .render(1000).join("\n");
    expect(render(false)).not.toContain("file.txt");
    expect(render(true)).toContain(`${filePath}:10-29`);
  });

  it("retains pi's slicing and continuation notice using the live working directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-read-"));
    try {
      await fs.writeFile(path.join(root, "sample.txt"), "one\ntwo\nthree\nfour");
      const tool = createDSCodeReadTool("/unused-initial-directory");
      const result = await tool.execute("read-1", { path: "sample.txt", offset: 2, limit: 1 },
        undefined, undefined, { cwd: root } as ExtensionToolContext);
      expect(result.content).toEqual([{ type: "text", text: "two\n\n[2 more lines in file. Use offset=3 to continue.]" }]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("registers auditable read and stdin presentations in a real Pi AgentSession", async () => {
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
        tools: ["read", "write_stdin"],
      });
      try {
        // Pi's core read has the same name but no self-render shell. Inspecting
        // the real session registry ensures the extension definition wins.
        expect(createReadToolDefinition(root).renderShell).toBeUndefined();
        expect(session.getActiveToolNames()).toContain("read");
        expect(session.getToolDefinition("read")?.renderShell).toBe("self");
        const stdin = session.getToolDefinition("write_stdin")!;
        const render = (args: Record<string, unknown>, expanded = true, isError = false) =>
          stdin.renderCall!({ process_id: "12", ...args }, theme, { ...context, expanded, isError })
            .render(1000).join("\n");
        const chars = '你\n\t\r\u001b"\\';
        expect(render({ chars }, false)).toContain("Write to process 12 · 9 bytes");
        expect(render({ chars }, false)).not.toContain(JSON.stringify(chars));
        expect(render({ chars })).toContain(JSON.stringify(chars));
        expect(render({ chars })).not.toContain("\u001b");
        expect(render({ chars }, true, true)).toContain(JSON.stringify(chars));
        expect(render({ chars, eof: true })).toContain("Write and send EOF to process 12");
        expect(render({ chars: `${"x".repeat(200)}END\n` })).toContain("END\\n");
        expect(render({})).toContain("Poll process 12");
        expect(render({ chars: "" })).toContain("Poll process 12");
        expect(render({ eof: true })).toContain("Send EOF to process 12");
        expect(render({ chars, terminate: true })).toContain("Stop process 12");
        expect(render({ chars, terminate: true })).not.toContain(JSON.stringify(chars));
      } finally {
        session.dispose();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
