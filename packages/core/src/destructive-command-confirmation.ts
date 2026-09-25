import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_DANGEROUS_COMMAND_INTENT,
  type DangerousCommandResult,
} from "./dangerous-command.js";
import { confirmScrollable } from "./scrollable-confirmation.js";

/** Terminal confirmation with a scrollable command and a fixed decision area. */
export function confirmDestructiveCommand(
  ui: ExtensionUIContext,
  command: string,
  assessment: DangerousCommandResult,
): Promise<boolean> {
  return confirmScrollable(ui, {
    title: "Run destructive command?",
    titleColor: "error",
    content: command,
    summary: assessment.intent ?? DEFAULT_DANGEROUS_COMMAND_INTENT,
    choices: [
      { label: "Run command", value: true },
      { label: "Cancel", value: false },
    ],
    cancelValue: false,
    confirmLabel: "run",
  });
}
