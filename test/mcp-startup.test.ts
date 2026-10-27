import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import { createTestTheme } from "./fixtures/theme.ts";

vi.mock("../packages/core/src/hooks.ts", () => ({ registerHooks: vi.fn() }));

describe("native MCP activation during DSCode startup", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-mcp-startup-"));
    vi.stubEnv("DSCODE_HOME", root);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function startup(timing: "before" | "during", args: string[] = []) {
    const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
    const definitions = new Map<string, ToolDefinition>();
    let active = ["codemode", "tool_search"];
    const connect = () => {
      active.push("mcp__fixture__echo", "list_mcp_resources");
    };
    const pi = new Proxy({
      on(name: string, handler: (event: any, ctx: any) => any) {
        handlers.set(name, [...handlers.get(name) ?? [], handler]);
      },
      registerTool(tool: ToolDefinition) { definitions.set(tool.name, tool); },
      getAllTools: () => [...definitions.values()],
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { active = [...names]; },
    }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as ExtensionAPI;
    const options = parseRuntimeArgs(["-C", root, "--network", ...args]).options;
    const extension = createDSCodeExtension(options);
    await (typeof extension === "function" ? extension(pi) : extension.factory(pi));
    if (timing === "before") connect();
    const ui = new Proxy({ theme: createTestTheme() }, {
      get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined,
    });
    const ctx = {
      cwd: root, mode: "rpc", hasUI: true, ui,
      isProjectTrusted: () => true,
      modelRegistry: { getProviderAuth: async () => { if (timing === "during") connect(); return undefined; } },
      sessionManager: {
        getBranch: () => [], getSessionFile: () => undefined,
        buildSessionProjection: () => ({ messages: [] }),
      },
    } as unknown as ExtensionContext;
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    return active;
  }

  it.each(["before", "during"] as const)("retains MCP tools activated %s startup initialization", async timing => {
    const active = await startup(timing);
    expect(active).toEqual(expect.arrayContaining(["read", "exec_command", "codemode", "tool_search",
      "mcp__fixture__echo", "list_mcp_resources"]));
  });

  it("still clears MCP tools when MCP is disabled", async () => {
    const active = await startup("before", ["--no-mcp"]);
    expect(active).not.toContain("mcp__fixture__echo");
    expect(active).not.toContain("list_mcp_resources");
  });

  it("still disables every tool when requested", async () => {
    expect(await startup("before", ["--no-tools"])).toEqual([]);
  });
});
