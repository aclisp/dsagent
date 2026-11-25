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

const literalShellWord = String.raw`(?:[^\s'"\\$\x60#;&|<>()]+|'[^'\r\n]*'|"[^"\\$\x60\r\n]*")`;
const simpleShellArgs = String.raw`(?:[ \t]+${literalShellWord}|[ \t]*>>?[ \t]*${literalShellWord})*`;
const simpleShellLine = new RegExp(
  String.raw`^[ \t]*([\w./:-]+)${simpleShellArgs}(?:[ \t]*<<(-?)[ \t]*(?:'([\w-]+)'|"([\w-]+)")${simpleShellArgs})?[ \t]*$`,
);
const shellKeywords = new Set(["case", "coproc", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "select", "then", "time", "until", "while"]);

function heredocEnd(command: string, newline: number, delimiter: string, stripTabs: boolean): number | undefined {
  while (newline !== -1) {
    const start = newline + 1;
    newline = command.indexOf("\n", start);
    const end = newline === -1 ? command.length : newline;
    const line = command.slice(start, end);
    if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) return end;
  }
}

/** Locate literal bodies only while command boundaries are unambiguous.
 * Leave unsupported syntax to the existing scanner rather than guessing where code resumes. */
function quotedHeredocBodies(command: string): Map<number, number> | undefined {
  if (!command.includes("<<")) return;
  const bodies = new Map<number, number>();
  let start = 0;
  while (start < command.length) {
    const newline = command.indexOf("\n", start);
    if (newline === -1) break;
    const line = command.slice(start, newline);
    start = newline + 1;
    if (/^[ \t]*$/.test(line)) continue;
    const header = simpleShellLine.exec(line);
    if (!header || shellKeywords.has(header[1]!)) break;
    const delimiter = header[3] ?? header[4];
    if (!delimiter) continue;
    const end = heredocEnd(command, newline, delimiter, header[2] === "-");
    if (end === undefined) break;
    bodies.set(newline, end);
    start = end + 1;
  }
  return bodies;
}

function containsChainedCommand(command: string, executable: string, windows: boolean): boolean {
  let quote: "'" | '"' | undefined;
  const escape = windows ? "`" : "\\";
  const heredocs = windows ? undefined : quotedHeredocBodies(command);
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

    index = heredocs?.get(index) ?? index;
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

