/// <reference path="./proper-lockfile.d.ts" />
import { createHash } from "node:crypto";
import { mkdir, lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Independent of DSCODE_HOME so two local homes cannot consume the same bot.
 * Containers/hosts with separate coordination directories are separate deployments. */
export function backgroundCoordinationDirectory(): string {
  return path.join(os.tmpdir(), `dscode-services-${digest(`${os.userInfo().uid}:${os.homedir()}`).slice(0, 16)}`);
}

export async function acquireBackgroundResources(options: {
  workspace: string;
  accounts: readonly { key: string; label: string }[];
  directory?: string;
  onCompromised(error: Error): void;
}): Promise<() => Promise<void>> {
  const directory = options.directory ?? backgroundCoordinationDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid service coordination directory");
  await mkdir(options.workspace, { recursive: true });
  let workspace = await realpath(options.workspace);
  if (process.platform === "win32") workspace = workspace.toLowerCase();
  const resources = new Map<string, string>([
    [`scheduler:${workspace}`, `scheduler for ${options.workspace}`],
    ...options.accounts.map(({ key, label }) => [`account:${key}`, label] as const),
  ]);
  const releases: Array<() => Promise<void>> = [];
  const release = async () => {
    const results = await Promise.allSettled(releases.splice(0).reverse().map(unlock => unlock()));
    if (results.some(result => result.status === "rejected")) throw new Error("Could not release a service resource lock");
  };
  try {
    for (const [key, label] of [...resources].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        releases.push(await lockfile.lock(path.join(directory, digest(key)), {
          realpath: false, stale: 30_000, update: 10_000, retries: 0,
          onCompromised: () => options.onCompromised(new Error(`Service ownership lost: ${label}`)),
        }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
          throw new Error(`Service resource is already in use: ${label}. Stop the owning /web or Server first.`);
        }
        throw new Error(`Cannot acquire service resource: ${label}`, { cause: error });
      }
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
