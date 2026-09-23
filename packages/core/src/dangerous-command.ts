export interface DangerousCommandResult {
  dangerous: boolean;
  reason?: string;
}

/** A small shell heuristic, not a security boundary. A negative result means no
 * rule matched, not that execution is safe. Dynamic commands, substitutions,
 * heredocs, non-shell interpreter scripts and stdin are not interpreted.
 * Literal shell -c payloads and known command wrappers are checked recursively. */
export function detectDangerousCommand(command: string): DangerousCommandResult {
  return detect(command, 0);
}

const maxDepth = 4;

function detect(command: string, depth: number): DangerousCommandResult {
  if (depth > maxDepth) return { dangerous: false };
  for (const { words, complete } of simpleCommands(command)) {
    const reason = dangerousReason(words, depth, complete);
    if (reason) return { dangerous: true, reason };
  }
  return { dangerous: false };
}

function dangerousReason(words: string[], depth = 0, complete = true): string | undefined {
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
      return child && dangerousReason(child, depth + 1, complete);
    }
    // Only exempt standalone informational invocations; a help-looking operand
    // after -- must not hide an actual deletion.
    if (complete && args.length === 1 && ["--help", "--version"].includes(args[0]!)) return;
    if (name === "nohup") {
      const child = args[0] === "--" ? args.slice(1) : args;
      if (child[0]?.startsWith("-")) return;
      return dangerousReason(child, depth + 1, complete);
    }
    if (["rm", "rmdir", "sudo", "doas", "mkfs", "shutdown", "reboot", "kill", "pkill", "killall", "truncate", "shred"].includes(name) || name.startsWith("mkfs.")) {
      return `${name} can delete data or alter system/process state`;
    }
    // A truncated command only supplies evidence for command-name rules. Later
    // arguments could change a parameter-sensitive decision (e.g. clean -n).
    if (!complete) return;
    if (name === "eval") {
      // eval joins arguments before parsing; expansion and dynamically assembled
      // payloads remain out of scope, just as for shell -c.
      const payload = args[0] === "--" ? args.slice(1) : args;
      return detect(payload.join(" "), depth + 1).reason;
    }
    if (["sh", "bash", "dash", "zsh", "ksh"].includes(name)) {
      const payload = shellCommandPayload(name, args);
      return payload === undefined ? undefined : detect(payload, depth + 1).reason;
    }
    if (name === "dd" && args.some((arg) => arg.startsWith("of=") && arg !== "of=/dev/null" && arg !== "of=")) {
      return "dd writes an explicit output file";
    }
    if (name === "find") {
      for (let i = 0; i < args.length; i++) {
        if (["-name", "-iname", "-path", "-ipath", "-regex", "-iregex"].includes(args[i]!)) { i++; continue; }
        if (args[i] === "-delete") return "find -delete removes files";
        if (["-exec", "-execdir"].includes(args[i]!)) {
          const start = ++i;
          while (i < args.length && args[i] !== ";" && args[i] !== "+") i++;
          const reason = dangerousReason(args.slice(start, i), depth + 1);
          if (reason) return reason;
        }
      }
    }
    if (name === "git") return dangerousGitReason(args);
    return;
  }
}

/** A bounded option scanner, not a complete parser for every shell dialect. */
function shellCommandPayload(shell: string, args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const option = args[i]!;
    if (shell === "bash" && ["--login", "--noprofile", "--norc", "--posix"].includes(option)) continue;
    if (!/^-[celuvxinsro]+$/.test(option)) return;
    let command = false;
    for (const flag of option.slice(1)) {
      if (flag === "c") command = true;
      if (flag === "o") {
        // -o consumes a separate option name, including in -euo pipefail.
        const value = args[++i];
        if (!value || value.startsWith("-")) return;
      }
    }
    if (command) return args[i + 1];
  }
}

