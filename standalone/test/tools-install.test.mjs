import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installTools } from "../tools-install.mjs";

test("concurrent extraction publishes executable tools once and preserves user replacements", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-tool-test-"));
  try {
    const home = path.join(root, "custom home");
    const assets = {};
    for (const tool of ["fd", "rg"]) {
      for (const name of [tool, `${tool}-LICENSES.txt`]) {
        assets[`tools/${name}`] = path.join(root, name);
        await fs.writeFile(assets[`tools/${name}`], name);
      }
    }
    const versions = { fd: "1", rg: "2" };
    await Promise.all(Array.from({ length: 8 }, () => installTools(home, assets, versions)));
    const bin = path.join(home, "bin");
    for (const tool of ["fd", "rg"]) {
      assert.equal(await fs.readFile(path.join(bin, tool), "utf8"), tool);
      assert.ok((await fs.stat(path.join(bin, tool))).mode & 0o111);
      const receipt = (await fs.readdir(bin)).find(name => name.startsWith(`.${tool}-`));
      assert.equal(JSON.parse(await fs.readFile(path.join(bin, receipt), "utf8")).version, versions[tool]);
    }
    await fs.writeFile(path.join(bin, "rg"), "user rg");
    await fs.unlink(path.join(bin, "fd"));
    await fs.symlink("/nonexistent/user/fd", path.join(bin, "fd"));
    await installTools(home, assets, { fd: "3", rg: "3" });
    assert.equal(await fs.readFile(path.join(bin, "rg"), "utf8"), "user rg");
    assert.equal(await fs.readlink(path.join(bin, "fd")), "/nonexistent/user/fd");
    assert.ok(!(await fs.readdir(bin)).some(name => name.startsWith(".extract-")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-tool-upgrade-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(home, "bin");
  async function bundle(version) {
    const assets = {};
    await fs.mkdir(path.join(root, version), { recursive: true });
    for (const tool of ["fd", "rg"]) {
      for (const name of [tool, `${tool}-LICENSES.txt`]) {
        assets[`tools/${name}`] = path.join(root, version, name);
        await fs.writeFile(assets[`tools/${name}`], `${name}-${version}`);
      }
    }
    return { assets, versions: { fd: version, rg: version } };
  }
  const old = await bundle("1.9.0");
  const newer = await bundle("1.10.0");
  await installTools(home, old.assets, old.versions);
  return { root, home, bin, old, newer, bundle };
}

test("upgrades receipt-owned tools atomically and never downgrades or rewrites the same version", async t => {
  const { home, bin, old, newer } = await fixture(t);
  const target = path.join(bin, "fd");
  const oldHandle = await fs.open(target, "r");
  try {
    await installTools(home, newer.assets, newer.versions);
    assert.equal(await oldHandle.readFile("utf8"), "fd-1.9.0");
  } finally { await oldHandle.close(); }
  for (const tool of ["fd", "rg"]) {
    assert.equal(await fs.readFile(path.join(bin, tool), "utf8"), `${tool}-1.10.0`);
    assert.ok((await fs.stat(path.join(bin, tool))).mode & 0o111);
  }
  const before = await fs.stat(target);
  await installTools(home, old.assets, old.versions);
  await installTools(home, newer.assets, newer.versions);
  assert.equal((await fs.stat(target)).ino, before.ino);
});

test("independent processes converge on the newest tool version", async t => {
  const { home, bin, old, newer, bundle } = await fixture(t);
  const newest = await bundle("2.0.0");
  const moduleUrl = new URL("../tools-install.mjs", import.meta.url).href;
  const source = `import { installTools } from ${JSON.stringify(moduleUrl)};
    const [home, bundle] = JSON.parse(process.argv[1]);
    await installTools(home, bundle.assets, bundle.versions);`;
  const results = await Promise.allSettled([newer, newest, old, newer, newest, old].map(bundle =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, JSON.stringify([home, bundle])])));
  for (const result of results) assert.equal(result.status, "fulfilled", result.reason?.message);
  for (const tool of ["fd", "rg"]) assert.equal(await fs.readFile(path.join(bin, tool), "utf8"), `${tool}-2.0.0`);
  assert.ok(!(await fs.readdir(bin)).includes(".dscode-tools.lock"));
});

test("missing, malformed, or mismatched receipts never authorize replacement", async t => {
  for (const receipt of [undefined, "{broken", JSON.stringify({ tool: "fd", version: "1.9.0", sha256: "wrong" })]) {
    await t.test(String(receipt), async t => {
      const { home, bin, newer } = await fixture(t);
      for (const file of await fs.readdir(bin)) {
        if (!file.endsWith(".json")) continue;
        if (receipt === undefined) await fs.unlink(path.join(bin, file));
        else await fs.writeFile(path.join(bin, file), receipt);
      }
      await installTools(home, newer.assets, newer.versions);
      for (const tool of ["fd", "rg"]) assert.equal(await fs.readFile(path.join(bin, tool), "utf8"), `${tool}-1.9.0`);
    });
  }
});

test("recovers an abandoned lock and an interrupted publication with a prewritten receipt", async t => {
  const { home, bin, newer } = await fixture(t);
  const otherHome = `${home}-new`;
  await installTools(otherHome, newer.assets, newer.versions);
  for (const file of await fs.readdir(path.join(otherHome, "bin"))) {
    if (file.endsWith(".json")) await fs.copyFile(path.join(otherHome, "bin", file), path.join(bin, file));
  }
  const lock = path.join(bin, ".dscode-tools.lock");
  await fs.mkdir(lock);
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(lock, past, past);
  await installTools(home, newer.assets, newer.versions);
  for (const tool of ["fd", "rg"]) assert.equal(await fs.readFile(path.join(bin, tool), "utf8"), `${tool}-1.10.0`);
});

test("preparation failure preserves the old binary and releases the lock for a retry", async t => {
  const { home, bin, newer } = await fixture(t);
  const broken = { ...newer.assets, "tools/fd-LICENSES.txt": "/nonexistent/fixture-license" };
  await assert.rejects(installTools(home, broken, newer.versions), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(bin, "fd"), "utf8"), "fd-1.9.0");
  await installTools(home, newer.assets, newer.versions);
  assert.equal(await fs.readFile(path.join(bin, "fd"), "utf8"), "fd-1.10.0");
});
