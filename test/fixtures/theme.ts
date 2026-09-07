import type { Theme } from "@earendil-works/pi-coding-agent";

/** Minimal theme implementation for extension tests that exercise status rendering. */
export function createTestTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    getColorMode: () => "256color",
  } as unknown as Theme;
}
