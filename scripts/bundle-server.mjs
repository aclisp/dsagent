import { copyFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(root, "packages/web-ui/dist/server.js");
const outputFile = path.join(root, "packages/web-ui/dist/server.bundle.js");
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);

const versionModule = "dscode-bundle-version";

await build({
  entryPoints: [entryPoint],
  outfile: outputFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  plugins: [
    {
      name: "dscode-runtime-dependencies",
      setup(buildContext) {
        buildContext.onResolve({ filter: /\/version\.js$/ }, (args) => {
          if (args.importer.includes(`${path.sep}packages${path.sep}core${path.sep}dist`)) {
            return { path: versionModule, namespace: "dscode" };
          }
          return undefined;
        });

        // Keep third-party and native packages as runtime dependencies. Only
        // DSCode's workspace packages are folded into the server bundle.
        buildContext.onResolve({ filter: /^[^./][^:]*$/ }, (args) => {
          if (args.path.startsWith("@thinkany/dscode-")) return undefined;
          return { path: args.path, external: true };
        });

        buildContext.onLoad(
          { filter: /^dscode-bundle-version$/, namespace: "dscode" },
          () => ({
            contents: `export const DSCODE_VERSION = ${JSON.stringify(packageJson.version)};`,
            loader: "js",
          }),
        );
      },
    },
  ],
});

await copyFile(outputFile, entryPoint);
await unlink(outputFile);
