export const targets = {
  "darwin-arm64": "bun-darwin-arm64",
  "linux-x64": "bun-linux-x64-baseline",
  "windows-x64": "bun-windows-x64-baseline",
};

export function hostPlatform() {
  return `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
}

export function binaryName(name, platform = process.platform) {
  return platform === "win32" || platform.startsWith("windows-") ? `${name}.exe` : name;
}
