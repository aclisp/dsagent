import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { confirmScrollable } from "./scrollable-confirmation.js";

export type McpApprovalChoice = "once" | "tool" | "server" | "deny";

export function confirmMcpTool(
  ui: ExtensionUIContext,
  server: string,
  tool: string,
  parameters: string,
): Promise<McpApprovalChoice> {
  return confirmScrollable<McpApprovalChoice>(ui, {
    title: "Allow MCP tool?",
    titleColor: "accent",
    content: `Server: ${server}\nTool: ${tool}\n\n${parameters}`,
    summary: "Session permissions cover future calls with any parameters.",
    choices: [
      { label: "Allow once", value: "once" },
      { label: "Allow this tool for this session", value: "tool" },
      { label: "Allow all tools from this server for this session", value: "server" },
      { label: "Deny", value: "deny" },
    ],
    cancelValue: "deny",
    confirmLabel: "confirm",
  });
}
