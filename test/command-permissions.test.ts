import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";

vi.mock("../packages/core/src/hooks.ts", () => ({ registerHooks: vi.fn() }));

async function harness(permission: string, hasUI: boolean) {
  const handlers: ((event: any, ctx: ExtensionContext) => any)[] = [];
  const pi = new Proxy({
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) {
      if (name === "tool_call") handlers.push(handler);
    },
    getAllTools: () => [],
    getActiveTools: () => [],
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as ExtensionAPI;
  const extension = createDSCodeExtension(parseRuntimeArgs(["--permission", permission]).options);
  await (typeof extension === "function" ? extension : extension.factory)(pi);
  const confirm = vi.fn().mockResolvedValue(false);
  const ctx = { cwd: process.cwd(), mode: "rpc", hasUI, ui: { confirm } } as unknown as ExtensionContext;
  return {
    confirm,
    async call(cmd: string) {
      for (const handler of handlers) {
        const result = await handler({ toolName: "exec_command", input: { cmd } }, ctx);
        if (result?.block) return result;
      }
    },
  };
}

describe("DSCode launch command permissions", () => {
  it("requires the parent's auto approval even when the child selects full permissions", async () => {
    const h = await harness("auto", true);
    const cmd = "dscode --permission full --network -p 'perform the task'";
    expect(await h.call(cmd)).toMatchObject({ block: true, reason: "Destructive command denied by user" });
    expect(h.confirm).toHaveBeenCalledWith("Run destructive command?", expect.stringContaining("Launch a DSCode agent with independent permissions"));
    h.confirm.mockResolvedValue(true);
    expect(await h.call(cmd)).toBeUndefined();
  });

  it("blocks noninteractive auto launches while allowing help and version commands", async () => {
    const h = await harness("auto", false);
    expect(await h.call("dscode -p 'read the project'"))
      .toMatchObject({ block: true, reason: expect.stringContaining("interactive approval UI") });
    expect(await h.call("dscode --help")).toBeUndefined();
    expect(await h.call("dscode --version")).toBeUndefined();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("allows full parent mode without introducing another approval flow", async () => {
    const h = await harness("full", false);
    expect(await h.call("dscode --permission full -p 'perform the task'")).toBeUndefined();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});
