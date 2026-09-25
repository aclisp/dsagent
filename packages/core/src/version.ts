import fs from "node:fs";
import { embeddedVersion } from "./distribution.js";

interface PackageMetadata {
  version?: unknown;
}

const metadata = embeddedVersion ? { version: embeddedVersion } : JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

if (typeof metadata.version !== "string" || metadata.version.length === 0) {
  throw new Error("DSCode package version is missing");
}

export const DSCODE_VERSION = metadata.version;
