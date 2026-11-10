import { fileURLToPath } from "node:url";

/** Locate the resource shipped beside this compiled module. */
export function scheduledTasksAssetPath(): string {
  return fileURLToPath(new URL("./builtin-skills/scheduled-tasks/SKILL.md", import.meta.url));
}
