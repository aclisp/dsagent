import process from "node:process";

export const WEB_UI_SUBAGENT_DEPTH = 1;
export const DEFAULT_WEB_UI_RUNTIME_ARGS = [
  "--provider",
  "openrouter",
  "--model",
  "deepseek-v4-flash-0731",
  "--permission",
  "auto",
  "--network",
  "--effort",
  "max",
  "--tools",
  "read,exec_command,write_stdin,apply_patch",
] as const;

export function resolveWebUiRuntimeArgs(value: string | undefined): string[] {
  const trimmed = value?.trim();
  return trimmed ? trimmed.split(/\s+/) : [...DEFAULT_WEB_UI_RUNTIME_ARGS];
}

/** Web UI does not support subagents; keep Core's recursion guard at the first child level. */
export function enforceWebUiSubagentDepth(): void {
  process.env.DSCODE_SUBAGENT_DEPTH = String(WEB_UI_SUBAGENT_DEPTH);
}
