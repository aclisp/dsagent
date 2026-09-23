import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { confirmMcpTool } from "../packages/core/src/mcp-confirmation.js";
import { confirmDestructiveCommand } from "../packages/core/src/destructive-command-confirmation.js";

function dialogHarness(rows = 24) {
  let component!: Component;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
  const tui = { mode: "fullscreen", terminal: { rows }, requestRender: vi.fn() } as unknown as TUI;
  const keys = { matches: (input: string, binding: string) => input === binding } as KeybindingsManager;
  const custom = vi.fn((factory: any) => new Promise((done) => {
    component = factory(tui, theme, keys, done);
  }));
  return {
    ui: { custom } as unknown as ExtensionUIContext,
    render: (width = 100) => component.render(width),
    key: (name: string) => component.handleInput?.(`tui.select.${name}`),
  };
}

describe("MCP confirmation", () => {
  it("shows server, tool, parameters and defaults to Allow once", async () => {
    const h = dialogHarness();
    const result = confirmMcpTool(h.ui, "my__server", "remove", '{"path":"example"}');
    const rendered = h.render().join("\n");
    expect(rendered).toContain("Server: my__server");
    expect(rendered).toContain("Tool: remove");
    expect(rendered).toContain('{"path":"example"}');
    expect(rendered).toContain("→ Allow once");
    expect(rendered).toContain("future calls with any parameters");
    h.key("confirm");
    expect(await result).toBe("once");
  });

  it.each([[1, "tool"], [2, "server"], [3, "deny"]] as const)("selects option %i", async (steps, choice) => {
    const h = dialogHarness();
    const result = confirmMcpTool(h.ui, "server", "tool", "{}");
    for (let i = 0; i < steps; i++) h.key("down");
    h.key("confirm");
    expect(await result).toBe(choice);
  });

  it("cancels without granting a permission", async () => {
    const h = dialogHarness();
    const result = confirmMcpTool(h.ui, "server", "tool", "{}");
    h.key("down");
    h.key("cancel");
    expect(await result).toBe("deny");
  });

  it.each([16, 24, 40])("keeps all choices visible while paging long parameters in %i rows", async (rows) => {
    const h = dialogHarness(rows);
    const content = Array.from({ length: 200 }, (_, i) => `parameter line ${i}`).join("\n");
    const result = confirmMcpTool(h.ui, "server", "tool", content);
    const before = h.render();
    expect(before.length).toBeLessThanOrEqual(Math.floor(rows * 0.9));
    h.key("pageDown");
    const after = h.render().join("\n");
    expect(after).not.toBe(before.join("\n"));
    expect(after).toContain("Allow once");
    expect(after).toContain("Allow this tool for this session");
    expect(after).toContain("Allow all tools from this server for this session");
    expect(after).toContain("Deny");
    expect(after).toContain("Enter confirm");
    h.key("cancel");
    await result;
  });

  it("preserves the destructive command dialog choices", async () => {
    const h = dialogHarness();
    const result = confirmDestructiveCommand(h.ui, "rm example", { dangerous: true, intent: "Delete files" });
    expect(h.render().join("\n")).toContain("→ Run command");
    h.key("down");
    h.key("confirm");
    expect(await result).toBe(false);
  });
});
