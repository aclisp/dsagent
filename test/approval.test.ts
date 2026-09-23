import { describe, expect, it } from "vitest";
import { ApprovalController, classifyCommand } from "../packages/core/src/approval.js";
import { detectDangerousCommand } from "../packages/core/src/dangerous-command.js";

describe("dangerous command rules", () => {
  it.each([
    "/bin/rm -rf build", "true;rm -rf build", "true&&rm -rf build",
    "false||rm -rf build", "echo x|rm -rf build", "pwd\nrm -rf build",
    "FOO=bar env -u HOME command -p /bin/rm -rf build",
    "env --chdir=repo rm file", "r\\m file", '"rm" file',
    "rm \\\n file", "rm -- --help", "rm -f file >output",
    "git -C repo -c core.pager=cat reset --hard",
    "git --git-dir=.git --work-tree . reset --hard",
    "git clean -fd", "git clean -fd -- -n", "git restore src/index.ts",
    "git restore -SW file", "git restore --staged --worktree file",
    "git checkout -- file", "git checkout .", "git checkout -f branch",
    "git branch -D feature", "git branch --delete --force feature",
    "git branch -df feature", "find . -delete", "truncate -s 0 data.db",
    "sudo make install", "pkill worker", "mkfs.ext4 /dev/example",
    "find . -name '*.log' -exec rm {} +",
    "find . -exec echo {} \\; -execdir /bin/rm {} \\;",
    "find . -exec sh -c 'rm file' \\;",
    "git ls-files '*.log' | xargs -0 rm", "xargs -I {} rm {}",
    "xargs --max-args=1 rm", "xargs -n1 rm", "xargs -rt rm",
    "nice rm file", "nice -n 10 rm file", "nice -10 rm file",
    "timeout 10 rm file", "timeout -s TERM -k 2s 10s rm file",
    "timeout --foreground 0.5s nice env FOO=bar rm file",
    "sh -c 'rm -rf ~/proj'", 'bash -lc "rm -rf /"',
    "sh -c 'bash -c \"rm file\"'", "bash -l -c 'git reset --hard'",
    "shred secret", "dd if=input of=output", "dd of=/dev/example",
    "git stash clear", "git -C repo stash drop stash@{0}",
    'rm "$(pwd)/file"', "rm file <<EOF\ntext\nEOF", "rm file`date`",
    "xargs rm \"$(pwd)\"", "rm <(echo file)",
    "bash -o pipefail -c 'rm -rf x'", "bash -euo pipefail -c 'rm -rf x'",
    "bash --login -c 'rm x'", "bash --noprofile --norc --posix -c 'rm x'",
    "bash -o errexit -o pipefail -c 'rm x'",
    "eval 'rm -rf x'", "eval 'rm' '-rf x'", "eval -- 'rm x'",
    "git switch --discard-changes main", "git switch --force main", "git switch -f main",
    "git rm -f tracked.ts", "git rm --force tracked.ts", "git rm -rf src",
    "git -C repo rm -f tracked.ts", "git rm -f -- --cached", "git rm -f -- -n",
    "nohup rm x", "nohup -- /bin/rm x", "nohup bash -euo pipefail -c 'rm x'",
  ])("detects %s", (command) => {
    expect(classifyCommand(command)).toBe("dangerous");
    expect(detectDangerousCommand(command).reason).toBeTruthy();
  });

  it.each([
    ["sudo rm -rf /", "Delete the specified files or directories (with elevated privileges)"],
    ["doas -u root rm -rf /", "Delete the specified files or directories (with elevated privileges)"],
    ["sudo --user=root git reset --hard", "Reset the index and working tree, discarding changes (with elevated privileges)"],
    ["sudo sudo rm -rf /", "Delete the specified files or directories (with elevated privileges)"],
    ["sudo make install", "Run a command with elevated privileges"],
  ])("summarizes elevated command intent for %s", (command, intent) => {
    expect(detectDangerousCommand(command)).toMatchObject({ dangerous: true, intent });
  });

  it("reports the underlying destructive reason through privilege wrappers", () => {
    expect(detectDangerousCommand("sudo rm -rf /").reason).toBe(
      "rm can delete data or alter system/process state",
    );
    expect(detectDangerousCommand("doas -u root rm -rf /").reason).toBe(
      "rm can delete data or alter system/process state",
    );
  });

  it.each([
    ["find . -name '*.log' -exec rm {} +", "Run a potentially destructive command for each matching file"],
    ["git ls-files '*.log' | xargs rm", "Run a potentially destructive command for each input item"],
    ["git checkout .", "Discard working tree changes with checkout"],
    ["git checkout -- file", "Discard working tree changes with checkout"],
    ["dd if=input of=output", "Overwrite the output target given to dd (of=)"],
    ["git stash clear", "Delete all saved Git stashes"],
    ["git stash drop stash@{0}", "Delete a saved Git stash"],
  ])("uses precise dangerous intent for %s", (command, intent) => {
    expect(detectDangerousCommand(command)).toMatchObject({ dangerous: true, intent });
  });

  it.each([
    "echo rm", "rg kill src", "echo 'rm -rf build; git reset --hard'",
    'echo "rm -rf build; git reset --hard"', "echo foo\\;rm file",
    "echo x # rm -rf build", "cat > rm", "echo x 2>&1",
    "command -v rm", "env --help", "rm --help", "rm --version",
    "git clean -nd", "git clean --dry-run -fd", "git reset --soft HEAD~1",
    "git reset HEAD file", "git restore --staged file", "git restore -S file",
    "git checkout feature", "git checkout -b feature", "git branch -d feature",
    "git status", "git restore --help", "git clean -h", "npm test", "find . -name rm", "echo 'unterminated rm",
    "find . -exec echo rm {} +", "find . -execdir git clean -nd \\;",
    "find . -name '-delete'", "find . -name '-exec' -print",
    "xargs echo rm", "xargs -I rm echo rm", "xargs --unknown rm",
    "nice -n 10 echo rm", "nice --unknown rm", "timeout 10 echo rm",
    "timeout --signal rm 10 echo hello", "timeout --unknown 10 rm",
    "sh -c 'echo rm'", "bash -lc 'git clean -nd'", "sh script.sh rm",
    "shred --help", "dd if=input", "dd if=input of=/dev/null",
    "git stash list", "git stash show", "git stash drop --help",
    "bash -euo pipefail -c 'echo rm'", "bash --login -c 'git clean -nd'",
    "bash -o pipefail script.sh rm", "bash -o", "bash -o -c 'rm x'",
    "bash --unknown -c 'rm x'", "bash -Z -c 'rm x'",
    "eval 'echo rm'", "eval 'git clean -nd'", "eval",
    "git switch main", "git switch -c feature", "git switch --help",
    "git rm tracked.ts", "git rm -r src", "git rm -fn tracked.ts",
    "git rm --force --dry-run tracked.ts", "git rm -f --cached tracked.ts",
    "git rm --cached --force tracked.ts", "git rm --help", "git rm -- -f",
    "nohup echo rm", "nohup --help", "nohup --version", "nohup --unknown rm",
  ])("does not flag %s", (command) => {
    expect(classifyCommand(command)).not.toBe("dangerous");
  });

  // These negative results describe coverage limits, not safe commands.
  it.each([
    "cat <<EOF\nrm -rf build\nEOF", 'echo "$(rm -rf build)"',
    "echo `rm -rf build`", "python -c 'import os; os.remove(\"file\")'",
    "printf 'rm -rf x' | sh", "env -S 'rm -rf x'",
    'git clean "$(pwd)" -n', 'r$(echo m) file',
    'eval "$COMMAND"', "setsid rm x", "stdbuf -o0 rm x",
  ])("leaves unsupported syntax uninterpreted: %s", (command) => {
    expect(detectDangerousCommand(command).dangerous).toBe(false);
  });

  it("bounds recursive inspection", () => {
    expect(detectDangerousCommand("nice ".repeat(100) + "rm file").dangerous).toBe(false);
  });
});

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
