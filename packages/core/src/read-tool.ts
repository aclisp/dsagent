import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderCollapsibleToolResult, renderToolCall } from "./tool-ui.js";

/** Keep pi's read semantics while using the same presentation as DSCode tools. */
export function createDSCodeReadTool(cwd: string): ReturnType<typeof createReadToolDefinition> {
  return {
    ...createReadToolDefinition(cwd),
    renderShell: "self",
    renderCall(args, theme, context) {
      const start = args.offset ?? 1;
      const range = args.limit !== undefined
        ? `:${start}-${start + args.limit - 1}`
        : args.offset !== undefined ? `:${start}…` : "";
      return renderToolCall("Read", `${args.path ?? "file"}${range}`, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderCollapsibleToolResult(result, options, theme, context);
    },
  };
}
