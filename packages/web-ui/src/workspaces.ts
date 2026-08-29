const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function parseWorkspaces(value: string): Record<string, string> {
  const workspaces: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid WORKSPACES entry "${trimmed}" — expected id=path`);
    }
    const id = trimmed.slice(0, separator).trim();
    const cwd = trimmed.slice(separator + 1).trim();
    if (id.length === 0 || cwd.length === 0) {
      throw new Error(`Invalid WORKSPACES entry "${trimmed}" — expected id=path`);
    }
    if (!WORKSPACE_ID_PATTERN.test(id)) {
      throw new Error(
        `Invalid WORKSPACES entry "${trimmed}" — id must be 16-128 URL-safe characters`,
      );
    }
    workspaces[id] = cwd;
  }
  if (Object.keys(workspaces).length === 0) {
    throw new Error("WORKSPACES resolved to no workspaces");
  }
  return workspaces;
}
