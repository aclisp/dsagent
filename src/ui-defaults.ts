import fs from "node:fs/promises";
import path from "node:path";

interface DSCodePiSettings {
  quietStartup?: boolean;
  [key: string]: unknown;
}

/** Keep Pi's resource inventory behind Ctrl+O so DSCode can own the startup surface. */
export async function ensureDSCodeUiDefaults(agentDirectory: string): Promise<void> {
  const settingsPath = path.join(agentDirectory, "settings.json");
  let settings: DSCodePiSettings = {};
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, "utf8")) as DSCodePiSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  if (settings.quietStartup !== undefined) return;
  settings.quietStartup = true;
  await fs.mkdir(agentDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, settingsPath);
}
