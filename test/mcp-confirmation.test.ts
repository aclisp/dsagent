import type { ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { confirmMcpTool } from "../packages/core/src/mcp-confirmation.ts";

function dialogHarness(rows = 24, colored = false) {
  let component!: Component;
  const theme = {
    fg: (color: string, text: string) => colored && color === "accent" ? `\x1b[36m${text}\x1b[39m` : text,
    bold: (text: string) => colored ? `\x1b[1m${text}\x1b[22m` : text,
  } as Theme;
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

  it.each([true, false, undefined])("highlights only the hint value %s", async (readOnlyHint) => {
    const h = dialogHarness(40, true);
    const pending = confirmMcpTool(h.ui, "tui", { tool: "tool", readOnlyHint }, "{}");
    const value = readOnlyHint === undefined ? "Not provided" : String(readOnlyHint);
    expect(h.render()).toContain(`Read-only hint: \x1b[1m\x1b[36m${value}\x1b[39m\x1b[22m — `);
    h.key("cancel");
    await pending;
  });

  it.each([
    ["Retrieve Directus items. More details about filters.\nExamples follow.", "Retrieve Directus items."],
    ["读取集合中的数据。后续说明与示例。", "读取集合中的数据。"],
    ["a".repeat(300), `${"a".repeat(199)}…`],
    ["😀".repeat(300), `${"😀".repeat(199)}…`],
  ])("summarizes long descriptions in remote and terminal dialogs", async (description, expected) => {
    const select = vi.fn().mockResolvedValue("Deny");
    await confirmMcpTool({ select } as unknown as ExtensionUIContext, "rpc", { tool: "tool", description }, "{}");
    expect(select.mock.calls[0]![0]).toContain(`Description: ${expected}\n\n{}`);
    const h = dialogHarness(40);
    const pending = confirmMcpTool(h.ui, "tui", { tool: "tool", description }, "{}");
    const renderedContent = h.render().split("\n").map((line) => line.slice(1, -1).trim()).join("");
    expect(renderedContent.replace(/\s/g, "")).toContain(`Description:${expected}`.replace(/\s/g, ""));
    h.key("cancel");
    await pending;
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
