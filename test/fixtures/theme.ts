import type { Theme } from "@earendil-works/pi-coding-agent";

/** Minimal theme implementation for extension tests that exercise status rendering. */
export function createTestTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    getColorMode: () => "256color",
  } as unknown as Theme;
}

/** Real ANSI boundaries expose CRLF layout bugs that an identity theme hides. */
export function createAnsiTestTheme(): Theme {
  return {
    ...createTestTheme(),
    fg: (color: string, text: string) => {
      const code = color === "error" || color === "toolDiffRemoved" ? 31 : color === "toolDiffAdded" ? 32 : 37;
      return `\x1b[${code}m${text}\x1b[39m`;
    },
    bold: (text: string) => text,
  } as Theme;
}
