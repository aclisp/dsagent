import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSnapshotStore } from "../packages/core/src/web-snapshots.ts";

const roots: string[] = [];
const day = 24 * 60 * 60 * 1000;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-snapshot-cleanup-"));
  roots.push(root);
  const now = Date.UTC(2026, 9, 23);
  vi.spyOn(Date, "now").mockReturnValue(now);
  return {
    root,
    store: new WebSnapshotStore(root),
    async file(age: number, name = `${randomUUID()}.json`) {
      const file = path.join(root, name);
      await fs.writeFile(file, "{}");
      const modified = new Date(now - age * day);
      await fs.utimes(file, modified, modified);
      return name;
    },
  };
}

describe("web snapshot cleanup", () => {
  it("uses modification time and deletes only snapshot files older than the cutoff", async () => {
    const h = await setup();
    const expired = await h.file(31);
    const boundary = await h.file(30);
    const recent = await h.file(1);
    const unrelated = await h.file(60, "notes.json");
    const otherExtension = await h.file(60, `${randomUUID()}.txt`);
    const directory = `${randomUUID()}.json`;
    await fs.mkdir(path.join(h.root, directory));
    await h.store.cleanup(30);
    const remaining = await fs.readdir(h.root);
    expect(remaining).not.toContain(expired);
    expect(remaining.sort()).toEqual([boundary, recent, unrelated, otherExtension, directory].sort());
  });

  it("keeps all snapshots when retention is disabled", async () => {
    const h = await setup();
    const expired = await h.file(365);
    await h.store.cleanup(0);
    expect(await fs.readdir(h.root)).toEqual([expired]);
  });

  it("continues cleanup after a file cannot be deleted", async () => {
    const h = await setup();
    const inaccessible = await h.file(60);
    const expired = await h.file(60);
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (file === path.join(h.root, inaccessible)) throw new Error("Access denied");
      await unlink(file);
    });
    await expect(h.store.cleanup(30)).resolves.toBeUndefined();
    expect(await fs.readdir(h.root)).toEqual([inaccessible]);
    expect(await fs.readdir(h.root)).not.toContain(expired);
  });

  it("does not create a missing snapshot directory", async () => {
    const h = await setup();
    const missing = path.join(h.root, "missing");
    await expect(new WebSnapshotStore(missing).cleanup(30)).resolves.toBeUndefined();
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("leaves symlinks and their targets untouched", async () => {
    const h = await setup();
    const target = await h.file(60, "target.txt");
    const link = `${randomUUID()}.json`;
    await fs.symlink(path.join(h.root, target), path.join(h.root, link));
    await h.store.cleanup(30);
    expect((await fs.readdir(h.root)).sort()).toEqual([target, link].sort());
  });
});
