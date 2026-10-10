import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { Workspace } from "./workspace.ts";

interface AddAction {
  type: "add";
  path: string;
  lines: string[];
}

interface DeleteAction {
  type: "delete";
  path: string;
}

interface UpdateAction {
  type: "update";
  path: string;
  moveTo?: string;
  hunks: PatchHunk[];
}

interface PatchHunk {
  header: string;
  lines: string[];
  endOfFile: boolean;
}

type PatchAction = AddAction | DeleteAction | UpdateAction;

export interface ApplyPatchResult {
  files: string[];
  additions: number;
  deletions: number;
}

export async function applyWorkspacePatch(
  workspace: Workspace,
  input: string,
): Promise<ApplyPatchResult> {
  const actions = parsePatch(input);
  const staged = new Map<string, string | null>();
  let additions = 0;
  let deletions = 0;

  const readVirtual = async (absolute: string): Promise<string | null> => {
    if (staged.has(absolute)) return staged.get(absolute) ?? null;
    try {
      const bytes = await fs.readFile(absolute);
      const message = `Cannot patch ${workspace.relative(absolute)}: only UTF-8 text files are supported. Convert the file to UTF-8 first.`;
      let content: string;
      try {
        // Preserve the UTF-8 BOM for applyUpdate; reject invalid byte sequences.
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch (cause) {
        throw new Error(message, { cause });
      }
      // BOM-less UTF-16 can decode as UTF-8 containing embedded NULs.
      if (content.includes("\0")) throw new Error(message);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  for (const action of actions) {
    if (action.type === "add") {
      const absolute = await workspace.resolve(action.path, true);
      if ((await readVirtual(absolute)) !== null) {
        throw new Error(`Cannot add existing file: ${action.path}`);
      }
      const content = action.lines.length > 0 ? `${action.lines.join("\n")}\n` : "";
      staged.set(absolute, content);
      additions += action.lines.length;
      continue;
    }

    const absolute = await workspace.resolve(action.path);
    const original = await readVirtual(absolute);
    if (original === null) {
      throw new Error(`File not found: ${action.path}`);
    }

    if (action.type === "delete") {
      staged.set(absolute, null);
      deletions += splitFile(original).lines.length;
      continue;
    }

    const updated = applyUpdate(original, action);
    for (const hunk of action.hunks) {
      additions += hunk.lines.filter((line) => line.startsWith("+")).length;
      deletions += hunk.lines.filter((line) => line.startsWith("-")).length;
    }

    if (action.moveTo) {
      const destination = await workspace.resolve(action.moveTo, true);
      if (destination !== absolute && (await readVirtual(destination)) !== null) {
        throw new Error(`Move destination already exists: ${action.moveTo}`);
      }
      staged.set(absolute, null);
      staged.set(destination, updated);
    } else {
      staged.set(absolute, updated);
    }
  }

  // All paths and hunks are validated before any workspace mutation happens.
  for (const [absolute, content] of staged) {
    if (content === null) {
      await fs.rm(absolute, { force: true });
    } else {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await writeFileAtomic(absolute, content);
    }
  }

  return {
    files: [...staged.keys()].map((file) => workspace.relative(file)),
    additions,
    deletions,
  };
}

export function parsePatch(input: string): PatchAction[] {
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("Patch must start with *** Begin Patch");
  }

  const actions: PatchAction[] = [];
  let index = 1;

  while (index < lines.length) {
    const line = lines[index]!;
    if (line === "*** End Patch") {
      if (actions.length === 0) throw new Error("Patch contains no file actions");
      return actions;
    }

    if (line.startsWith("*** Add File: ")) {
      const file = requireRelativePatchPath(line.slice("*** Add File: ".length));
      index += 1;
      const added: string[] = [];
      while (index < lines.length && !isActionHeader(lines[index]!)) {
        const addition = lines[index]!;
        if (!addition.startsWith("+")) {
          throw new Error(`Add file lines must start with +: ${addition}`);
        }
        added.push(addition.slice(1));
        index += 1;
      }
      actions.push({ type: "add", path: file, lines: added });
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      const file = requireRelativePatchPath(line.slice("*** Delete File: ".length));
      actions.push({ type: "delete", path: file });
      index += 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      const file = requireRelativePatchPath(line.slice("*** Update File: ".length));
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = requireRelativePatchPath(lines[index]!.slice("*** Move to: ".length));
        index += 1;
      }

      const hunks: PatchHunk[] = [];
      while (index < lines.length && !isActionHeader(lines[index]!)) {
        const headerLine = lines[index]!;
        if (!headerLine.startsWith("@@")) {
          throw new Error(`Expected hunk header in ${file}, got: ${headerLine}`);
        }
        const header = headerLine.replace(/^@@\s?/, "").replace(/\s?@@$/, "");
        index += 1;
        const hunkLines: string[] = [];
        let endOfFile = false;
        while (
          index < lines.length &&
          !lines[index]!.startsWith("@@") &&
          !isActionHeader(lines[index]!)
        ) {
          const hunkLine = lines[index]!;
          if (hunkLine === "*** End of File") {
            endOfFile = true;
            index += 1;
            break;
          }
          if (
            !hunkLine.startsWith(" ") &&
            !hunkLine.startsWith("+") &&
            !hunkLine.startsWith("-")
          ) {
            throw new Error(`Invalid hunk line in ${file}: ${hunkLine}`);
          }
          hunkLines.push(hunkLine);
          index += 1;
        }
        if (hunkLines.length === 0) {
          throw new Error(`Empty hunk in ${file}`);
        }
        hunks.push({ header, lines: hunkLines, endOfFile });
      }
      if (hunks.length === 0 && !moveTo) {
        throw new Error(`Update for ${file} contains no hunks`);
      }
      actions.push({
        type: "update",
        path: file,
        ...(moveTo ? { moveTo } : {}),
        hunks,
      });
      continue;
    }

    throw new Error(`Unknown patch directive: ${line}`);
  }

  throw new Error("Patch is missing *** End Patch");
}

function applyUpdate(content: string, action: UpdateAction): string {
  if (action.hunks.length === 0) return content;

  // Keep the leading UTF-8 BOM out of hunk matching and restore it after editing.
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const file = splitFile(content.slice(bom.length));
  const output = [...file.lines];
  let cursor = 0;

  for (const hunk of action.hunks) {
    const oldLines = hunk.lines
      .filter((line) => !line.startsWith("+"))
      .map((line) => line.slice(1));

    let matchIndex: number;
    if (oldLines.length === 0) {
      matchIndex = hunk.endOfFile ? output.length : findHeaderPosition(output, hunk.header, cursor);
    } else {
      matchIndex = findSequence(output, oldLines, cursor, hunk.header, hunk.endOfFile);
    }

    const newLines: string[] = [];
    let originalIndex = matchIndex;
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        newLines.push(line.slice(1));
      } else {
        // Context is unchanged, even when matching ignored trailing whitespace.
        if (line.startsWith(" ")) newLines.push(output[originalIndex]!);
        originalIndex += 1;
      }
    }

    output.splice(matchIndex, oldLines.length, ...newLines);
    cursor = matchIndex + newLines.length;
  }

  const trailingNewline = file.trailingNewline;
  return bom + output.join(file.lineEnding) + (trailingNewline && output.length > 0 ? file.lineEnding : "");
}

