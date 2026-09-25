import { makeDangerousMatch, type DangerousMatch } from "./match.js";
import { parseOptions, type OptionSpec } from "./options.js";

const rsyncDeletionFlags = [
  "--delete", "--del", "--delete-before", "--delete-during", "--delete-delay",
  "--delete-after", "--delete-excluded", "--delete-missing-args", "--remove-source-files",
];

const rsyncOptions: OptionSpec = {
  flags: [
    ...rsyncDeletionFlags,
    ..."avzhrRltpogDHAXSxnqciubWLPFEKOCJIUVsydkm46".split("").map((flag) => `-${flag}`),
    "--archive", "--verbose", "--compress", "--human-readable", "--recursive",
    "--relative", "--links", "--times", "--perms", "--owner", "--group",
    "--hard-links", "--acls", "--xattrs", "--sparse", "--one-file-system",
    "--dry-run", "--quiet", "--checksum", "--itemize-changes", "--update",
    "--backup", "--whole-file", "--copy-links", "--progress", "--partial",
    "--inplace", "--numeric-ids", "--stats", "--ignore-errors", "--force",
    "--ignore-existing", "--existing", "--prune-empty-dirs", "--size-only",
    "--omit-dir-times", "--delay-updates", "--list-only", "--help", "--version",
  ],
  values: [
    "-e", "--rsh", "-f", "--filter", "-B", "--block-size", "-T", "--temp-dir",
    "-M", "--remote-option", "--exclude", "--include", "--exclude-from", "--include-from",
    "--files-from", "--rsync-path", "--backup-dir", "--suffix", "--partial-dir",
    "--link-dest", "--copy-dest", "--compare-dest", "--max-delete", "--max-size",
    "--min-size", "--bwlimit", "--timeout", "--contimeout", "--port", "--chmod",
    "--chown", "--log-file", "--log-file-format", "--out-format", "--info", "--debug",
    "--password-file", "--compress-level",
  ],
  aliases: { "-n": "--dry-run", "-V": "--version" },
};

function rsyncMatch(args: string[], elevated: boolean): DangerousMatch | undefined {
  const parsed = parseOptions(args, rsyncOptions);
  if (!parsed || ["--dry-run", "--list-only", "--help", "--version"].some((flag) => parsed.flags.has(flag))) return;
  if (parsed.flags.has("--remove-source-files")) {
    return makeDangerousMatch("rsync --remove-source-files removes transferred source files", "Delete source files after transferring them", elevated);
  }
  if (rsyncDeletionFlags.some((flag) => parsed.flags.has(flag))) {
    return makeDangerousMatch("rsync deletion options can remove destination files", "Delete destination files while synchronizing", elevated);
  }
}

const dockerOptions: OptionSpec = {
  booleans: ["-D", "--debug", "--tls", "--tlsverify", "--help"],
  values: ["-H", "--host", "-c", "--context", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"],
};

const composeOptions = {
  booleans: ["--help", "--dry-run", "--compatibility", "--all-resources"],
  values: ["-f", "--file", "-p", "--project-name", "--project-directory", "--env-file", "--profile", "--ansi", "--progress", "--parallel"],
} satisfies OptionSpec;

function dockerMatch(args: string[], elevated: boolean, standaloneCompose = false): DangerousMatch | undefined {
  const root = standaloneCompose ? { flags: new Set<string>(), operands: ["compose", ...args] }
    : parseOptions(args, dockerOptions, true);
  if (!root || root.flags.has("--help")) return;
  const [group, ...rest] = root.operands;
  if (group === "compose") {
    const compose = parseOptions(rest, composeOptions, true);
    if (!compose || compose.operands[0] !== "down") return;
    // A later explicit --dry-run=false overrides an earlier true. Parse the
    // full argument list as well so persistent options retain their order.
    const all = parseOptions(rest, {
      booleans: [...composeOptions.booleans, "-v", "--volumes", "--remove-orphans"],
      values: [...composeOptions.values, "--rmi", "-t", "--timeout"],
      aliases: { "-v": "--volumes" },
    });
    if (!all || all.flags.has("--help") || all.flags.has("--dry-run") || !all.flags.has("--volumes")) return;
    return makeDangerousMatch("docker compose down --volumes deletes volumes", "Stop the Compose application and delete its volumes", elevated);
  }
  if (!["volume", "system", "container", "image", "builder"].includes(group ?? "")) return;
  const namespace = parseOptions(rest, { booleans: ["--help"] }, true);
  if (!namespace || namespace.flags.has("--help")) return;
  const [action, ...actionArgs] = namespace.operands;
  if (action !== "prune" && !(group === "volume" && action === "rm")) return;
  const operation = parseOptions(actionArgs, {
    booleans: ["--help", "-f", "--force", "-a", "--all", "--volumes"],
    values: ["--filter", "--keep-storage"],
  });
  if (!operation || operation.flags.has("--help")) return;
  return group === "volume"
    ? makeDangerousMatch(`docker volume ${action} deletes volumes`, "Delete Docker volumes and their data", elevated)
    : makeDangerousMatch(`docker ${group} prune deletes unused resources`, `Delete unused Docker ${group} resources`, elevated);
}

const systemctlActions: Readonly<Record<string, string>> = {
  stop: "Stop the selected units",
  restart: "Restart the selected units",
  "try-restart": "Restart the selected units if running",
  "reload-or-restart": "Reload or restart the selected units",
  "reload-or-try-restart": "Reload or restart running units",
  kill: "Signal processes belonging to the selected units",
  disable: "Disable the selected units",
  mask: "Prevent the selected units from being started",
  isolate: "Switch targets and stop units outside the target",
  halt: "Halt the system",
  poweroff: "Power off the system",
  reboot: "Restart the system",
  kexec: "Restart the system with another kernel",
  "soft-reboot": "Restart userspace",
  rescue: "Switch to rescue mode",
  emergency: "Switch to emergency mode",
};

function systemctlMatch(args: string[], elevated: boolean): DangerousMatch | undefined {
  const parsed = parseOptions(args, {
    flags: [
      "--user", "--system", "--global", "--no-block", "--wait", "--force", "-f",
      "--quiet", "-q", "--no-pager", "--no-legend", "--now", "--runtime", "--no-reload",
      "--no-ask-password", "--no-wall", "--dry-run", "--help", "-h", "--version", "-i",
    ],
    values: ["-H", "--host", "-M", "--machine", "--root", "--image", "--job-mode", "--kill-whom", "--signal", "-s", "--type", "-t", "--state", "--property", "-p", "--check-inhibitors"],
    aliases: { "-h": "--help" },
  });
  if (!parsed || parsed.flags.has("--help") || parsed.flags.has("--version")) return;
  const action = parsed.operands[0] ?? "";
  // systemctl does NOT implement --dry-run for every verb (notably stop/restart).
  if (parsed.flags.has("--dry-run") && ["halt", "poweroff", "reboot", "kexec", "rescue", "emergency"].includes(action)) return;
  const intent = Object.hasOwn(systemctlActions, action) ? systemctlActions[action] : undefined;
  if (intent) return makeDangerousMatch(`systemctl ${action} can disrupt services or system state`, intent, elevated);
}

export function dangerousServerMatch(name: string, args: string[], elevated: boolean): DangerousMatch | undefined {
  switch (name) {
    case "rsync": return rsyncMatch(args, elevated);
    case "docker": return dockerMatch(args, elevated);
    case "docker-compose": return dockerMatch(args, elevated, true);
    case "systemctl": return systemctlMatch(args, elevated);
  }
}
