export function cleanupManagedInstall() {}
export function handlePackageCommand(args) {
  if (["install", "remove", "update", "list"].includes(args[0])) {
    throw new Error("Package management is unavailable in the standalone CLI");
  }
  return false;
}
export function handleConfigCommand(args) {
  if (args[0] === "config") throw new Error("Package configuration is unavailable in the standalone CLI");
  return false;
}
