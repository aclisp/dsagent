import { chmod, copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(root, "dist/vision-cli.js");
const outputFile = path.join(root, "dist/vision-cli.bundle.js");
const sourceMap = `${entryPoint}.map`;

try {
  await build({
    entryPoints: [entryPoint],
    outfile: outputFile,
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    target: "node22",
    minify: true,
    sourcemap: false,
    legalComments: "eof",
  });

  const bundled = await readFile(outputFile, "utf8");
  if (bundled.includes("../packages/core/")) {
    throw new Error("Vision CLI bundle still references DSCode workspace modules");
  }

  await copyFile(outputFile, entryPoint);
  await chmod(entryPoint, 0o755);
} finally {
  await rm(outputFile, { force: true });
  await rm(sourceMap, { force: true });
}
