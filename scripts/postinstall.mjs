import fs from "node:fs";

const globalInstall = process.env.npm_config_global;
const { version } = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

if (globalInstall === "true" || globalInstall === "1") {
  writeToTerminal(`
DSCode v${version} installed successfully.

Get started:
  cd your-project
  dscode

The first launch will guide you through DeepSeek API setup.
Run dscode --help to see all commands.

`);
}

function writeToTerminal(message) {
  if (process.stdout.isTTY) {
    process.stdout.write(message);
    return;
  }

  const terminal = process.platform === "win32" ? "\\\\.\\CONOUT$" : "/dev/tty";
  try {
    const descriptor = fs.openSync(terminal, "w");
    try {
      fs.writeSync(descriptor, message);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    // npm suppresses lifecycle stdout by default, but retaining this fallback
    // keeps the script harmless in CI and non-interactive package managers.
    process.stdout.write(message);
  }
}
