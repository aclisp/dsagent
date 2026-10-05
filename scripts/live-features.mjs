import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (!process.env.DEEPSEEK_API_KEY?.trim()) {
  process.stderr.write("DEEPSEEK_API_KEY is required for the live feature tests.\n");
  process.exit(2);
}

const projectRoot = process.cwd();
const cli = path.resolve(projectRoot, "dist/bundle/cli.js");
const mcpFixture = path.resolve(projectRoot, "test/fixtures/mcp-server.mjs");
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "dscode-live-features-"));
const sessionDir = path.join(fixture, "sessions");
let passed = false;

try {
  await prepareFixture();
  await verifySessionResume();
  await verifyMcpToolUse();
  await verifyInvestigation();
  passed = true;
  process.stdout.write("Live feature acceptance passed.\n");
} finally {
  if (process.env.DSCODE_KEEP_SMOKE === "1" || !passed) {
    process.stdout.write(`Feature fixture retained for inspection: ${fixture}\n`);
  } else {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

async function prepareFixture() {
  await fs.mkdir(path.join(fixture, ".dscode"));
  await fs.mkdir(sessionDir);
  await fs.writeFile(
    path.join(fixture, "package.json"),
    `${JSON.stringify({ name: "dscode-live-features", private: true, type: "module" }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(fixture, "README.md"),
    "# Live feature fixture\n\nThis repository exists only for DSCode acceptance tests.\n",
  );
  await fs.writeFile(
    path.join(fixture, ".dscode", "mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [mcpFixture],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await assertCommand("git", ["init", "--quiet"], fixture);
  await assertCommand("git", ["add", "--", "."], fixture);
  await assertCommand(
    "git",
    [
      "-c",
      "user.name=DSCode Acceptance",
      "-c",
      "user.email=dscode-acceptance@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "acceptance fixture",
    ],
    fixture,
  );
  process.stdout.write("✓ isolated Git/MCP fixture ready\n");
}

async function verifySessionResume() {
  const first = await runCli([
    "-C",
    fixture,
    "--session-dir",
    sessionDir,
    "--name",
    "live-feature-session",
    "--effort",
    "low",
    "--permission",
    "auto",
    "--sandbox",
    "read-only",
    "-p",
    "请记住暗号 ORANGE-417，只回复“已记住”。",
  ]);
  assertCliOk(first, "initial persisted session");

  const resumed = await runCli([
    "-C",
    fixture,
    "--session-dir",
    sessionDir,
    "--continue",
    "--effort",
    "low",
    "--permission",
    "auto",
    "--sandbox",
    "read-only",
    "-p",
    "上一轮让我记住的暗号是什么？只回复暗号。",
  ]);
  assertCliOk(resumed, "continued session");
  assert.match(resumed.stdout, /ORANGE-417/, "continued session did not recall prior context");

  const sessionFiles = (await fs.readdir(sessionDir)).filter((file) => file.endsWith(".jsonl"));
  assert.equal(sessionFiles.length, 1, "--continue should reuse the original JSONL session");
  const transcript = await fs.readFile(path.join(sessionDir, sessionFiles[0]), "utf8");
  assert.match(transcript, /live-feature-session/);
  assert.match(transcript, /ORANGE-417/);
  process.stdout.write("✓ persisted session name and --continue context\n");
}

async function verifyMcpToolUse() {
  const execution = await runCli([
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
    "read-only",
    "--effort",
    "low",
    "Call mcp__fixture__echo exactly once with text mcp-live-731. You must use the tool, then report its result.",
  ]);
  assertCliOk(execution, "MCP model turn");
  const events = jsonEvents(execution.stdout);
  assert.ok(
    events.some((event) => event.type === "tool_execution_start" && event.toolName === "mcp__fixture__echo"),
    "model did not invoke mcp__fixture__echo",
  );
  const result = events.find(
    (event) => event.type === "tool_execution_end" && event.toolName === "mcp__fixture__echo",
  );
  assert.ok(result, "MCP tool did not complete");
  assert.match(JSON.stringify(result.result), /mcp-live-731\|key=unset/);
  process.stdout.write("✓ live model → MCP call; model API key stripped from stdio\n");
}

async function verifyInvestigation() {
  const execution = await runCli([
    "-C", fixture, "--mode", "json", "--print", "--no-session", "--approve",
    "--permission", "full", "--no-mcp", "--tools", "read,exec_command,write_stdin", "--effort", "low",
    "Launch dscode --no-session --no-mcp --tools read --effort low -p 'Read package.json and report its package name with file evidence' through exec_command with yield_time_ms 0 and timeout_ms 0. Immediately send EOF through write_stdin with yield_time_ms 0. Collect the child result through write_stdin before summarizing it.",
  ]);
  assertCliOk(execution, "managed CLI child");
  const events = jsonEvents(execution.stdout);
  assert.ok(events.some(event => event.type === "tool_execution_start" && event.toolName === "exec_command"));
  assert.ok(events.some(event => event.type === "tool_execution_end" && event.toolName === "write_stdin"));
  assert.match(execution.stdout, /dscode-live-features/);
  process.stdout.write("✓ live managed CLI child returned file evidence\n");
}

async function runCli(args) {
  return run(process.execPath, [cli, ...args], projectRoot, {
    ...process.env,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  });
}

async function assertCommand(command, args, cwd) {
  const execution = await run(command, args, cwd, process.env);
  assert.equal(
    execution.exitCode,
    0,
    `${command} ${args.join(" ")} failed:\n${tail(execution.stderr || execution.stdout)}`,
  );
}

function assertCliOk(execution, label) {
  assert.equal(
    execution.exitCode,
    0,
    `${label} failed:\n${tail(`${execution.stderr}\n${execution.stdout}`)}`,
  );
}

function jsonEvents(stdout) {
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-4_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-500_000);
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function tail(value, length = 8_000) {
  return value.slice(-length);
}