/** Only skip options whose arity is known; unknown options are not guessed. */
function wrappedCommand(name: string, args: string[]): string[] | undefined {
  const valueOptions = name === "xargs"
    ? ["-I", "-L", "-n", "-P", "-s", "-E", "-d", "-a", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--eof", "--delimiter", "--arg-file"]
    : name === "nice" ? ["-n", "--adjustment"] : ["-s", "--signal", "-k", "--kill-after"];
  const flags = name === "xargs" ? ["-0", "-r", "-t", "-p", "-x", "--null", "--no-run-if-empty", "--verbose", "--interactive", "--exit"]
    : name === "timeout" ? ["--foreground", "--preserve-status", "-v", "--verbose"] : [];
  let i = 0;
  while (args[i]?.startsWith("-")) {
    const option = args[i++]!;
    if (option === "--") break;
    if (valueOptions.includes(option)) { if (args[i++] === undefined) return; }
    else if (flags.includes(option)) continue;
    else if (valueOptions.some((flag) => flag.startsWith("--") ? option.startsWith(`${flag}=`) : option.startsWith(flag) && option.length > flag.length)) continue;
    else if (name === "nice" && /^-\d+$/.test(option)) continue;
    else if (name === "xargs" && /^-[0rtpx]+$/.test(option)) continue;
    else return;
  }
  if (name === "timeout" && !/^\d+(?:\.\d+)?[smhd]?$/.test(args[i++] ?? "")) return;
  return args.slice(i);
}

function dangerousGitReason(args: string[]): string | undefined {
  let index = 0;
  while (args[index]?.startsWith("-")) {
    const option = args[index++]!;
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(option)) index++;
    else if (!/^(?:-[Cc].+|--(?:git-dir|work-tree|namespace|config-env)=.+)$/.test(option) &&
      !["--no-pager", "--paginate", "--no-optional-locks", "--bare"].includes(option)) return;
  }
  const subcommand = args[index++];
  const rest = args.slice(index);
  if (rest.length === 1 && ["-h", "--help"].includes(rest[0]!)) return;
  const separator = rest.indexOf("--");
  const options = separator < 0 ? rest : rest.slice(0, separator);
  const has = (flag: string) => options.includes(flag);
  const short = (flag: string) => options.some((arg) => /^-[^-]/.test(arg) && arg.slice(1).includes(flag));
  switch (subcommand) {
    case "rm":
      if ((has("--force") || short("f")) && !has("--cached") && !has("--dry-run") && !short("n")) {
        return "git rm --force can discard working tree changes";
      }
      break;
    case "switch":
      if (has("--discard-changes") || has("--force") || short("f")) {
        return "git switch discards working tree changes";
      }
      break;
    case "stash":
      if (rest.length === 2 && ["-h", "--help"].includes(rest[1]!)) break;
      if (["clear", "drop"].includes(rest[0] ?? "")) return "git stash deletes saved changes";
      break;
    case "clean":
      if (!has("--dry-run") && !short("n")) return "git clean removes untracked files";
      break;
    case "reset":
      if (has("--hard")) return "git reset --hard discards working tree changes";
      break;
    case "restore":
      if ((!has("--staged") && !short("S")) || has("--worktree") || short("W")) {
        return "git restore overwrites working tree files";
      }
      break;
    case "checkout":
      if ((separator >= 0 && separator < rest.length - 1) || has(".") || has("--force") || short("f")) {
        return "git checkout can discard working tree changes";
      }
      break;
    case "branch":
      if (short("D") || ((has("--delete") || short("d")) && (has("--force") || short("f")))) {
        return "git branch force-deletes a branch";
      }
      break;
  }
}

/** Split only literal simple commands. Stop at unsupported executable syntax
 * rather than mistaking its contents (or heredoc data) for literal commands. */
function simpleCommands(source: string): Array<{ words: string[]; complete: boolean }> {
  const commands: Array<{ words: string[]; complete: boolean }> = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  let redirect = false;
  const flushWord = () => {
    if (started) {
      if (!redirect) words.push(word);
      redirect = false;
      word = "";
      started = false;
    }
  };
  const flushCommand = () => {
    flushWord();
    if (words.length) commands.push({ words, complete: true });
    words = [];
    redirect = false;
  };
  const stop = () => {
    // Do not retain a partial word: r$(...) is not the literal command r.
    if (words.length) commands.push({ words, complete: false });
    return commands;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quote === "'") {
      if (char === "'") quote = "";
      else word += char;
      continue;
    }
    if (char === "`" || (char === "$" && source[i + 1] === "(")) return stop();
    if (char === "\\" && i + 1 < source.length) {
      const next = source[i + 1]!;
      if (!quote || /[\n$`"\\]/.test(next)) {
        i++;
        if (next !== "\n") { word += next; started = true; }
        continue;
      }
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "#" && !started) {
      while (i < source.length && source[i] !== "\n") i++;
      flushCommand();
    } else if (";&|\n\r()".includes(char)) {
      flushCommand();
    } else if (char === "<" || char === ">") {
      if (source[i + 1] === "<" || source[i + 1] === "(") { flushWord(); return stop(); }
      if (/^\d+$/.test(word)) { word = ""; started = false; }
      flushWord();
      redirect = true;
      if (source[i + 1] === char) i++;
      if (source[i + 1] === "&") i++;
    } else if (/\s/.test(char)) {
      flushWord();
    } else { word += char; started = true; }
  }
  if (!quote) flushCommand();
  return commands;
}
