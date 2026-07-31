import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  process.stderr.write("DEEPSEEK_API_KEY is required for the live smoke test.\n");
  process.exit(2);
}

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-live-smoke-"));
let passed = false;
try {
  await fs.mkdir(path.join(fixture, "test"));
  await fs.writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify(
      {
        name: "dscode-live-smoke",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ) + "\n",
  );
  await fs.writeFile(
    path.join(fixture, "test", "math.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add } from "../src/math.js";',
      "",
      'test("add", () => assert.equal(add(2, 3), 5));',
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(fixture, "AGENTS.md"),
    "# Smoke test rules\n\nUse ESM JavaScript. Run `npm test` before finishing.\n",
  );

  process.stdout.write(`Live fixture: ${fixture}\n`);
  const agent = await run(
    process.execPath,
    [
      path.resolve("dist/cli.js"),
      "-C",
      fixture,
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--approve",
      "--permission",
      "full",
      "--sandbox",
      "workspace-write",
      "Make the existing test pass. Follow AGENTS.md, make the smallest correct change, and run the test.",
    ],
    process.cwd(),
  );
  process.stdout.write(agent.stdout);
  process.stderr.write(agent.stderr);
  if (agent.exitCode !== 0) throw new Error(`DSCode exited with ${agent.exitCode}`);

  const verification = await run(process.execPath, ["--test"], fixture);
  process.stdout.write(verification.stdout);
  process.stderr.write(verification.stderr);
  if (verification.exitCode !== 0) {
    throw new Error(`Fixture verification exited with ${verification.exitCode}`);
  }
  const implementation = await fs.readFile(path.join(fixture, "src", "math.js"), "utf8");
  if (!implementation.includes("add")) throw new Error("Expected src/math.js was not created");
  passed = true;
  process.stdout.write("Live smoke test passed.\n");
} finally {
  if (process.env.DSCODE_KEEP_SMOKE === "1" || !passed) {
    process.stdout.write(`Fixture retained for inspection: ${fixture}\n`);
  } else {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
