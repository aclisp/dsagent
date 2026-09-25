// No privileged vision subprocess or provider-credential forwarding in this build.
export const DEFAULT_VISION_CLI_EXECUTABLE = "/standalone-vision-unavailable";
export function parseTrustedVisionCommand() { return undefined; }
export function classifyVisionCommand(command) {
  return /^\s*dscode-vision(?:\s|$)/.test(command)
    ? { kind: "invalid", reason: "dscode-vision is not included; use image attachments or read" }
    : { kind: "other" };
}
export function createVisionProcessEnvironment() {
  throw new Error("The standalone CLI has no privileged vision subprocess");
}
