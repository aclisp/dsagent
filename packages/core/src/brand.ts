import type { Theme } from "@earendil-works/pi-coding-agent";

/** DeepSeek's electric blue, kept separate from semantic warning/error colors. */
export const DEEPSEEK_BLUE = "#4E6BFE";

export function brandBlue(text: string, theme?: Theme): string {
  if (process.env.NO_COLOR) return text;
  const open =
    theme?.getColorMode() === "256color" ? "\x1b[38;5;69m" : "\x1b[38;2;78;107;254m";
  return `${open}${text}\x1b[39m`;
}
