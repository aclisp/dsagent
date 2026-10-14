import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  oneLine,
  renderCollapsibleToolResult,
  renderToolCall,
  type ToolPresentationContext,
} from "../packages/core/src/tool-ui.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const context = {
  isError: false,
  isPartial: false,
} as ToolPresentationContext;
const bindings = { "app.tools.expand": { defaultKeys: "ctrl+o" as const } };

describe("compact Codex-style tool presentation", () => {
  const previousKeybindings = getKeybindings();
  beforeEach(() => setKeybindings(new KeybindingsManager(bindings)));
  afterEach(() => setKeybindings(previousKeybindings));

  it("renders tool calls as a single bullet row", () => {
    expect(renderToolCall("Ran", "pnpm   test\n--run", theme, context).render(80)[0]?.trim()).toBe(
      "• Ran pnpm test --run",
    );
  });

  it("hides successful exploration output until expanded", () => {
    const rendered = renderCollapsibleToolResult(
      { content: [{ type: "text", text: "one\ntwo" }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      context,
      { collapsedSummary: false },
    );
    expect(rendered.render(80)).toEqual([]);
  });

  it("shows a one-line summary and expands on demand", () => {
    const result = { content: [{ type: "text" as const, text: "one\ntwo" }], details: {} };
    expect(
      renderCollapsibleToolResult(
        result,
        { expanded: false, isPartial: false },
        theme,
        context,
      ).render(80)[0],
    ).toContain("2 output lines · ctrl+o to expand");
    expect(
      renderCollapsibleToolResult(
        result,
        { expanded: true, isPartial: false },
        theme,
        context,
      )
        .render(80)
        .join("\n"),
    ).toContain("└ one");
  });

  it("automatically exposes errors without expanding every success", () => {
    const rendered = renderCollapsibleToolResult(
      { content: [{ type: "text", text: "failed\ndetails" }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      context,
      { forceError: true },
    )
      .render(80)
      .join("\n");
    expect(rendered).toContain("└ failed");
    expect(rendered).toContain("details");
  });

  it("uses remapped expansion keys for successful and truncated error output", () => {
    setKeybindings(new KeybindingsManager(bindings, { "app.tools.expand": ["ctrl+y", "alt+y"] }));
    const hint = `ctrl+y/${process.platform === "darwin" ? "option" : "alt"}+y to expand`;
    const result = { content: [{ type: "text" as const, text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") }], details: {} };
    for (const isError of [false, true]) {
      const rendered = renderCollapsibleToolResult(result, { expanded: false, isPartial: false }, theme, { ...context, isError })
        .render(200).join("\n");
      expect(rendered).toContain(hint);
      expect(rendered).not.toContain("ctrl+o");
      if (isError) expect(rendered).toContain("8 more lines");
    }
  });

  it("normalizes multiline details for compact headers", () => {
    expect(oneLine("  rg   foo\nbar  ")).toBe("rg foo bar");
  });
});
