import path from "node:path";

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const DEFAULT_WORKSPACE_ID = "dscode-workspace";

export function defaultWorkspacesConfig(dscodeHome: string): string {
  return `${DEFAULT_WORKSPACE_ID}=${path.join(dscodeHome, "workspace")}`;
}

export function resolveWorkspacesConfig(
  configuredWorkspaces: string | undefined,
  host: string,
  dscodeHome: string,
): string {
  if (configuredWorkspaces === undefined) {
    if (!LOOPBACK_HOSTS.has(host.trim().toLowerCase())) {
      throw new Error(
        "WORKSPACES is required when HOST is not a loopback address (use a high-entropy id=path pair)",
      );
    }
    return defaultWorkspacesConfig(dscodeHome);
  }
  if (!configuredWorkspaces.trim()) {
    throw new Error("WORKSPACES is required (comma-separated id=path pairs; ids are secrets)");
  }
  return configuredWorkspaces;
}

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
