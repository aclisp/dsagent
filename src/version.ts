import fs from "node:fs";

interface PackageMetadata {
  version?: unknown;
}

const metadata = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

if (typeof metadata.version !== "string" || metadata.version.length === 0) {
  throw new Error("DSCode package version is missing");
}

export const DSCODE_VERSION = metadata.version;
