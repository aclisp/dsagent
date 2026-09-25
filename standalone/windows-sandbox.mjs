export function windowsNativeSandboxEnabled() { return false; }
export function parseWindowsSandboxLifecycleCommand(args) {
  if (args[0] === "sandbox") throw new Error("Windows sandbox management is unavailable in this build");
}
export function runWindowsSandboxLifecycle() { throw new Error("Windows is unsupported"); }
export function windowsNativeSandboxCommand() { throw new Error("Windows is unsupported"); }
export function windowsNativeSandboxDescription() { throw new Error("Windows is unsupported"); }
