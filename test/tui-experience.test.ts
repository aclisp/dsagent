import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  minimalStatusParts,
  panelLine,
  renderMinimalStatus,
} from "../src/tui-experience.js";

const theme = {
  fg: (_color: string, text: string) => text,
  getBgAnsi: () => "\x1b[48;5;254m",
  getColorMode: () => "256color",
} as unknown as Theme;

describe("DSCode Codex-style input presentation", () => {
  it("keeps the default status compact", () => {
    const details = {
      model: "deepseek-v4-flash",
      effort: "max",
      permission: "auto" as const,
      sandbox: "workspace-write" as const,
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

  it("truncates the compact status safely", () => {
    const rendered = renderMinimalStatus(
      18,
      {
        model: "deepseek-v4-flash",
        effort: "max",
        permission: "auto",
        sandbox: "workspace-write",
        cwd: "/a/very/long/workspace",
        contextPercent: 2,
      },
      theme,
    );
    expect(visibleWidth(rendered)).toBeLessThanOrEqual(18);
  });
});
