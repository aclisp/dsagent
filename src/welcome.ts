import os from "node:os";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { brandBlue } from "./brand.js";

export interface WelcomeDetails {
  cwd: string;
  modelId: string;
  effort: string;
  username?: string;
}

/** Terminal pixel-art rendering of DSCode's block-whale logo. */
export const DSCODE_LOGO = [
  "      ▀▄▀",
  "▄▄▄███████▄",
  " ████████ █",
  "█▀▀███████▀",
  "     ██",
];

export class DSCodeWelcomeHeader implements Component {
  constructor(
    private readonly details: WelcomeDetails,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    return renderWelcome(width, this.details, this.theme);
  }

  invalidate(): void {}
}

export function renderWelcome(width: number, details: WelcomeDetails, theme: Theme): string[] {
  if (width <= 0) return [];
  const cardWidth = Math.min(width, 86);
  if (cardWidth < 18) {
    return [truncateToWidth(brandBlue("DSCode", theme), width, "")];
  }
  const indent = " ".repeat(Math.max(0, Math.floor((width - cardWidth) / 2)));
  const innerWidth = cardWidth - 2;
  const username = details.username?.trim() || safeUsername();
  const logo = DSCODE_LOGO;
  const border = (value: string): string => brandBlue(value, theme);
  const body = (value: string): string => {
    const content = truncateToWidth(value, innerWidth, theme.fg("dim", "…"));
    const left = Math.max(0, Math.floor((innerWidth - visibleWidth(content)) / 2));
    const right = Math.max(0, innerWidth - left - visibleWidth(content));
    return `${indent}${border("│")}${" ".repeat(left)}${content}${" ".repeat(right)}${border("│")}`;
  };
  const title = " DSCode ";
  const topFill = "─".repeat(Math.max(0, cardWidth - 2 - visibleWidth(title) - 1));
  const lines = [
    `${indent}${border(`╭─${title}${topFill}╮`)}`,
    body(""),
    body(theme.bold(`Welcome back, ${username}!`)),
    body(""),
    ...normalizeLogo(logo).map((line) => body(brandBlue(line, theme))),
    body(""),
    body(theme.fg("muted", `${humanizeModel(details.modelId)} (1M context)`)),
    body(theme.fg("muted", `DeepSeek API · ${details.effort} effort`)),
    body(theme.fg("muted", formatCwd(details.cwd))),
    body(""),
    `${indent}${border(`╰${"─".repeat(cardWidth - 2)}╯`)}`,
  ];
  const hint = theme.fg("dim", "Type /help for commands · /status for usage");
  const hintIndent = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(hint)) / 2)));
  return [...lines, "", `${hintIndent}${truncateToWidth(hint, width, "")}`];
}

export function formatCwd(cwd: string): string {
  const homeDirectory = os.homedir();
  return cwd === homeDirectory || cwd.startsWith(`${homeDirectory}${path.sep}`)
    ? `~${cwd.slice(homeDirectory.length)}`
    : cwd;
}

function humanizeModel(modelId: string): string {
  if (modelId === "deepseek-v4-flash") return "DeepSeek V4 Flash";
  return modelId;
}

function safeUsername(): string {
  try {
    return os.userInfo().username || "developer";
  } catch {
    return process.env.USER || "developer";
  }
}

function normalizeLogo(lines: string[]): string[] {
  const width = Math.max(...lines.map((line) => visibleWidth(line)));
  return lines.map((line) => `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`);
}
