import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { confirmMcpTool } from "../packages/core/src/mcp-confirmation.ts";

function dialogHarness(rows = 24) {
  let component!: Component;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
  const tui = { mode: "fullscreen", terminal: { rows }, requestRender: vi.fn() } as unknown as TUI;
  const keys = { matches: (input: string, binding: string) => input === binding } as KeybindingsManager;
  const custom = vi.fn((factory: any) => new Promise((done) => { component = factory(tui, theme, keys, done); }));
  return {
    ui: { custom } as unknown as ExtensionUIContext,
    render: () => component.render(100).join("\n"),
    key: (name: string) => component.handleInput?.(`tui.select.${name}`),
  };
}

describe("MCP confirmation", () => {
  it.each([
    [true, "true — Read-only, according to the server"],
    [false, "false — May change state, according to the server"],
    [undefined, "Not provided — read-only status unknown"],
  ] as const)("shows the server-provided read-only hint %s", async (readOnlyHint, expected) => {
    const h = dialogHarness(40);
    const pending = confirmMcpTool(h.ui, "tui", {
      server: "mcp__my__server", tool: "mcp__my__server__remove", description: "Remove a file", readOnlyHint,
    }, '{"path":"example"}');
    const rendered = h.render();
    expect(rendered).toContain("Server: mcp__my__server");
    expect(rendered).toContain("Tool: mcp__my__server__remove");
    expect(rendered).toContain(`Read-only hint: ${expected}`);
    expect(rendered).toContain("Description: Remove a file");
    expect(rendered).toContain('{"path":"example"}');
    expect(rendered).toContain("→ Allow once");
    expect(rendered).toContain("future calls with any parameters");
    h.key("confirm");
    expect(await pending).toBe("once");
  });

  it.each([[1, "tool"], [2, "server"], [3, "deny"]] as const)("selects option %i", async (steps, choice) => {
    const h = dialogHarness();
    const pending = confirmMcpTool(h.ui, "tui", { server: "mcp__server", tool: "tool" }, "{}");
    for (let i = 0; i < steps; i++) h.key("down");
    h.key("confirm");
    expect(await pending).toBe(choice);
  });

  it.each([16, 24, 40])("keeps all choices visible while paging long arguments in %i rows", async (rows) => {
    const h = dialogHarness(rows);
    const pending = confirmMcpTool(h.ui, "tui", { server: "server", tool: "tool" }, Array.from({ length: 200 }, (_, i) => `parameter line ${i}`).join("\n"));
    const before = h.render();
    expect(before.split("\n").length).toBeLessThanOrEqual(Math.floor(rows * 0.9));
    h.key("pageDown");
    const after = h.render();
    expect(after).not.toBe(before);
    for (const label of ["Allow once", "Allow this tool for this session", "Allow all tools from this server for this session", "Deny"]) {
      expect(after).toContain(label);
    }
    h.key("cancel");
    expect(await pending).toBe("deny");
  });
});
