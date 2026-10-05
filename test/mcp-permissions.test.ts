import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import { createTestTheme } from "./fixtures/theme.ts";

vi.mock("../packages/core/src/hooks.ts", () => ({ registerHooks: vi.fn() }));

async function harness(permission = "auto") {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const commands = new Map<string, any>();
  const definitions = [
    { name: "mcp__docs__read", namespace: { name: "mcp__docs" }, annotations: { readOnlyHint: true }, description: "Read a document" },
    { name: "mcp__docs__write", namespace: { name: "mcp__docs" }, annotations: { readOnlyHint: false } },
    { name: "mcp__other__read", namespace: { name: "mcp__other" } },
    { name: "mcp__unknown__tool" },
  ];
  const pi = new Proxy({
    on(name: string, handler: (event: any, ctx: any) => any) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
    getAllTools: () => definitions,
    getActiveTools: () => [],
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as ExtensionAPI;
  const extension = createDSCodeExtension(parseRuntimeArgs(["--permission", permission]).options);
  await (typeof extension === "function" ? extension : extension.factory)(pi);
  const select = vi.fn<(...args: any[]) => Promise<string | undefined>>().mockResolvedValue("Deny");
  const notify = vi.fn();
  const ui = new Proxy({ select, notify, theme: createTestTheme() }, {
    get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined,
  });
  const ctx = {
    cwd: process.cwd(), mode: "rpc", hasUI: true, ui,
    sessionManager: { getBranch: () => [], getSessionFile: () => undefined, buildSessionProjection: () => ({ messages: [] }) },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: any) => {
    for (const handler of handlers.get(name) ?? []) {
      const result = await handler(event, ctx);
      if (result?.block) return result;
    }
  };
  return {
    select, notify, ctx,
    call: (tool = "mcp__docs__read", input = {}) => emit("tool_call", { toolName: tool, input }),
    permissions: (args = "") => commands.get("permissions").handler(args, ctx),
    start: (reason: string) => emit("session_start", { reason }),
    shutdown: () => emit("session_shutdown", { reason: "new" }),
  };
}

describe("MCP session permissions", () => {
  it.each(["ask", "auto"])("requires an explicit grant even for readOnlyHint=true in %s", async (permission) => {
    const h = await harness(permission);
    expect(await h.call()).toMatchObject({ block: true });
    expect(h.select.mock.calls[0]![0]).toContain("Read-only hint: true");
    expect(h.select.mock.calls[0]![0]).toContain("Read a document");
    h.select.mockResolvedValue("Allow once");
    expect(await h.call()).toBeUndefined();
    expect(await h.call()).toBeUndefined();
    expect(h.select).toHaveBeenCalledTimes(3);
  });

  it("grants only the selected tool across different arguments and displays/revokes it", async () => {
    const h = await harness();
    h.select.mockResolvedValueOnce("Allow this tool for this session");
    expect(await h.call()).toBeUndefined();
    expect(await h.call("mcp__docs__read", { path: "another" })).toBeUndefined();
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(await h.call("mcp__docs__write")).toMatchObject({ block: true });
    expect(h.select.mock.calls[1]![0]).toContain("Read-only hint: false");
    await h.permissions();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("MCP session grants: mcp__docs__read"), "info");
    await h.permissions("revoke-mcp mcp__docs__read");
    expect(await h.call()).toMatchObject({ block: true });
  });

  it("rechecks a server grant in the approval queue without granting other servers", async () => {
    const h = await harness();
    h.select.mockResolvedValueOnce("Allow all tools from this server for this session");
    expect(await Promise.all([h.call(), h.call("mcp__docs__write")])).toEqual([undefined, undefined]);
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(await h.call("mcp__other__read")).toMatchObject({ block: true });
    expect(h.select.mock.calls[1]![0]).toContain("Not provided — read-only status unknown");
    await h.permissions();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("mcp__docs (all tools)"), "info");
    await h.permissions("revoke-mcp mcp__docs");
    expect(await h.call("mcp__docs__write")).toMatchObject({ block: true });
  });

  it.each(["new", "resume", "fork", "reload"])("clears grants on %s", async (reason) => {
    const h = await harness();
    h.select.mockResolvedValueOnce("Allow this tool for this session");
    await h.call();
    await h.start(reason);
    expect(await h.call()).toMatchObject({ block: true });
  });

  it("revokes individual tool grants by server namespace and clears mixed grants with all", async () => {
    const h = await harness();
    h.select.mockResolvedValueOnce("Allow this tool for this session");
    await h.call();
    await h.permissions("revoke-mcp mcp__docs");
    expect(await h.call()).toMatchObject({ block: true });
    h.select.mockResolvedValueOnce("Allow this tool for this session")
      .mockResolvedValueOnce("Allow all tools from this server for this session");
    await h.call();
    await h.call("mcp__other__read");
    await h.permissions("revoke-mcp all");
    await h.permissions();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("MCP session grants: none"), "info");
    expect(await h.call()).toMatchObject({ block: true });
    expect(await h.call("mcp__other__read")).toMatchObject({ block: true });
  });

  it.each(["revoke", "shutdown"])("rejects queued and in-flight approvals after %s", async (action) => {
    const h = await harness();
    let resolve!: (choice: string) => void;
    h.select.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
    const first = h.call();
    const queued = h.call("mcp__docs__write");
    await vi.waitFor(() => expect(h.select).toHaveBeenCalledTimes(1));
    if (action === "revoke") await h.permissions("revoke-mcp all");
    else await h.shutdown();
    resolve("Allow all tools from this server for this session");
    expect(await first).toMatchObject({ block: true, reason: expect.stringContaining("context changed") });
    expect(await queued).toMatchObject({ block: true });
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(await h.call()).toMatchObject({ block: true, reason: "Denied by user" });
  });

  it("cancels without granting permission and offers no server grant without namespace metadata", async () => {
    const h = await harness();
    h.select.mockResolvedValueOnce(undefined);
    expect(await h.call("mcp__unknown__tool")).toMatchObject({ block: true });
    expect(h.select.mock.calls[0]![1]).not.toContain("Allow all tools from this server for this session");
    expect(await h.call("mcp__unknown__tool")).toMatchObject({ block: true });
    expect(h.select).toHaveBeenCalledTimes(2);
  });

  it("allows full mode and resource helpers, but blocks unapproved noninteractive calls", async () => {
    const full = await harness("full");
    expect(await full.call()).toBeUndefined();
    expect(full.select).not.toHaveBeenCalled();
    const h = await harness("ask");
    for (const tool of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
      expect(await h.call(tool)).toBeUndefined();
    }
    h.ctx.hasUI = false;
    expect(await h.call()).toMatchObject({ block: true, reason: expect.stringContaining("interactive approval UI") });
    expect(h.select).not.toHaveBeenCalled();
  });
});
