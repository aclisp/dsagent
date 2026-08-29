import { execFileSync } from "node:child_process";
import process from "node:process";

const images = process.argv.slice(2);
if (images.length === 0) {
  throw new Error("Usage: node scripts/docker-smoke.mjs <image> [...<image>]");
}

const executableFiles = [
  "/usr/local/bin/dscode-entrypoint.sh",
  "/usr/local/bin/dscode-vision",
  "/app/dist/vision-cli.js",
];
const requiredFiles = [
  "/app/node_modules",
  "/app/packages/web-ui/package.json",
  "/app/packages/web-ui/dist/server.js",
  "/app/packages/web-ui/static/chat.html",
  "/app/packages/web-ui/static/index.html",
  "/app/packages/web-ui/static/chat.js",
  "/app/packages/web-ui/static/style.css",
];

for (const [index, image] of images.entries()) {
  const container = `dscode-image-smoke-${process.pid}-${index}`;
  try {
    const entrypoint = JSON.parse(
      run("docker", ["inspect", "--format", "{{json .Config.Entrypoint}}", image]).trim(),
    );
    if (!Array.isArray(entrypoint) || entrypoint[0] !== "/usr/local/bin/dscode-entrypoint.sh") {
      throw new Error(`Unexpected entrypoint for ${image}: ${JSON.stringify(entrypoint)}`);
    }

    const checks = [
      ...executableFiles.map((file) => `test -x ${shellQuote(file)}`),
      ...requiredFiles.map((file) => `test -e ${shellQuote(file)}`),
    ].join(" && ");
    run("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      checks,
    ]);

    run("docker", [
      "run",
      "-d",
      "--name",
      container,
      "-p",
      "127.0.0.1::8899",
      "-e",
      "WORKSPACES=smoke-workspace-1=/tmp/workspace",
      "-e",
      "TZ=UTC",
      "-e",
      "DSCODE_HOME=/tmp/dscode-home",
      image,
    ]);

    const portOutput = run("docker", ["port", container, "8899/tcp"]).trim();
    const portMatch = portOutput.match(/:(\d+)\s*$/);
    if (!portMatch) throw new Error(`Could not determine published port for ${image}: ${portOutput}`);
    const port = portMatch[1];
    await waitForHealth(`http://127.0.0.1:${port}/health`);
    process.stdout.write(`Docker smoke passed: ${image}\n`);
  } finally {
    try {
      run("docker", ["rm", "--force", container]);
    } catch {
      // The container may have exited before cleanup.
    }
  }
}

async function waitForHealth(url) {
  const deadline = Date.now() + 30_000;
  let lastError = "unknown error";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok && JSON.parse(body)?.status === "ok") return;
      lastError = `${response.status}: ${body}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Health check failed for ${url}: ${lastError}`);
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
