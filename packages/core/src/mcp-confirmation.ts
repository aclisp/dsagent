import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { confirmScrollable } from "./scrollable-confirmation.ts";

export type McpApprovalChoice = "once" | "tool" | "server" | "deny";

export interface McpApprovalInfo {
  tool: string;
  server?: string | undefined;
  description?: string | undefined;
  readOnlyHint?: boolean | undefined;
}

const descriptionSentences = new Intl.Segmenter(undefined, { granularity: "sentence" });

function summarizeDescription(description: string): string {
  const firstSentence = descriptionSentences.segment(description.trim())[Symbol.iterator]().next().value?.segment ?? "";
  const characters = Array.from(firstSentence.replace(/\s+/g, " ").trim());
  return characters.length > 200 ? `${characters.slice(0, 199).join("")}…` : characters.join("");
}

/** The same decisions and metadata in the terminal and remote UI. */
export async function confirmMcpTool(
  ui: ExtensionUIContext,
  mode: string,
  info: McpApprovalInfo,
  parameters: string,
): Promise<McpApprovalChoice> {
  const hintValue = info.readOnlyHint === undefined ? "Not provided" : String(info.readOnlyHint);
  const hintNote = info.readOnlyHint === true
    ? "Read-only, according to the server"
    : info.readOnlyHint === false
      ? "May change state, according to the server"
      : "read-only status unknown";
  const description = summarizeDescription(info.description ?? "");
  const content = (highlight: (value: string) => string = (value) => value) => [
    `Server: ${info.server ?? "Unknown"}`,
    `Tool: ${info.tool}`,
    `Read-only hint: ${highlight(hintValue)} — ${hintNote}`,
    ...(description ? [`Description: ${description}`] : []),
    "",
    parameters,
  ].join("\n");
  const summary = "Session permissions cover future calls with any parameters.";
  const choices: { label: string; value: McpApprovalChoice }[] = [
    { label: "Allow once", value: "once" },
    { label: "Allow this tool for this session", value: "tool" },
    ...(info.server ? [{ label: "Allow all tools from this server for this session", value: "server" as const }] : []),
    { label: "Deny", value: "deny" },
  ];
  if (mode === "tui") {
    return confirmScrollable(ui, {
      title: "Allow MCP tool?",
      titleColor: "accent",
      content: (theme) => content((value) => theme.bold(theme.fg("accent", value))),
      summary,
      choices,
      cancelValue: "deny",
      confirmLabel: "confirm",
    });
  }
  const selected = await ui.select(`Allow MCP tool?\n${content()}\n\n${summary}`, choices.map((choice) => choice.label));
  return choices.find((choice) => choice.label === selected)?.value ?? "deny";
}
