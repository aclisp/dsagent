import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export function webAssetPaths(root) {
  const directory = path.join(root, "packages/web-ui/static");
  const assets = Object.fromEntries(readdirSync(directory).map(name => [name, path.join(directory, name)]));
  assets["marked.esm.js"] = createRequire(path.join(root, "packages/web-ui/package.json")).resolve("marked");
  return assets;
}
