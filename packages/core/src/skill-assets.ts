import { fileURLToPath } from "node:url";

/** Locate the resource shipped beside this compiled module. */
export function builtinSkillAssetPath(name: "scheduled-tasks" | "publish-artifact"): string {
  return fileURLToPath(new URL(`./builtin-skills/${name}/SKILL.md`, import.meta.url));
}
