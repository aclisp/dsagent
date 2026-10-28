// No privileged vision subprocess or provider-credential forwarding in this build.
import { classifyLiteralCommand } from "../packages/core/dist/literal-command.js";

export const DEFAULT_VISION_CLI_EXECUTABLE = "/standalone-vision-unavailable";
export function parseTrustedVisionCommand() { return undefined; }
export function classifyVisionCommand(command) {
  const result = classifyLiteralCommand(command, "dscode-vision");
  return result.kind === "other" ? result
    : { kind: "invalid", reason: "dscode-vision is not included; use image attachments or read" };
}
export function createVisionProcessEnvironment() {
  throw new Error("The standalone CLI has no privileged vision subprocess");
}
