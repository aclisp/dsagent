import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.js";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.js";
import type { DSCodeRuntimeOptions } from "../packages/core/src/runtime-options.js";

describe("command access escalation", () => {
  let root: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (root) await fs.rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it("passes the current main-agent thinking level to every managed command", async () => {
    const tools = new Map<string, any>();
    let thinkingLevel: "low" | "max" = "low";
    const pi = new Proxy(
      {
        registerTool(tool: { name: string }) {
          tools.set(tool.name, tool);
        },
        on: () => undefined,
        getActiveTools: () => [],
        setActiveTools: () => undefined,
        getThinkingLevel: () => thinkingLevel,
      },
      {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return () => undefined;
        },
      },
    ) as unknown as ExtensionAPI;
    const start = vi.spyOn(ManagedProcessRegistry.prototype, "start").mockResolvedValue({
      processId: "vision-process",
      running: false,
      output: "done",
      exitCode: 0,
      sandbox: "trusted dscode-vision (fixed executable)",
    });
    runExtensionFactory(
      {
        ...options(process.cwd()),
        permission: "full",
        sandbox: "danger-full-access",
        network: true,
      },
      pi,
    );
    const context = { cwd: process.cwd(), hasUI: false } as ExtensionContext;

    await tools.get("exec_command").execute(
      "vision-low",
      { cmd: "dscode-vision --image screenshot.png" },
      undefined,
      undefined,
      context,
    );
    thinkingLevel = "max";
    await tools.get("exec_command").execute(
      "vision-max",
      { cmd: "dscode-vision --image screenshot.png" },
      undefined,
      undefined,
      context,
    );

    expect(start.mock.calls[0]?.[1]).toMatchObject({ thinkingLevel: "low" });
    expect(start.mock.calls[1]?.[1]).toMatchObject({ thinkingLevel: "max" });
  });

  it("gets scoped network approval before enabling the trusted vision path", async () => {
    const tools = new Map<string, any>();
    const pi = new Proxy(
      {
        registerTool(tool: { name: string }) {
          tools.set(tool.name, tool);
        },
        on: () => undefined,
        getActiveTools: () => [],
        setActiveTools: () => undefined,
        getThinkingLevel: () => "high",
      },
      {
        get(target, property) {
          if (property in target) return target[property as keyof typeof target];
          return () => undefined;
        },
      },
    ) as unknown as ExtensionAPI;
    const start = vi.spyOn(ManagedProcessRegistry.prototype, "start").mockResolvedValue({
      processId: "vision-process",
      running: false,
      output: "done",
      exitCode: 0,
      sandbox: "trusted dscode-vision (fixed executable)",
    });
    runExtensionFactory(options(process.cwd()), pi);
    const prompts: string[] = [];
    const context = {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        setWorkingVisible: () => undefined,
        select: async (prompt: string) => {
          prompts.push(prompt);
          return "Allow once";
        },
      },
    } as unknown as ExtensionContext;

    await tools.get("exec_command").execute(
      "vision-network",
      { cmd: "dscode-vision --image screenshot.png" },
      undefined,
      undefined,
      context,
    );

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Allow network access?");
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      sandbox: { mode: "workspace-write", network: true },
      thinkingLevel: "high",
    });
  });

  it.runIf(process.platform === "darwin")(
    "asks for scoped host access and retries the blocked command once approved",
    async () => {
      root = await fs.mkdtemp(path.join(process.cwd(), ".dscode-access-test-"));
      const nestedWorkspace = path.join(root, "workspace");
      const outsideWorkspace = path.join(root, "host-write.txt");
      await fs.mkdir(nestedWorkspace);

      const tools = new Map<string, any>();
      const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => any>>();
      const pi = new Proxy(
        {
          registerTool(tool: { name: string }) {
            tools.set(tool.name, tool);
          },
          on(event: string, handler: (event: any, ctx: ExtensionContext) => any) {
            handlers.set(event, [...(handlers.get(event) ?? []), handler]);
          },
          getActiveTools: () => [],
          setActiveTools: () => undefined,
          getThinkingLevel: () => "max",
        },
        {
          get(target, property) {
            if (property in target) return target[property as keyof typeof target];
            return () => undefined;
          },
        },
      ) as unknown as ExtensionAPI;
      runExtensionFactory(options(nestedWorkspace), pi);

      const prompts: string[] = [];
      const ctx = {
        cwd: nestedWorkspace,
        hasUI: true,
        ui: {
          setWorkingVisible: () => undefined,
          select: async (prompt: string) => {
            prompts.push(prompt);
            return "Allow once";
          },
        },
      } as unknown as ExtensionContext;
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(outsideWorkspace)}, 'approved')`,
      )}`;
      const result = await tools.get("exec_command").execute(
        "access-test",
        { cmd: command, yield_time_ms: 10_000, timeout_ms: 30_000 },
        undefined,
        undefined,
        ctx,
      );

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Allow unrestricted host access?");
      expect(result.details).toMatchObject({ running: false, exitCode: 0, sandbox: "host" });
      await expect(fs.readFile(outsideWorkspace, "utf8")).resolves.toBe("approved");
    },
  );
});

function options(cwd: string): DSCodeRuntimeOptions {
  return {
    cwd,
    providerId: "deepseek",
    baseUrl: "https://api.deepseek.com",
    modelId: "deepseek-v4-flash",
    transport: "responses",
    harness: "minimal",
    permission: "auto",
    sandbox: "workspace-write",
    network: false,
    webSearch: false,
    activeTools: ["update_plan", "exec_command", "write_stdin", "apply_patch"],
    toolsExplicit: false,
  };
}

function runExtensionFactory(
  extensionOptions: DSCodeRuntimeOptions,
  pi: ExtensionAPI,
): void | Promise<void> {
  const extension = createDSCodeExtension(extensionOptions);
  return typeof extension === "function" ? extension(pi) : extension.factory(pi);
}
