import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { materializeBuiltinSkill } from "../packages/core/src/builtin-skills.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function home() { const root = await mkdtemp(path.join(os.tmpdir(), "dscode-skill-cache-")); roots.push(root); return root; }

it("publishes one complete readable resource under concurrent initialization", async () => {
  const root = await home(); const content = Buffer.from("---\nname: scheduled-tasks\ndescription: fixture\n---\nContent\n");
  const paths = await Promise.all(Array.from({ length: 12 }, () => materializeBuiltinSkill(root, content)));
  expect(new Set(paths).size).toBe(1);
  expect(await readFile(paths[0]!)).toEqual(content);
  expect(await readdir(path.dirname(paths[0]!))).toEqual(["SKILL.md"]);
});

it("creates a separate version without modifying a previous resource", async () => {
  const root = await home(); const first = await materializeBuiltinSkill(root, Buffer.from("first"));
  const second = await materializeBuiltinSkill(root, Buffer.from("second"));
  expect(first).not.toBe(second); expect(await readFile(first, "utf8")).toBe("first");
});

it("refuses to overwrite a changed existing cache file", async () => {
  const root = await home(); const content = Buffer.from("packaged"); const file = await materializeBuiltinSkill(root, content);
  await writeFile(file, "user replacement");
  await expect(materializeBuiltinSkill(root, content)).rejects.toThrow("does not match");
  expect(await readFile(file, "utf8")).toBe("user replacement");
});
