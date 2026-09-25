interface Word {
  value: string;
  quoted: boolean;
}

interface SimpleCommand {
  words: string[];
  complete: boolean;
}

type Block =
  | { kind: "if"; phase: "condition" | "then" | "else" }
  | { kind: "loop"; phase: "header" | "condition" | "body" }
  | { kind: "group" }
  | { kind: "test" };

/** Recognize only reserved words in command position. For headers contain data,
 * not commands. Conditions and all branches are inspected without evaluating
 * whether they will run. undefined means unsupported syntax: stop scanning. */
function commandWords(words: Word[], blocks: Block[]): string[] | undefined {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    const keyword = word.quoted ? undefined : word.value;
    const block = blocks.at(-1);
    if (block?.kind === "test") {
      if (keyword === "]]") blocks.pop();
      index++;
      continue;
    }
    if (block?.kind === "loop" && block.phase === "header" && keyword !== "do") return [];
    if (keyword === "if") {
      blocks.push({ kind: "if", phase: "condition" });
    } else if (keyword === "then" && block?.kind === "if" && block.phase === "condition") {
      block.phase = "then";
    } else if (keyword === "elif" && block?.kind === "if" && block.phase === "then") {
      block.phase = "condition";
    } else if (keyword === "else" && block?.kind === "if" && block.phase === "then") {
      block.phase = "else";
    } else if (keyword === "fi" && block?.kind === "if" && block.phase !== "condition") {
      blocks.pop();
    } else if (keyword === "for") {
      blocks.push({ kind: "loop", phase: "header" });
      return []; // Variable name and the entire literal iteration list are data.
    } else if (keyword === "while" || keyword === "until") {
      blocks.push({ kind: "loop", phase: "condition" });
    } else if (keyword === "do" && block?.kind === "loop" && block.phase !== "body") {
      block.phase = "body";
    } else if (keyword === "done" && block?.kind === "loop" && block.phase === "body") {
      blocks.pop();
    } else if (keyword === "{") {
      blocks.push({ kind: "group" });
    } else if (keyword === "}" && block?.kind === "group") {
      blocks.pop();
    } else if (keyword === "[[") {
      blocks.push({ kind: "test" });
    } else if (keyword && ["case", "select", "function"].includes(keyword)) {
      return; // Do not reinterpret patterns or function declarations.
    } else {
      return words.slice(index).map((token) => token.value);
    }
    index++;
  }
  return [];
}

/** Split literal commands with a bounded amount of control-structure context.
 * Stop at unsupported executable syntax rather than guessing a recovery point
 * or mistaking its contents (especially heredoc data) for commands. */
export function simpleCommands(source: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  const blocks: Block[] = [];
  let words: Word[] = [];
  let word = "";
  let quoted = false;
  let started = false;
  let quote = "";
  let redirect = false;
  let unsupported = false;
  const emitCommand = (complete: boolean) => {
    const executable = commandWords(words, blocks);
    if (executable === undefined) unsupported = true;
    else if (executable.length) commands.push({ words: executable, complete });
  };
  const flushWord = () => {
    if (started) {
      if (!redirect) words.push({ value: word, quoted });
      redirect = false;
      word = "";
      quoted = false;
      started = false;
    }
  };
  const flushCommand = () => {
    flushWord();
    emitCommand(true);
    words = [];
    redirect = false;
  };
  const stop = () => {
    // Do not retain a partial word: r$(...) is not the literal command r.
    emitCommand(false);
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
        if (next !== "\n") { word += next; started = true; quoted = true; }
        continue;
      }
    }
    if (quote === '"') {
      if (char === '"') quote = "";
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; quoted = true; continue; }
    if (char === "#" && !started) {
      while (i < source.length && source[i] !== "\n") i++;
      flushCommand();
    } else if (";&|\n\r()".includes(char)) {
      const precedingWord = started ? word : words.at(-1)?.value;
      if (char === "(" && /^\([ \t]*\)/.test(source.slice(i)) &&
        /^[A-Za-z_][A-Za-z_0-9]*$/.test(precedingWord ?? "")) {
        // name() declares a function, rather than invoking name. Do not emit
        // this segment or inspect its body (even if the function is named rm).
        return commands;
      }
      // Arithmetic expressions and for ((...)) are outside this literal subset.
      if (char === "(" && source[i + 1] === "(") { flushWord(); return stop(); }
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
    if (unsupported) return commands;
  }
  if (!quote) flushCommand();
  return commands;
}
