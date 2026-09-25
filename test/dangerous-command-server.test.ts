import { describe, expect, it } from "vitest";
import { detectDangerousCommand } from "../packages/core/src/dangerous-command.js";

describe("server command risks", () => {
  it.each([
    "rsync -avz --delete src/ dst/",
    ...["--del", "--delete-before", "--delete-during", "--delete-delay", "--delete-after", "--delete-excluded", "--delete-missing-args"].map((flag) => `rsync -a ${flag} src/ dst/`),
    "rsync -a --remove-source-files src/ dst/",
    "rsync -a src/ dst/ --delete",
    "rsync -a --delete --exclude --dry-run src/ dst/",
    "rsync -a --delete --exclude=--dry-run src/ dst/",
    "rsync -a --delete -e 'ssh -n' src/ dst/",
    "rsync -ae'n' --delete src/ dst/",
    "rsync -a --delete -f'-n' src/ dst/",
    "rsync -a --delete -- src/ -n",
    "docker compose down -v",
    "docker compose down --volumes",
    "docker --context prod compose -f compose.yml -p app down --volumes --timeout 10",
    "docker -Hunix:///var/run/docker.sock compose --profile app down -v",
    "docker compose down --volumes=true",
    "docker compose down --volumes=false -v",
    "docker compose down -v=true",
    "docker compose --dry-run=false down -v",
    "docker compose --dry-run down -v --dry-run=false",
    "docker compose --help down -v --help=false",
    "docker compose down -v --env-file --dry-run",
    "docker-compose -f compose.yml down -v",
    "docker volume rm data",
    "docker volume rm -- --help",
    "docker volume prune -af",
    "docker volume prune --filter 'label=keep=false'",
    "docker volume prune --filter --help",
    "docker volume prune --help=false",
    "docker system prune -af --volumes",
    "docker container prune -f",
    "docker image prune -af",
    "docker builder prune --keep-storage 1GB",
    "systemctl stop app",
    "systemctl --user restart app",
    "systemctl restart --no-block app",
    "systemctl -Hserver -q stop app",
    "systemctl --host stop restart app",
    "systemctl --signal SIGKILL kill app",
    "systemctl --root --help stop app",
    "systemctl stop -- --help",
    "systemctl --dry-run stop app",
    "systemctl --dry-run restart app",
    ...["try-restart", "reload-or-restart", "reload-or-try-restart", "disable", "mask", "isolate"].map((action) => `systemctl ${action} app`),
    ...["halt", "poweroff", "reboot", "kexec", "soft-reboot", "rescue", "emergency"].map((action) => `systemctl ${action}`),
    "git worktree remove --force ../old",
    "git -C repo worktree remove -ff ../old",
    "git worktree remove ../old -f",
    "git worktree remove -f -- --help",
    "unlink data.db",
    "unlink -- --help",
  ])("flags %s", (command) => {
    expect(detectDangerousCommand(command)).toMatchObject({
      dangerous: true, reason: expect.any(String), intent: expect.any(String),
    });
  });

  it.each([
    "rsync -avz src/ dst/",
    "rsync -an --delete src/ dst/",
    "rsync --dry-run -a --remove-source-files src/ dst/",
    "rsync -a --delete src/ dst/ -n",
    "rsync -a --delete --list-only src/ dst/",
    "rsync -a --exclude --delete src/ dst/",
    "rsync -a --exclude=--delete src/ dst/",
    "rsync -a -- --delete dst/",
    "rsync --help", "rsync -V",
    "docker compose down",
    "docker compose down --volumes=false",
    "docker compose down -v --volumes=false",
    "docker compose down -v=false",
    "docker compose --dry-run down -v",
    "docker compose down -v --dry-run",
    "docker compose down -v --help",
    "docker compose down -- -v",
    "docker compose -f down config",
    "docker compose down --env-file -v",
    "docker compose config", "docker compose ps",
    "docker --context volume ps", "docker help volume rm",
    "docker volume ls", "docker volume inspect data",
    "docker volume --help rm data", "docker volume rm --help",
    "docker system df", "docker system prune --help",
    "docker-compose --dry-run down -v",
    "systemctl status app", "systemctl show app", "systemctl is-active app",
    "systemctl --host stop status app", "systemctl show -p restart app",
    "systemctl --help stop app", "systemctl -h restart app",
    "systemctl daemon-reload", "systemctl start app",
    "systemctl reboot --dry-run", "systemctl --dry-run poweroff",
    "git worktree remove ../old", "git worktree list", "git worktree prune",
    "git worktree remove -- -f", "git worktree remove -f --help",
    "unlink --help", "unlink --version",
  ])("does not flag informational or out-of-scope forms: %s", (command) => {
    expect(detectDangerousCommand(command).dangerous).toBe(false);
  });

  it.each([
    "rsync --unknown --delete src/ dst/",
    "rsync --delete --exclude",
    "docker --unknown volume rm data",
    "docker compose down --volumes --timeout",
    "docker compose down -v --dry-run=maybe",
    "systemctl --unknown restart app",
    "git worktree remove --unknown -f ../old",
    'rsync --delete "$(pwd)" dst/',
    'docker compose down -v "$(echo app)"',
  ])("does not guess unsupported or incomplete arguments: %s", (command) => {
    expect(detectDangerousCommand(command).dangerous).toBe(false);
  });

  it("preserves intent through wrappers and privilege escalation", () => {
    expect(detectDangerousCommand("sudo env FOO=bar docker compose down -v")).toMatchObject({
      dangerous: true,
      intent: "Stop the Compose application and delete its volumes (with elevated privileges)",
    });
    expect(detectDangerousCommand("bash -c 'rsync -a --delete src/ dst/'")).toMatchObject({
      dangerous: true, intent: "Delete destination files while synchronizing",
    });
  });
});
