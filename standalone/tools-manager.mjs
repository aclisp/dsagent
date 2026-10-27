import fs from "node:fs";
import path from "node:path";
import { assets } from "dscode:assets";
import { getDSCodeHome } from "../packages/core/dist/home.js";
import { createToolPreparer, updateTools } from "./tools-install.mjs";
import { versions } from "dscode:tool-versions";
import { binaryName } from "./platforms.mjs";

const prepareTools = createToolPreparer(assets, versions);

export function updateBundledTools() {
  return updateTools(getDSCodeHome(), assets, versions);
}

export function installBundledTools(home = getDSCodeHome()) {
  return prepareTools(home);
}

export function getToolPath(tool) {
  if (tool !== "fd" && tool !== "rg") return null;
  const target = path.join(getDSCodeHome(), "bin", binaryName(tool));
  return fs.existsSync(target) ? target : null;
}

export async function ensureTool(tool) {
  if (tool !== "fd" && tool !== "rg") return undefined;
  await installBundledTools();
  return getToolPath(tool) ?? undefined;
}
