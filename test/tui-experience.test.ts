import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  highlightImageMarkers,
  minimalStatusParts,
  panelLine,
  renderMinimalStatus,
  stripFakeCursorHighlight,
} from "../packages/core/src/tui-experience.js";

const theme = {
  fg: (color: string, text: string) =>
    color === "accent" ? `<accent>${text}</accent>` : text,
  inverse: (text: string) => `<inverse>${text}</inverse>`,
  getBgAnsi: () => "\x1b[48;5;254m",
  getColorMode: () => "256color",
} as unknown as Theme;

describe("DSCode Codex-style input presentation", () => {
  it("removes Pi's steady fake cursor when the native cursor is active", () => {
    expect(stripFakeCursorHighlight(`before${CURSOR_MARKER}\x1b[7mW\x1b[0mrite`)).toBe(
      `before${CURSOR_MARKER}Write`,
    );
  });

  it("keeps the default status compact", () => {
    const details = {
      model: "deepseek-v4-flash",
      effort: "max",
      permission: "auto" as const,
      sandbox: "workspace-write" as const,
      network: false,
      cwd: "/work/dscode",
      contextPercent: 4.9,
    };
    const parts = minimalStatusParts(details);
    expect(parts).toEqual(["deepseek-v4-flash  max", "/work/dscode"]);
    expect(renderMinimalStatus(52, details, theme)).not.toContain("4.9");
    expect(renderMinimalStatus(52, details, theme)).not.toContain("auto");
  });

  it("only surfaces safety and context exceptions", () => {
    expect(
      minimalStatusParts({
        model: "deepseek-v4-flash",
        effort: "max",
        permission: "plan",
        sandbox: "danger-full-access",
        network: false,
        cwd: "/work/dscode",
        contextPercent: 91.2,
      }),
    ).toEqual([
      "deepseek-v4-flash  max",
      "plan",
      "ctx 91%",
      "/work/dscode",
    ]);
    expect(
      minimalStatusParts({
        model: "deepseek-v4-flash",
        effort: "max",
        permission: "full",
        sandbox: "danger-full-access",
        network: true,
        cwd: "/work/dscode",
        contextPercent: 12,
      }),
    ).toContain("danger full access");
  });

  it("fills a panel row without bringing back a border", () => {
    const rendered = panelLine("> hello", 28, theme);
    expect(visibleWidth(rendered)).toBe(28);
    expect(rendered).toContain("\x1b[48;5;254m");
    expect(rendered).not.toContain("─");
  });

  it("renders pasted image markers as compact accent tokens", () => {
    expect(
      highlightImageMarkers("> [Image #1] explain", [{ index: 1, path: "/tmp/image.png" }], theme),
    ).toBe("> <accent>[Image #1]</accent> explain");
  });

  it("truncates the compact status safely", () => {
    const rendered = renderMinimalStatus(
      18,
      {
        model: "deepseek-v4-flash",
        effort: "max",
        permission: "auto",
        sandbox: "workspace-write",
        network: false,
        cwd: "/a/very/long/workspace",
        contextPercent: 2,
      },
      theme,
    );
    expect(visibleWidth(rendered)).toBeLessThanOrEqual(18);
  });

  it("anchors usage to the right and preserves access warnings before long names", () => {
    const details = {
      model: "a-very-long-model-name-that-must-shrink",
      effort: "max",
      permission: "full" as const,
      sandbox: "danger-full-access" as const,
      network: true,
      cwd: "/工作/很长的项目目录/dscode",
      contextPercent: 2,
      usage: { latestCacheHitRate: 92.44, cost: 0.0382 },
    };
    for (const width of [72, 100, 140]) {
      const rendered = renderMinimalStatus(width, details, theme);
      expect(visibleWidth(rendered)).toBe(width);
      expect(rendered).toContain("danger full access");
      expect(rendered).toMatch(/cache 92\.4% · \$0\.038  $/);
      expect(rendered).not.toContain("\n");
    }
    for (let width = 0; width < 72; width++) {
      expect(visibleWidth(renderMinimalStatus(width, details, theme))).toBeLessThanOrEqual(width);
    }
    expect(renderMinimalStatus(22, details, theme)).toMatch(/92\.4% · \$0\.038  $/);
  });

  it("distinguishes missing cache usage from a zero hit rate", () => {
    const details = {
      model: "gpt-6-luna",
      effort: "max",
      permission: "auto" as const,
      sandbox: "workspace-write" as const,
      network: false,
      cwd: "/work/dscode",
      contextPercent: null,
    };
    expect(renderMinimalStatus(100, details, theme)).toMatch(/cache — · \$0\.000  $/);
    expect(renderMinimalStatus(100, {
      ...details,
      usage: { latestCacheHitRate: 0, cost: 12.3456 },
    }, theme)).toMatch(/cache 0\.0% · \$12\.346  $/);
  });
});
