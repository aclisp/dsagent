export const DEFAULT_WEB_UI_RUNTIME_ARGS = [
  "--provider",
  "openrouter",
  "--model",
  "deepseek-v4.1-flash",
  "--permission",
  "auto",
  "--network",
  "--effort",
  "max",
] as const;

export function resolveWebUiRuntimeArgs(value: string | undefined): string[] {
  const trimmed = value?.trim();
  return trimmed ? trimmed.split(/\s+/) : [...DEFAULT_WEB_UI_RUNTIME_ARGS];
}
