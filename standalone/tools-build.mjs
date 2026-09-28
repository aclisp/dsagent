// Release downloads happen only on the build host. Never resolve "latest".
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const toolVersions = { fd: "10.3.0", rg: "14.1.1" };
const checksums = {
  "darwin-arm64": {
    fd: "0570263812089120bc2a5d84f9e65cd0c25e4a4d724c80075c357239c74ae904",
    rg: "24ad76777745fbff131c8fbc466742b011f925bfa4fffa2ded6def23b5b937be",
  },
  "linux-x64": {
    fd: "2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14",
    rg: "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e",
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
