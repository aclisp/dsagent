import { describe, expect, it } from "vitest";
import { ApprovalController, classifyCommand } from "../src/approval.js";

describe("classifyCommand", () => {
  it("allows simple read-only commands", () => {
    expect(classifyCommand("git status --short")).toBe("read-only");
    expect(classifyCommand("rg TODO src")).toBe("read-only");
    expect(classifyCommand("find . -name '*.ts'")).toBe("read-only");
  });

  it("requires approval for shell syntax and mutating commands", () => {
    expect(classifyCommand("npm test")).toBe("needs-approval");
    expect(classifyCommand("cat file > copy")).toBe("needs-approval");
    expect(classifyCommand("git commit -am test")).toBe("needs-approval");
    expect(classifyCommand("cat /etc/passwd")).toBe("needs-approval");
    expect(classifyCommand("find ../other -type f")).toBe("needs-approval");
  });

  it("marks destructive commands as dangerous", () => {
    expect(classifyCommand("rm -rf build")).toBe("dangerous");
    expect(classifyCommand("git clean -fd")).toBe("dangerous");
    expect(classifyCommand("sudo make install")).toBe("dangerous");
  });
});

describe("ApprovalController", () => {
  it("blocks changes without an interactive approver", async () => {
    const controller = new ApprovalController("ask");
    await expect(controller.approve("write_file", { path: "x.ts" })).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("auto-approves when explicitly trusted", async () => {
    const controller = new ApprovalController("full");
    await expect(controller.approve("run_command", { command: "rm -rf build" })).resolves.toEqual({
      allowed: true,
    });
  });

  it("allows workspace edits but not mutating commands in auto mode", async () => {
    const controller = new ApprovalController("auto");
    await expect(controller.approve("apply_patch", { input: "patch" })).resolves.toEqual({
      allowed: true,
    });
    await expect(controller.approve("exec_command", { cmd: "npm test" })).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("keeps plan mode read-only", async () => {
    const controller = new ApprovalController("plan");
    await expect(controller.approve("exec_command", { cmd: "git status" })).resolves.toEqual({
      allowed: true,
    });
    await expect(controller.approve("apply_patch", { input: "patch" })).resolves.toMatchObject({
      allowed: false,
    });
  });
});
