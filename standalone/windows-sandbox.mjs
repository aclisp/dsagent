export function windowsNativeSandboxEnabled() { return false; }
export function parseWindowsSandboxLifecycleCommand(args) {
  if (args[0] === "sandbox") throw new Error("Windows sandbox management is unavailable in this build");
}
export function runWindowsSandboxLifecycle() { throw new Error("The native Windows sandbox is unavailable in the standalone CLI"); }
export function windowsNativeSandboxCommand() { throw new Error("The native Windows sandbox is unavailable in the standalone CLI"); }
export function windowsNativeSandboxDescription() { throw new Error("The native Windows sandbox is unavailable in the standalone CLI"); }
