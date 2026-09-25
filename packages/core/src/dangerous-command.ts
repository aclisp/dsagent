import { simpleCommands } from "./dangerous-command/shell.js";
import { elevatedCommand, shellCommandPayload, wrappedCommand } from "./dangerous-command/wrappers.js";
import { makeDangerousMatch, withIntent, type DangerousMatch } from "./dangerous-command/match.js";
import { dangerousGitMatch } from "./dangerous-command/git.js";
import { dangerousServerMatch } from "./dangerous-command/server.js";

export interface DangerousCommandResult {
  dangerous: boolean;
  /** Concise, user-facing summary of the operation recognized by a rule. */
  intent?: string;
  /** Why the command matched a destructive rule. */
  reason?: string;
}

export const DEFAULT_DANGEROUS_COMMAND_INTENT = "Potentially destructive operation";

/** A small shell heuristic, not a security boundary. A negative result means no
 * rule matched, not that execution is safe. Dynamic commands, substitutions,
 * heredocs, non-shell interpreter scripts and stdin are not interpreted.
 * Literal shell -c payloads and known command wrappers are checked recursively. */
export function detectDangerousCommand(command: string): DangerousCommandResult {
  const match = findDangerousMatch(command, 0);
  return match
    ? { dangerous: true, reason: match.reason, intent: match.intent }
    : { dangerous: false };
}

const maxDepth = 4;
const elevatedCommandIntent = "Run a command with elevated privileges";

/** Risks determined by the executable alone, even with incomplete arguments. */
const commandIntents: Readonly<Record<string, string>> = {
  rm: "Delete the specified files or directories",
  rmdir: "Remove the named directories",
  unlink: "Delete the named file",
  shutdown: "Shut down the system",
  reboot: "Restart the system",
  kill: "Terminate one or more processes",
  pkill: "Terminate one or more processes",
  killall: "Terminate one or more processes",
  truncate: "Truncate or empty the target file",
  shred: "Overwrite and remove the target file",
};

function findDangerousMatch(command: string, depth: number, elevated = false): DangerousMatch | undefined {
  if (depth > maxDepth) return;
  for (const { words, complete } of simpleCommands(command)) {
    const match = dangerousMatch(words, depth, complete, elevated);
    if (match) return match;
  }
}

function dangerousMatch(
  words: string[],
  depth: number,
  complete: boolean,
  elevated = false,
): DangerousMatch | undefined {
  if (depth > maxDepth) return;
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(word)) { index++; continue; }
    const name = word.replace(/^.*\//, "");
    if (name === "command") {
      index++;
      if (words[index] === "-v" || words[index] === "-V") return;
      if (words[index] === "-p") index++;
      if (words[index] === "--") index++;
      continue;
    }
    if (name === "env") {
      index++;
      while (words[index]?.startsWith("-")) {
        const option = words[index++]!;
        if (option === "--") break;
        if (["-u", "--unset", "-C", "--chdir"].includes(option)) index++;
        else if (!["-i", "--ignore-environment"].includes(option) &&
          !/^(--unset=|--chdir=)/.test(option)) return;
      }
      continue;
    }
    const args = words.slice(index + 1);
    if (["xargs", "nice", "timeout"].includes(name)) {
      const child = wrappedCommand(name, args);
      const childMatch = child && dangerousMatch(child, depth + 1, complete, elevated);
      if (!childMatch) return;
      return name === "xargs"
        ? withIntent(childMatch, "Run a potentially destructive command for each input item")
        : childMatch;
    }
    // Only exempt standalone informational invocations; a help-looking operand
    // after -- must not hide an actual deletion.
    if (complete && args.length === 1 && ["--help", "--version"].includes(args[0]!)) return;
    if (name === "nohup") {
      const child = args[0] === "--" ? args.slice(1) : args;
      if (child[0]?.startsWith("-")) return;
      return dangerousMatch(child, depth + 1, complete, elevated);
    }
    if (name === "sudo" || name === "doas") {
      const child = elevatedCommand(words.slice(index));
      const childMatch = child && dangerousMatch(child, depth + 1, complete, true);
      return childMatch ?? makeDangerousMatch(
        `${name} can delete data or alter system/process state`,
        elevatedCommandIntent,
        true,
        true,
      );
    }
    const intent = name === "mkfs" || name.startsWith("mkfs.")
      ? "Format the target device or filesystem"
      : Object.hasOwn(commandIntents, name) ? commandIntents[name] : undefined;
    if (intent) return makeDangerousMatch(`${name} can delete data or alter system/process state`, intent, elevated);
    // A truncated command only supplies evidence for command-name rules. Later
    // arguments could change a parameter-sensitive decision (e.g. clean -n).
    if (!complete) return;
    if (name === "eval") {
      // eval joins arguments before parsing; expansion and dynamically assembled
      // payloads remain out of scope, just as for shell -c.
      const payload = args[0] === "--" ? args.slice(1) : args;
      return findDangerousMatch(payload.join(" "), depth + 1, elevated);
    }
    if (["sh", "bash", "dash", "zsh", "ksh"].includes(name)) {
      const payload = shellCommandPayload(name, args);
      return payload === undefined ? undefined : findDangerousMatch(payload, depth + 1, elevated);
    }
    if (name === "dd" && args.some((arg) => arg.startsWith("of=") && arg !== "of=/dev/null" && arg !== "of=")) {
      return makeDangerousMatch("dd writes an explicit output file", "Overwrite the output target given to dd (of=)", elevated);
    }
    if (name === "find") {
      for (let i = 0; i < args.length; i++) {
        if (["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"].includes(args[i]!)) { i++; continue; }
        if (args[i] === "-delete") {
          return makeDangerousMatch("find -delete removes files", "Delete files matched by find", elevated);
        }
        if (["-exec", "-execdir"].includes(args[i]!)) {
          const start = ++i;
          while (i < args.length && args[i] !== ";" && args[i] !== "+") i++;
          const childMatch = dangerousMatch(args.slice(start, i), depth + 1, true, elevated);
          if (childMatch) {
            return withIntent(childMatch, "Run a potentially destructive command for each matching file");
          }
        }
      }
    }
    if (name === "git") return dangerousGitMatch(args, elevated);
    return dangerousServerMatch(name, args, elevated);
  }
}
