import { fileURLToPath } from "node:url";

/** DSCode's palettes are exact copies of Pi 0.87.1, with only their names changed. */
export function getDSCodeThemePaths(): string[] {
  return ["light", "dark"].map((appearance) =>
    fileURLToPath(new URL(`../themes/dscode-${appearance}.json`, import.meta.url)),
  );
}