function findSequence(
  haystack: string[],
  needle: string[],
  cursor: number,
  header: string,
  endOfFile: boolean,
): number {
  const hinted = parseLineHint(header);
  // EOF is a strict position constraint; a line hint must not override it.
  const starts = endOfFile
    ? [Math.max(cursor, haystack.length - needle.length)]
    : hinted === undefined ? [cursor] : [Math.max(cursor, hinted), cursor];

  for (const start of starts) {
    for (const mode of ["exact", "trimEnd"] as const) {
      for (let index = start; index <= haystack.length - needle.length; index += 1) {
        if (
          needle.every((line, offset) => normalizeLine(haystack[index + offset]!, mode) === normalizeLine(line, mode))
        ) {
          return index;
        }
      }
    }
  }

  const preview = needle.slice(0, 3).join("\\n");
  throw new Error(`Patch context not found${endOfFile ? " at end of file" : ""}${header ? ` near ${header}` : ""}: ${preview}`);
}

function findHeaderPosition(lines: string[], header: string, cursor: number): number {
  if (!header) return cursor;
  const hint = parseLineHint(header);
  if (hint !== undefined) return Math.max(cursor, Math.min(lines.length, hint));
  const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line.includes(header));
  return index === -1 ? cursor : index + 1;
}

function parseLineHint(header: string): number | undefined {
  const match = /^-(\d+)/.exec(header);
  return match ? Math.max(0, Number(match[1]) - 1) : undefined;
}

function normalizeLine(value: string, mode: "exact" | "trimEnd"): string {
  if (mode === "trimEnd") return value.trimEnd();
  return value;
}

function splitFile(content: string): {
  lines: string[];
  trailingNewline: boolean;
  lineEnding: "\r\n" | "\n";
} {
  // Use the first newline's convention, defaulting to LF when none exists.
  const firstNewline = content.indexOf("\n");
  const lineEnding = firstNewline > 0 && content[firstNewline - 1] === "\r" ? "\r\n" : "\n";
  const normalized = content.replaceAll("\r\n", "\n");
  const trailingNewline = normalized.endsWith("\n");
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  return { lines: normalized ? body.split("\n") : [], trailingNewline, lineEnding };
}

function isActionHeader(line: string): boolean {
  return (
    line === "*** End Patch" ||
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Update File: ")
  );
}

function requireRelativePatchPath(value: string): string {
  const file = value.trim();
  const normalized = path.normalize(file);
  if (
    !file ||
    path.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Patch path must be workspace-relative: ${value}`);
  }
  return file;
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.dscode-${process.pid}-${Date.now()}.tmp`,
  );
  let mode: number | undefined;
  try {
    mode = (await fs.stat(target)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

