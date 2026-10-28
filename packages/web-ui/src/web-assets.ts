import { readFile } from "node:fs/promises";

/** Replaced by the distribution builders with packaged/embedded assets. */
export function readWebAsset(name: string): Promise<Buffer> {
  return name === "marked.esm.js"
    ? readFile(new URL(import.meta.resolve("marked")))
    : readFile(new URL(`../static/${name}`, import.meta.url));
}
