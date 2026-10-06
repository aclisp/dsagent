import { describe, expect, it } from "vitest";
import { classifyDSCodeCommand, createDSCodeProcessEnvironment, isDSCodeChild, resolveDSCodeExecutable } from "../packages/core/src/dscode-command.ts";
import { commandNeedsNetwork, detectSandboxBoundary } from "../packages/core/src/access.ts";

describe("trusted dscode CLI command", () => {
  it("passes ordinary CLI flags and literal task text without shell evaluation", () => {
    expect(classifyDSCodeCommand(`dscode --model child --effort low --permission full --network -p 'fix files; $TOKEN and $(literal) are task text'`))
      .toEqual({ kind: "trusted", command: { args: ["--model", "child", "--effort", "low", "--permission", "full", "--network", "-p", "fix files; $TOKEN and $(literal) are task text"] } });
    expect(classifyDSCodeCommand('dscode --mode rpc --no-session')).toMatchObject({ kind: "trusted" });
    expect(classifyDSCodeCommand('dscode -p "Read $TOKEN literally"')).toMatchObject({ kind: "trusted" });
  });

  it("rejects direct shell operators, substitution, and chained invocations", () => {
    for (const command of ["dscode -p task | cat", "dscode -p task > result", "dscode -p task && env", "dscode -p $TASK", 'dscode -p "$(env)"', "dscode -p `env`", "dscode -p 'unterminated", "dscode -p task\nenv", "cd /tmp && dscode -p task"]) {
      expect(classifyDSCodeCommand(command), command).toMatchObject({ kind: "invalid" });
    }
    for (const command of ["dscode-vision --image test.png", "echo dscode", `printf '%s' '&& dscode -p task'`, "git status"]) {
      expect(classifyDSCodeCommand(command)).toEqual({ kind: "other" });
    }
  });

  it("resolves an installation entrypoint rather than a PATH command or server argv", () => {
    const resolved = resolveDSCodeExecutable();
    expect(resolved.executable).toBe(process.execPath);
    expect(resolved.prefix).toHaveLength(1);
    expect(resolved.prefix[0]).toMatch(/\/(?:dist\/bundle\/cli|packages\/core\/dist\/rpc-entry)\.js$/);
  });

  it("forwards credentials and CLI environment defaults without preload hooks or unrelated secrets", () => {
    expect(createDSCodeProcessEnvironment({
      DEEPSEEK_API_KEY: "test-key", OPENAI_API_KEY: "other-key", DSCODE_HOME: "/tmp/home",
      DSCODE_PERMISSION: "auto", DSCODE_MODEL: "default-model", LC_ALL: "C", NODE_OPTIONS: "--require bad.cjs",
      CUSTOM_SECRET: "private",
    })).toEqual({ DEEPSEEK_API_KEY: "test-key", OPENAI_API_KEY: "other-key", DSCODE_HOME: "/tmp/home",
      DSCODE_PERMISSION: "auto", DSCODE_MODEL: "default-model", LC_ALL: "C", DSCODE_ALLOW_HEADLESS_KEYRING: "1", DSCODE_SUBAGENT_DEPTH: "1" });
    expect(createDSCodeProcessEnvironment({ DSCODE_ALLOW_HEADLESS_KEYRING: "0" }).DSCODE_ALLOW_HEADLESS_KEYRING).toBe("0");
  });

  it("marks launched children at the original one-level depth limit", () => {
    expect(isDSCodeChild({})).toBe(false);
    expect(isDSCodeChild({ DSCODE_SUBAGENT_DEPTH: "0" })).toBe(false);
    expect(isDSCodeChild(createDSCodeProcessEnvironment({}))).toBe(true);
    expect(isDSCodeChild({ DSCODE_SUBAGENT_DEPTH: "2" })).toBe(true);
  });

  it("keeps child access decisions out of the parent escalation flow", () => {
    const command = "dscode --network --permission full -p 'git fetch; npm install'";
    expect(commandNeedsNetwork(command)).toBe(false);
    expect(detectSandboxBoundary(command, { processId: "1", running: false, exitCode: 1,
      output: "permission denied; network is unreachable", sandbox: "child" }, { sandbox: "read-only", network: false })).toBeUndefined();
  });
});
