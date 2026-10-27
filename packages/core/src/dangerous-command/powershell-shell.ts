export interface PowerShellWord {
  value: string;
  raw: string;
  literal: boolean;
}

export interface PowerShellCommand {
  words: PowerShellWord[];
  invoked: boolean;
  complete: boolean;
  redirects: { append: boolean; target: PowerShellWord }[];
}

const controlBlocks = new Set(["if", "elseif", "else", "foreach", "for", "while", "do", "until", "switch", "try", "catch", "finally", "trap"]);
const declarations = new Set(["function", "filter", "class", "enum", "data", "param"]);
const blockCommands = new Set(["foreach-object", "%", "where-object", "?", "where", "foreach", "invoke-command", "icm", "start-job", "sajb", "start-threadjob", "measure-command", "trace-command", "pwsh", "powershell"]);
const escapes: Readonly<Record<string, string>> = { "0": "\0", a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
const quoteKind = (char: string | undefined) => char && "'‘’".includes(char) ? 1 : char && '"“”'.includes(char) ? 2 : 0;

export function powerShellName(value: string): string {
  return value.replace(/^.*[\\/]/, "").replace(/\.(?:exe|com)$/i, "").toLowerCase();
}

/** Bounded literal syntax only. No shell is launched and no variables, custom
 * aliases, function bodies, or external scripts are evaluated. */
export function powerShellCommands(source: string): PowerShellCommand[] {
  const commands: PowerShellCommand[] = [];

  function scan(start: number, closing = "", inspect = true, depth = 0): { end: number; complete: boolean } {
    if (depth > 16) return { end: source.length, complete: false };
    let words: PowerShellWord[] = [], redirects: PowerShellCommand["redirects"] = [];
    let invoked = false, complete = true;
    let wordStart = -1, value = "", literal = true;
    let redirect: { append: boolean } | undefined;
    const begin = (index: number) => { if (wordStart < 0) wordStart = index; };
    const flushWord = (end: number) => {
      if (wordStart < 0) return;
      const word = { value, raw: source.slice(wordStart, end), literal };
      if (redirect) { redirects.push({ ...redirect, target: word }); redirect = undefined; }
      else words.push(word);
      wordStart = -1; value = ""; literal = true;
    };
    const emit = (end: number) => {
      flushWord(end);
      if (words[0]?.raw === ".") { words.shift(); invoked = true; }
      if (["return", "throw"].includes(words[0]?.raw.toLowerCase() ?? "")) words.shift();
      if (inspect && (words.length || redirects.length)) commands.push({ words, redirects, invoked, complete });
      words = []; redirects = []; invoked = false; complete = true; redirect = undefined;
    };
    const contextName = () => powerShellName(words[words[0]?.raw === "." ? 1 : 0]?.value ?? "");
    const escape = (index: number): { end: number; value: string } => {
      const next = source[index + 1];
      if (next === "\r" && source[index + 2] === "\n") return { end: index + 3, value: "" };
      if (next === "\n") return { end: index + 2, value: "" };
      if (next === "u") {
        const unicode = /^u\{([\da-f]{1,6})\}/i.exec(source.slice(index + 1));
        const code = unicode && parseInt(unicode[1]!, 16);
        if (unicode && code !== null && code <= 0x10ffff) return { end: index + 1 + unicode[0].length, value: String.fromCodePoint(code) };
      }
      return { end: Math.min(index + 2, source.length), value: next === undefined ? "" : escapes[next] ?? next };
    };
    const quoted = (start: number, here: boolean): { end: number; value: string; literal: boolean; complete: boolean } => {
      const kind = quoteKind(source[start + (here ? 1 : 0)]);
      let result = "", constant = true;
      let index = start + (here ? 2 : 1);
      for (; index < source.length;) {
        const char = source[index]!;
        const atEnd = here ? source[index - 1] === "\n" && quoteKind(char) === kind && source[index + 1] === "@" : quoteKind(char) === kind;
        if (atEnd) {
          if (!here && quoteKind(source[index + 1]) === kind) { result += char; index += 2; continue; }
          return { end: index + (here ? 2 : 1), value: result, literal: constant, complete: true };
        }
        if (kind === 2 && char === "`") {
          const escaped = escape(index); result += escaped.value; index = escaped.end; continue;
        }
        if (kind === 2 && char === "$" && source[index + 1] === "(") {
          const nested = scan(index + 2, ")", inspect, depth + 1);
          result += source.slice(index, nested.end); constant = false; index = nested.end; continue;
        }
        if (kind === 2 && char === "$") constant = false;
        result += char; index++;
      }
      return { end: index, value: result, literal: constant, complete: false };
    };

    for (let index = start; index < source.length;) {
      const char = source[index]!;
      if (char === closing) { const valid = complete; emit(index); return { end: index + 1, complete: valid }; }
      if (char === "<" && source[index + 1] === "#") {
        let nesting = 1; index += 2;
        while (index < source.length && nesting) {
          if (source.startsWith("<#", index)) { nesting++; index += 2; }
          else if (source.startsWith("#>", index)) { nesting--; index += 2; }
          else index++;
        }
        if (nesting) complete = false;
        continue;
      }
      if (char === "#" && wordStart < 0) {
        while (index < source.length && !"\r\n".includes(source[index]!)) index++;
        continue;
      }
      if (char === "`" && /[\r\n]/.test(source[index + 1] ?? "")) { index = escape(index).end; continue; }
      if (char === "`") {
        begin(index); const escaped = escape(index); value += escaped.value;
        if (index + 1 === source.length) complete = false;
        index = escaped.end; continue;
      }
      const here = char === "@" && quoteKind(source[index + 1]) && /[\r\n]/.test(source[index + 2] ?? "");
      if (quoteKind(char) || here) {
        begin(index); const part = quoted(index, !!here); value += part.value;
        literal &&= part.literal; complete &&= part.complete; index = part.end; continue;
      }
      if (wordStart < 0 && source.startsWith("--%", index) && /\s|$/.test(source[index + 3] ?? "")) {
        const end = source.indexOf("\n", index);
        words.push({ value: source.slice(index, end < 0 ? source.length : end), raw: source.slice(index, end < 0 ? source.length : end), literal: false });
        index = end < 0 ? source.length : end; continue;
      }
      if (char === "$" && source[index + 1] === "(") {
        begin(index); const nested = scan(index + 2, ")", inspect, depth + 1);
        value += source.slice(index, nested.end); literal = false; complete &&= nested.complete; index = nested.end; continue;
      }
      if (char === "(" || char === "{") {
        flushWord(index);
        const name = contextName();
        const declaration = declarations.has(name);
        const body = char === "(" || invoked || words[0]?.raw === "." || controlBlocks.has(name) || blockCommands.has(name);
        const nested = scan(index + 1, char === "(" ? ")" : "}", inspect && !declaration && body, depth + 1);
        complete &&= nested.complete;
        words.push({ value: source.slice(index, nested.end), raw: source.slice(index, nested.end), literal: false });
        if (char === "{" && (declaration || controlBlocks.has(name))) emit(nested.end);
        index = nested.end; continue;
      }
      if (char === "=" && ((words.length === 0 && /^\$[\w:]+$/.test(value)) ||
        (wordStart < 0 && words.length === 1 && /^\$[\w:]+$/.test(words[0]!.value)))) {
        words = []; wordStart = -1; value = ""; literal = true; index++; continue;
      }
      if (char === ">") {
        if (/^(?:\d+|\*)$/.test(value)) { wordStart = -1; value = ""; literal = true; }
        else flushWord(index);
        const append = source[index + 1] === ">"; index += append ? 2 : 1;
        if (source[index] === "&") { index++; while (/\d/.test(source[index] ?? "")) index++; }
        else redirect = { append };
        continue;
      }
      if (";|&\r\n".includes(char)) {
        const prefix = words.length === 1 && ["return", "throw"].includes(words[0]!.raw.toLowerCase());
        const call = char === "&" && source[index + 1] !== "&" && (words.length === 0 || prefix) && wordStart < 0;
        if (call) { if (prefix) words = []; invoked = true; }
        else emit(index);
        index += (char === "&" || char === "|") && source[index + 1] === char ? 2 : 1;
        continue;
      }
      if (/\s/.test(char)) { flushWord(index); index++; continue; }
      if (char === ")" || char === "}") { emit(index); index++; continue; }
      begin(index); value += char;
      if (char === "$" || (char === "@" && value === "@")) literal = false;
      index++;
    }
    if (closing) complete = false;
    const valid = !closing && complete;
    emit(source.length);
    return { end: source.length, complete: valid };
  }
  scan(0);
  return commands;
}
