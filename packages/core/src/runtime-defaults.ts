import fs from "node:fs/promises";
import path from "node:path";

/** Preserve pre-0.86 request behavior unless the user opts into cache warming. */
export async function ensureDSCodeRuntimeDefaults(agentDirectory: string): Promise<void> {
  const settingsPath = path.join(agentDirectory, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    settings = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  if (settings.cacheWarming !== undefined) return;
  settings.cacheWarming = "off";
  const temporary = `${settingsPath}.${process.pid}.runtime.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, settingsPath);
}
