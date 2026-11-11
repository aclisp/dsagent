import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { isStandalone } from "./distribution.ts";
import { getDSCodeHome } from "./home.ts";
import { scheduledTasksAssetPath } from "./skill-assets.ts";

/** Publish an immutable resource without overwriting an existing cache or user skill. */
export async function materializeBuiltinSkill(home: string, content: Buffer): Promise<string> {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 32);
  let directory = home;
  for (const part of ["builtin-skills", hash, "scheduled-tasks"]) {
    directory = path.join(directory, part);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Invalid built-in skill cache directory");
  }
  const target = path.join(directory, "SKILL.md");
  try { await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = path.join(directory, `.SKILL-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      try { await link(temporary, target); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure; }
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }
  const entry = await lstat(target);
  if (!entry.isFile() || entry.isSymbolicLink() || !(await readFile(target)).equals(content)) {
    throw new Error("Built-in skill cache does not match the packaged resource");
  }
  return target;
}

export async function getScheduledTasksSkillPath(): Promise<string> {
  const asset = scheduledTasksAssetPath();
  return isStandalone ? materializeBuiltinSkill(getDSCodeHome(), await readFile(asset)) : asset;
}
