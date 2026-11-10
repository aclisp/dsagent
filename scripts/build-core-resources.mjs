import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "packages/core/dist");
chmodSync(path.join(dist, "rpc-entry.js"), 0o755);
const target = path.join(dist, "builtin-skills/scheduled-tasks");
mkdirSync(target, { recursive: true });
copyFileSync(path.join(root, "deploy/default-skills/scheduled-tasks/SKILL.md"), path.join(target, "SKILL.md"));
