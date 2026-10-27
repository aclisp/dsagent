import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedProcessRegistry } from "../packages/core/src/managed-process.ts";
import { commandNeedsNetwork, detectSandboxBoundary } from "../packages/core/src/access.ts";

describe.runIf(process.platform === "win32")("managed Windows CLI children", () => {
  let root: string;
  let registry: ManagedProcessRegistry;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "dscode 子进程 O'Brien [1] "));
    const fixed = path.join(root, "安装目录", "cli fixture.mjs");
    await fs.mkdir(path.dirname(fixed));
    await fs.writeFile(fixed, `console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),key:process.env.DEEPSEEK_API_KEY,depth:process.env.DSCODE_SUBAGENT_DEPTH,custom:process.env.CUSTOM_SECRET??null}));`);
    await fs.writeFile(path.join(root, "dscode.exe"), "PATH_SHADOW_MUST_NOT_RUN");
    vi.stubEnv("PATH", root);
    vi.stubEnv("DSCODE_HOME", root);
    vi.stubEnv("DEEPSEEK_API_KEY", "windows-child-fixture-key");
    vi.stubEnv("DSCODE_SUBAGENT_DEPTH", "0");
    vi.stubEnv("CUSTOM_SECRET", "not-forwarded");
    registry = new ManagedProcessRegistry({ dscodeExecutable: fixed });
  });

  afterEach(async () => {
    await registry.dispose();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  const options = () => ({
    cwd: root, sandbox: { mode: "read-only" as const, network: false },
    yieldTimeMs: 5_000, timeoutMs: 0, thinkingLevel: "low" as const,
  });

  it.each(["dscode", "DSCode.EXE"])("launches the fixed executable for %s with exact path arguments", async executable => {
    const cwdArgument = `${root}\\`;
    const session = "\\\\server\\共享 files\\session.jsonl";
    const quoted = root.replaceAll("'", "''");
    const command = `${executable} -C "${cwdArgument}" --session "${session}" -p 'Read ${quoted}'`;
    const result = await registry.start(command, options());
    expect(result).toMatchObject({ running: false, exitCode: 0, sandbox: "trusted dscode" });
    expect(JSON.parse(result.output)).toEqual({
      args: ["-C", cwdArgument, "--session", session, "-p", `Read ${root}`],
      cwd: root, key: "windows-child-fixture-key", depth: "1", custom: null,
    });
    expect(commandNeedsNetwork(command)).toBe(false);
    expect(detectSandboxBoundary(command, { ...result, exitCode: 1, output: "permission denied; network is unreachable" },
      { sandbox: "read-only", network: false })).toBeUndefined();
  });

  it("applies the child-depth limit to the executable alias", async () => {
    vi.stubEnv("DSCODE_SUBAGENT_DEPTH", "1");
    await expect(registry.start("DSCode.EXE --permission full -p 'grandchild'", options()))
      .rejects.toThrow("DSCode child depth limit reached (maximum depth: 1)");
    expect(registry.list()).toEqual([]);
  });

  it.each(["DSCode.EXE -p task | whoami", "Set-Location C:\\repo; dscode.exe -p task"])(
    "rejects invalid child syntax without spawning a shell: %s", async command => {
      await expect(registry.start(command, options())).rejects.toThrow("Invalid dscode command:");
      expect(registry.list()).toEqual([]);
    },
  );
});
