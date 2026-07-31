import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const LEGACY_AGENT_ENTRIES = [
  "auth.json",
  "settings.json",
  "models.json",
  "models-store.json",
  "trust.json",
  "skills",
  "extensions",
  "prompts",
  "themes",
  "bin",
  "packages",
  "npm",
  "git",
] as const;

export function getDSCodeHome(): string {
  return resolveHomePath(process.env.DSCODE_HOME ?? path.join(os.homedir(), ".dscode"));
}

export function getDSCodeSessionsDir(): string {
  return resolveHomePath(
    process.env.DSCODE_SESSIONS_DIR ?? path.join(getDSCodeHome(), "sessions"),
  );
}

/** Configure the underlying runtime to use DSCode-owned paths only. */
export async function initializeDSCodeHome(): Promise<string> {
  const home = getDSCodeHome();
  const sessions = getDSCodeSessionsDir();
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessions;

  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700).catch(() => undefined);
  if (process.env.DSCODE_HOME === undefined) {
    await migrateLegacyDSCodeHome(home);
  }
  await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
  await fs.chmod(sessions, 0o700).catch(() => undefined);
  return home;
}

/** Copy legacy ~/.dscode/agent contents upward without overwriting or deleting anything. */
export async function migrateLegacyDSCodeHome(home = getDSCodeHome()): Promise<string[]> {
  const legacy = path.join(home, "agent");
  const migrated: string[] = [];
  for (const entry of LEGACY_AGENT_ENTRIES) {
    const source = path.join(legacy, entry);
    const target = path.join(home, entry);
    if (!(await exists(source)) || (await exists(target))) continue;
    await fs.cp(source, target, { recursive: true, preserveTimestamps: true });
    migrated.push(entry);
  }
  for (const file of ["auth.json", "settings.json", "trust.json"]) {
    await fs.chmod(path.join(home, file), 0o600).catch(() => undefined);
  }
  return migrated;
}

function resolveHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
