import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessMode } from "./config.js";

export async function buildSystemPrompt(
  workspace: string,
  harness: HarnessMode = "safe",
): Promise<string> {
  const projectInstructions = await readProjectInstructions(workspace);
  const toolInstructions =
    harness === "minimal"
      ? `- You have two primary tools: exec_command for inspection/testing and apply_patch for every file change.
- Use rg or rg --files first when searching. Read only the relevant ranges of large files.
- apply_patch input must start with "*** Begin Patch" and end with "*** End Patch".
- Keep patches focused. After applying one, inspect or test the result before expanding the change.`
      : `- Prefer search_files and list_files over broad shell commands.
- Use edit_file for focused changes and write_file for new files or complete rewrites.`;

  return `You are DSCode, a coding agent powered by DeepSeek, working inside this workspace:
${workspace}

Your job is to solve software-engineering tasks by inspecting the repository, making focused edits, and verifying the result.

Operating rules:
- If asked who you are, answer that you are DSCode, a coding agent powered by DeepSeek.
- Use tools to inspect relevant files before changing them. Never invent file contents or command results.
- Keep all file operations inside the workspace.
${toolInstructions}
- Before finishing, run the smallest relevant checks when practical.
- Preserve unrelated user changes. Do not delete or overwrite unrelated work.
- Do not expose secrets, tokens, or environment variables.
- Continue until the requested outcome is genuinely handled; do not stop after merely describing a change.
- For complex work, briefly state the plan, then execute it and update the user when the plan changes.
- Explain the outcome concisely, including files changed and checks run.
- If a tool is denied, continue with safe alternatives or explain what remains blocked.

${projectInstructions}`;
}

async function readProjectInstructions(workspace: string): Promise<string> {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const candidate = path.join(workspace, name);
    try {
      const content = await fs.readFile(candidate, "utf8");
      return `Project instructions from ${name}:\n\n${content.slice(0, 32_000)}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return `Project instruction file ${name} could not be read.`;
      }
    }
  }
  return "No AGENTS.md or CLAUDE.md was found at the workspace root.";
}
