export function elevatedCommand(words: string[]): string[] | undefined {
  const name = words[0]?.replace(/^.*\//, "");
  if (name !== "sudo" && name !== "doas") return;

  const valueOptions = name === "sudo"
    ? [
        "-u", "-g", "-h", "-p", "-C", "-D", "-R", "-r", "-t", "-T", "-U",
        "--user", "--group", "--host", "--prompt", "--close-from", "--chdir", "--chroot",
        "--role", "--type", "--command-timeout", "--other-user",
      ]
    : ["-u", "-a", "-C"];
  const flagOptions = name === "sudo"
    ? [
        "-A", "-b", "-E", "-H", "-k", "-n", "-P", "-S", "-s", "-i",
        "--askpass", "--background", "--preserve-env", "--set-home", "--non-interactive",
        "--preserve-groups", "--stdin", "--shell", "--login",
      ]
    : ["-n", "-s"];

  let index = 1;
  while (words[index]?.startsWith("-")) {
    const option = words[index++]!;
    if (option === "--") break;
    if (valueOptions.includes(option)) {
      if (words[index++] === undefined) return;
      continue;
    }
    if (valueOptions.some((value) => value.startsWith("--") && option.startsWith(`${value}=`))) continue;
    if (
      valueOptions.some(
        (value) => value.startsWith("-") && !value.startsWith("--") && option.startsWith(value) && option.length > value.length,
      )
    ) continue;
    if (flagOptions.includes(option)) continue;
    return;
  }
  const child = words.slice(index);
  return child.length ? child : undefined;
}

/** A bounded option scanner, not a complete parser for every shell dialect. */
export function shellCommandPayload(shell: string, args: string[]): string | undefined {
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
export function wrappedCommand(name: string, args: string[]): string[] | undefined {
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
