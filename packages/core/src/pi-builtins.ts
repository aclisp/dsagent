import type { InlineExtension } from "@earendil-works/pi-coding-agent";

// Pi's main prepends its built-ins. DefaultResourceLoader resolves duplicate
// built-in names to the last factory, so these replacements prevent startup and
// /reload from loading Pi's MCP/codemode stack without changing user settings.
// DSCode keeps its own MCP extension and ordinary chat model/tool execution.
export const dscodePiBuiltinOverrides: InlineExtension[] = [
  "mcp", "codemode", "tool-search",
].map((name) => ({ name, builtin: true, factory: () => {} }));
