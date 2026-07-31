import fs from "node:fs/promises";
import path from "node:path";

const usefulScripts = [
  "test",
  "test:unit",
  "test:integration",
  "typecheck",
  "check",
  "lint",
  "build",
];

export async function discoverProjectCommands(cwd: string): Promise<string[]> {
  const commands: string[] = [];
  const packageJson = await readJson(path.join(cwd, "package.json"));
  if (isRecord(packageJson) && isRecord(packageJson.scripts)) {
    const runner = await packageRunner(cwd);
    for (const name of usefulScripts) {
      if (typeof packageJson.scripts[name] === "string") {
        commands.push(`${runner} ${name}`);
      }
    }
  }
  if (await exists(path.join(cwd, "Cargo.toml"))) {
    commands.push("cargo test", "cargo check");
  }
  if (await exists(path.join(cwd, "go.mod"))) {
    commands.push("go test ./...", "go vet ./...");
  }
  if (await exists(path.join(cwd, "pyproject.toml"))) {
    const prefix = (await exists(path.join(cwd, "uv.lock"))) ? "uv run " : "";
    commands.push(`${prefix}pytest`, `${prefix}ruff check .`);
  }
  if (await exists(path.join(cwd, "Package.swift"))) {
    commands.push("swift test", "swift build");
  }
  const makefile = await readText(path.join(cwd, "Makefile"));
  if (makefile) {
    for (const target of ["test", "check", "lint", "build"]) {
      if (new RegExp(`^${target}:`, "m").test(makefile)) commands.push(`make ${target}`);
    }
  }
  return [...new Set(commands)];
}

async function packageRunner(cwd: string): Promise<string> {
  if (await exists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (await exists(path.join(cwd, "bun.lock")) || await exists(path.join(cwd, "bun.lockb"))) {
    return "bun run";
  }
  return "npm run";
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJson(file: string): Promise<unknown> {
  const content = await readText(file);
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
