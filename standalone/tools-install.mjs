import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";

/** Publish complete files; replacement is reserved for verified managed copies. */
async function publish(source, target, mode, replace = false) {
  const temporary = await fs.mkdtemp(path.join(path.dirname(target), ".extract-"));
  try {
    const staged = path.join(temporary, "file");
    await fs.writeFile(staged, source, { mode });
    await fs.chmod(staged, mode);
    if (replace) {
      await fs.rename(staged, target);
      return true;
    }
    try {
      await fs.link(staged, target);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function installTools(home, assets, versions) {
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true, mode: 0o700 });
  // Serialize ownership checks and publication across processes, including old
  // and new releases. Heartbeats allow recovery after an interrupted process.
  const release = await lockfile.lock(bin, {
    lockfilePath: path.join(bin, ".dscode-tools.lock"),
    stale: 10_000,
    retries: { retries: 100, factor: 1, minTimeout: 150, maxTimeout: 150 },
  });
  try {
    for (const tool of ["fd", "rg"]) await installTool(bin, tool, assets, versions);
  } finally {
    await release();
  }
}

async function installTool(bin, tool, assets, versions) {
  const target = path.join(bin, tool);
  const current = await installedFile(target);
  if (current) {
    // Never adopt symlinks, unknown files, or locally modified bundled tools.
    if (!current.sha256) return;
    const receipt = await readReceipt(bin, tool, current.sha256);
    if (!receipt || !isNewer(versions[tool], receipt.version)) return;
  }
  const bytes = await fs.readFile(assets[`tools/${tool}`]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const notice = await fs.readFile(assets[`tools/${tool}-LICENSES.txt`]);
  await publish(notice, path.join(bin, `${tool}-${versions[tool]}-LICENSES.txt`), 0o644);
  // Write the receipt first: interruption before/after binary publication
  // always leaves a recognizable old or new binary for the next startup.
  await publish(JSON.stringify({ tool, version: versions[tool], sha256 }) + "\n",
    path.join(bin, `.${tool}-${sha256}.json`), 0o600);
  if (current) {
    // Also notice non-cooperating user edits made while preparing the upgrade.
    const latest = await installedFile(target);
    if (!latest || latest.sha256 !== current.sha256 || latest.ino !== current.ino || latest.dev !== current.dev) return;
  }
  await publish(bytes, target, 0o755, Boolean(current));
}

async function installedFile(target) {
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile()) return {};
    return { ino: stat.ino, dev: stat.dev, sha256: createHash("sha256").update(await fs.readFile(target)).digest("hex") };
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readReceipt(bin, tool, sha256) {
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(bin, `.${tool}-${sha256}.json`), "utf8"));
    return receipt?.tool === tool && receipt.sha256 === sha256 ? receipt : undefined;
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isNewer(candidate, installed) {
  // Bundled upstream versions are numeric releases. Unknown receipt versions
  // are preserved; running an older DSCode executable never downgrades tools.
  const valid = value => typeof value === "string" && /^\d+(?:\.\d+){0,2}$/.test(value);
  if (!valid(candidate) || !valid(installed)) return false;
  const left = candidate.split(".").map(Number);
  const right = installed.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) > (right[i] ?? 0);
  }
  return false;
}
