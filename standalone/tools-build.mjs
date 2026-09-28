// Release downloads happen only on the build host. Never resolve "latest".
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const toolVersions = { fd: "10.5.0", rg: "15.2.0" };
const checksums = {
  "darwin-arm64": {
    fd: "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12",
    rg: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
  },
  "linux-x64": {
    fd: "761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7",
    rg: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
  },
};

export async function prepareTools(platform, work) {
  const triple = platform === "darwin-arm64" ? "aarch64-apple-darwin" : "x86_64-unknown-linux-musl";
  if (!checksums[platform]) throw new Error(`Unsupported tool platform: ${platform}`);
  const assets = {};
  for (const tool of ["fd", "rg"]) {
    const version = toolVersions[tool];
    const name = tool === "fd" ? `fd-v${version}-${triple}` : `ripgrep-${version}-${triple}`;
    const repo = tool === "fd" ? "sharkdp/fd" : "BurntSushi/ripgrep";
    const tag = tool === "fd" ? `v${version}` : version;
    const url = `https://github.com/${repo}/releases/download/${tag}/${name}.tar.gz`;
    // A pre-populated directory supports fully offline builds and private mirrors.
    const bytes = process.env.DSCODE_TOOL_ARCHIVES
      ? await fs.readFile(path.join(process.env.DSCODE_TOOL_ARCHIVES, `${name}.tar.gz`))
      : await download(url);
    if (createHash("sha256").update(bytes).digest("hex") !== checksums[platform][tool]) {
      throw new Error(`Checksum mismatch: ${name}.tar.gz`);
    }
    const archive = path.join(work, `${name}.tar.gz`);
    await fs.writeFile(archive, bytes);
    const licenses = tool === "fd" ? ["LICENSE-APACHE", "LICENSE-MIT"] : ["COPYING", "LICENSE-MIT", "UNLICENSE"];
    execFileSync("tar", ["-xzf", archive, "-C", work, ...[tool, ...licenses].map(file => `${name}/${file}`)]);
    assets[`tools/${tool}`] = path.join(work, name, tool);
    const notices = await Promise.all(licenses.map(async file => `${file}\n\n${await fs.readFile(path.join(work, name, file), "utf8")}`));
    const notice = path.join(work, `${tool}-LICENSES.txt`);
    await fs.writeFile(notice, `${repo} ${version}\n${url}\n\n${notices.join("\n\n")}`);
    assets[`tools/${tool}-LICENSES.txt`] = notice;
  }
  return assets;
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Tool download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
