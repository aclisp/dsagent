import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/cli-bundle-smoke.mjs", import.meta.url)), "--manifest", process.argv[2]], { stdio: "inherit" });
