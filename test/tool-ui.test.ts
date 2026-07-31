import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  oneLine,
  renderCollapsibleToolResult,
  renderToolCall,
  type ToolPresentationContext,
} from "../packages/core/src/tool-ui.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const context = {
  isError: false,
  isPartial: false,
} as ToolPresentationContext;

describe("compact Codex-style tool presentation", () => {
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
    ).toContain("2 output lines · Ctrl+O to expand");
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

  it("normalizes multiline details for compact headers", () => {
    expect(oneLine("  rg   foo\nbar  ")).toBe("rg foo bar");
  });
});
