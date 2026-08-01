import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const COLLAPSED_ERROR_LINES = 12;

export interface ToolPresentationContext {
  isError: boolean;
  isPartial: boolean;
}

export function renderToolCall(
  label: string,
  detail: string | undefined,
  theme: Theme,
  context: ToolPresentationContext,
): Text {
  const bulletColor = context.isError ? "error" : context.isPartial ? "muted" : "success";
  const normalizedDetail = detail ? oneLine(detail) : "";
  return new Text(
    `${theme.fg(bulletColor, "•")} ${theme.fg("toolTitle", theme.bold(label))}${
      normalizedDetail ? ` ${theme.fg("muted", normalizedDetail)}` : ""
    }`,
    0,
    0,
  );
}

export function renderCollapsibleToolResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolPresentationContext,
  config: { collapsedSummary?: string | false; forceError?: boolean } = {},
): Text {
  const output = toolResultText(result).trimEnd();
  if (!output) return new Text("", 0, 0);
  const error = context.isError || config.forceError === true;
  if (options.expanded || error) {
    const lines = output.split("\n");
    const visibleLines = options.expanded ? lines : lines.slice(0, COLLAPSED_ERROR_LINES);
    const hidden = lines.length - visibleLines.length;
    const rendered = visibleLines
      .map((line, index) => theme.fg(error ? "error" : "toolOutput", `${index === 0 ? "  └ " : "    "}${line}`))
      .join("\n");
    return new Text(
      hidden > 0
        ? `${rendered}\n${theme.fg("muted", `    … ${hidden} more lines · Ctrl+O to expand`)}`
        : rendered,
      0,
      0,
    );
  }
  if (config.collapsedSummary === false) return new Text("", 0, 0);
  const lineCount = output.split("\n").length;
  const summary = config.collapsedSummary ?? `${lineCount} output ${lineCount === 1 ? "line" : "lines"}`;
  return new Text(theme.fg("dim", `  └ ${summary} · Ctrl+O to expand`), 0, 0);
}

export function toolResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export function oneLine(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}
