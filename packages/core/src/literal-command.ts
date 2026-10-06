export type LiteralCommandClassification =
  | { kind: "other" }
  | { kind: "invalid"; reason: string }
  | { kind: "trusted"; command: { args: string[] } };

function startsWithExecutable(command: string, executable: string): boolean {
  const text = command.trimStart();
  return text.startsWith(executable) && (text.length === executable.length || /[\s;&|<>]/.test(text[executable.length]!));
}

/** Credentials are only forwarded to direct, literal invocations; never to a shell. */
export function classifyLiteralCommand(command: string, executable: string): LiteralCommandClassification {
  if (!startsWithExecutable(command, executable)) {
    return containsChainedCommand(command, executable)
      ? { kind: "invalid", reason: `${executable} must be invoked directly without cd or command chaining` }
      : { kind: "other" };
  }
  const parsed = parseLiteralCommandWords(command);
  if (!parsed.ok) return { kind: "invalid", reason: parsed.reason };
  if (parsed.words[0] !== executable) return { kind: "invalid", reason: `the executable must be exactly ${executable}` };
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

function containsChainedCommand(command: string, executable: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      if (character === "\\" && quote === '"') index += 1;
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
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (!";&|()\n\r".includes(character)) continue;

    let commandStart = index + 1;
    while (/\s|[;&|()]/.test(command[commandStart] ?? "")) commandStart += 1;
    if (startsWithExecutable(command.slice(commandStart), executable)) return true;
  }
  return false;
}

function parseLiteralCommandWords(
  command: string,
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
      if (character === "'") quote = undefined;
      else current += character;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "`" || (character === "$" && command[index + 1] === "(")) {
        return { ok: false, reason: "command substitution is not allowed" };
      }
      if (character === "\\") {
        const next = command[index + 1];
        if (next === undefined) {
          return { ok: false, reason: "the command cannot end with an escape" };
        }
        if (next === "\n" || next === "\r") {
          return { ok: false, reason: "the command must be one physical line" };
        }
        current += next;
        index += 1;
        continue;
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
    if (character === "\\") {
      const next = command[index + 1];
      if (next === undefined) {
        return { ok: false, reason: "the command cannot end with an escape" };
      }
      if (next === "\n" || next === "\r") {
        return { ok: false, reason: "the command must be one physical line" };
      }
      current += next;
      started = true;
      index += 1;
      continue;
    }
    if (UNSAFE_UNQUOTED_CHARACTERS.has(character)) {
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

