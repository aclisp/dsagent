import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parsePatch } from "./patch.ts";
import { PatchBudget, readPatchFile } from "./patch-limits.ts";
import { Workspace } from "./workspace.ts";

export interface FileSnapshot {
  path: string;
  content: string | null;
  mode?: number;
  hash: string;
}

export interface PatchCheckpoint {
  id: string;
  createdAt: string;
  patch: string;
  before: FileSnapshot[];
  after: FileSnapshot[];
}

export async function capturePatchCheckpoint(
  workspace: Workspace,
  patchInput: string,
  apply: (budget: PatchBudget) => Promise<void>,
  signal?: AbortSignal,
): Promise<PatchCheckpoint> {
  signal?.throwIfAborted();
  const touched = extractTouchedPaths(patchInput);
  const budget = new PatchBudget();
  const before = await snapshotPaths(workspace, touched, budget, signal);
  signal?.throwIfAborted();
  await apply(budget);
  // A successful apply has crossed the mutation boundary; finish its checkpoint.
  const after = await snapshotPaths(workspace, touched, new PatchBudget(budget.originalBytes));
  return {
    id: crypto.randomUUID().slice(0, 12),
    createdAt: new Date().toISOString(),
    patch: patchInput,
    before,
    after,
  };
}

export async function restoreCheckpoint(
  workspace: Workspace,
  checkpoint: PatchCheckpoint,
  force = false,
): Promise<string[]> {
  const budget = new PatchBudget();
  const current = await snapshotPaths(
    workspace,
    checkpoint.after.map((snapshot) => snapshot.path),
    budget,
  );
  const conflicts = current
    .filter((snapshot, index) => snapshot.hash !== checkpoint.after[index]?.hash)
    .map((snapshot) => snapshot.path);
  if (conflicts.length > 0 && !force) {
    throw new Error(
      `Cannot undo because these files changed after the checkpoint: ${conflicts.join(", ")}`,
    );
  }

  for (const snapshot of checkpoint.before) {
    budget.stageWrite(snapshot.path, snapshot.content);
  }

  for (const snapshot of checkpoint.before) {
    const absolute = await workspace.resolvePatchPath(snapshot.path, true);
    if (snapshot.content === null) {
      await fs.rm(absolute, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const temporary = path.join(
      path.dirname(absolute),
      `.${path.basename(absolute)}.dscode-undo-${process.pid}-${Date.now()}.tmp`,
    );
    try {
      await fs.writeFile(temporary, snapshot.content, {
        encoding: "utf8",
        ...(snapshot.mode === undefined ? {} : { mode: snapshot.mode }),
      });
      await fs.rename(temporary, absolute);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }
  return checkpoint.before.map((snapshot) => snapshot.path);
}

export function extractTouchedPaths(input: string): string[] {
  const paths = new Set<string>();
  for (const action of parsePatch(input)) {
    paths.add(action.path);
    if (action.type === "update" && action.moveTo) paths.add(action.moveTo);
  }
  return [...paths];
}

async function snapshotPaths(workspace: Workspace, files: string[], budget: PatchBudget, signal?: AbortSignal): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    const absolute = await workspace.resolvePatchPath(file, true);
    signal?.throwIfAborted();
    try {
      const stat = await fs.stat(absolute);
      signal?.throwIfAborted();
      if (!stat.isFile()) throw new Error(`Checkpoint path is not a regular file: ${file}`);
      const bytes = await readPatchFile(absolute, file, budget, signal);
      signal?.throwIfAborted();
      const content = bytes.toString("utf8");
      snapshots.push({
        path: file,
        content,
        mode: stat.mode,
        hash: hash(content),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      snapshots.push({ path: file, content: null, hash: hash(null) });
    }
  }
  return snapshots;
}

function hash(content: string | null): string {
  return crypto.createHash("sha256").update(content === null ? "\0missing" : content).digest("hex");
}
