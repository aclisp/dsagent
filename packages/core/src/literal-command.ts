export type LiteralCommandClassification =
  | { kind: "other" }
  | { kind: "invalid"; reason: string }
  | { kind: "trusted"; command: { args: string[] } };

function executableNames(executable: string, windows: boolean): string[] {
  return windows ? [executable.toLowerCase(), `${executable.toLowerCase()}.exe`] : [executable];
}

function startsWithExecutable(command: string, executable: string, windows: boolean): boolean {
  const text = windows ? command.trimStart().toLowerCase() : command.trimStart();
  return executableNames(executable, windows).some(name =>
    text.startsWith(name) && (text.length === name.length || /[\s;&|<>()]/.test(text[name.length]!)));
}

/** Credentials are only forwarded to direct, literal invocations; never to a shell. */
export function classifyLiteralCommand(
  command: string,
  executable: string,
  platform: NodeJS.Platform = process.platform,
): LiteralCommandClassification {
  const windows = platform === "win32";
  if (!startsWithExecutable(command, executable, windows)) {
    return containsChainedCommand(command, executable, windows)
      ? { kind: "invalid", reason: `${executable} must be invoked directly without cd or command chaining` }
      : { kind: "other" };
  }
  const parsed = parseLiteralCommandWords(command, windows);
  if (!parsed.ok) return { kind: "invalid", reason: parsed.reason };
  const name = windows ? parsed.words[0]?.toLowerCase() : parsed.words[0];
  if (!name || !executableNames(executable, windows).includes(name)) {
    return { kind: "invalid", reason: `the executable must be exactly ${executable}${windows ? ` or ${executable}.exe` : ""}` };
  }
  return { kind: "trusted", command: { args: parsed.words.slice(1) } };
}

const UNSAFE_UNQUOTED_CHARACTERS = new Set([
  "&",
  "|",
  ";",
  "<",
  ">",
  "(",
  ")",
  "`",
  "$",
  "*",
  "?",
  "[",
  "]",
  "{",
  "}",
  "#",
]);

function containsChainedCommand(command: string, executable: string, windows: boolean): boolean {
  let quote: "'" | '"' | undefined;
  const escape = windows ? "`" : "\\";
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote !== undefined) {
      if (character === quote) {
        if (windows && command[index + 1] === quote) index += 1;
        else quote = undefined;
      } else if (character === escape && quote === '"') index += 1;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === escape) {
      index += 1;
      continue;
    }
    if (!";&|()\n\r".includes(character)) continue;

    let commandStart = index + 1;
    while (/\s|[;&|()]/.test(command[commandStart] ?? "")) commandStart += 1;
    if (startsWithExecutable(command.slice(commandStart), executable, windows)) return true;
  }
  return false;
}

function parseLiteralCommandWords(
  command: string,
  windows: boolean,
): { ok: true; words: string[] } | { ok: false; reason: string } {
  const words: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let started = false;

  const pushCurrent = (): void => {
    if (!started) return;
    words.push(current);
    current = "";
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (character === "\n" || character === "\r") {
      return { ok: false, reason: "the command must be one physical line" };
    }

    if (quote === "single") {
      if (character === "'") {
        if (windows && command[index + 1] === "'") { current += "'"; index += 1; }
        else quote = undefined;
      }
      else current += character;
      continue;
    }

    // PowerShell uses backticks, not backslashes. Restrict escapes to literal
    // punctuation/whitespace: control and Unicode escape expressions are outside
    // this grammar, rather than silently changing their meaning.
    if (character === (windows ? "`" : "\\")) {
      const next = command[index + 1];
      if (next === undefined) return { ok: false, reason: "the command cannot end with an escape" };
      if (next === "\n" || next === "\r") return { ok: false, reason: "the command must be one physical line" };
      if (windows && !/[\s'"`$\\;&|<>()*?\[\]{}#@]/.test(next)) {
        return { ok: false, reason: "only literal PowerShell escapes are allowed" };
      }
      current += next;
      started = true;
      index += 1;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        if (windows && command[index + 1] === '"') { current += '"'; index += 1; }
        else quote = undefined;
        continue;
      }
      if ((!windows && character === "`") || (character === "$" && command[index + 1] === "(")) {
        return { ok: false, reason: "command substitution is not allowed" };
      }
      current += character;
      continue;
    }

    if (/\s/.test(character)) {
      pushCurrent();
      continue;
    }
    if (character === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (UNSAFE_UNQUOTED_CHARACTERS.has(character) || (windows && character === "@" && !started)) {
      const reason = "&|;<>()".includes(character)
        ? "shell operators are not allowed"
        : "unquoted shell expansion characters are not allowed";
      return { ok: false, reason };
    }
    current += character;
    started = true;
  }

  if (quote !== undefined) return { ok: false, reason: `unterminated ${quote} quote` };
  pushCurrent();
  return { ok: true, words };
}

