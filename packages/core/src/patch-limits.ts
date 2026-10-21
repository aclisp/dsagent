import { constants } from "node:fs";
import fs from "node:fs/promises";

export const PATCH_LIMITS = {
  inputBytes: 1024 * 1024,
  fileBytes: 10 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
};

export function checkPatchInput(input: string): void {
  const bytes = Buffer.byteLength(input, "utf8");
  if (bytes > PATCH_LIMITS.inputBytes) {
    throw new Error(`Patch input is ${bytes} bytes; limit is ${PATCH_LIMITS.inputBytes} bytes.`);
  }
}

function checkFileSize(file: string, bytes: number): void {
  if (bytes > PATCH_LIMITS.fileBytes) {
    throw new Error(`Cannot patch ${file}: ${bytes} bytes exceeds the per-file limit of ${PATCH_LIMITS.fileBytes} bytes.`);
  }
}

export class PatchBudget {
  private readonly originals = new Map<string, number>();
  private readonly pending = new Map<string, number>();
  private total: number;
  private originalTotal = 0;

  constructor(reservedBytes = 0) {
    this.total = reservedBytes;
  }

  get originalBytes(): number {
    return this.originalTotal;
  }

  maxReadBytes(absolute: string): number {
    return Math.min(PATCH_LIMITS.fileBytes, PATCH_LIMITS.totalBytes - this.total + (this.originals.get(absolute) ?? 0));
  }

  checkOriginal(absolute: string, file: string, bytes: number): void {
    checkFileSize(file, bytes);
    this.checkTotal(file, Math.max(0, bytes - (this.originals.get(absolute) ?? 0)));
  }

  recordOriginal(absolute: string, file: string, bytes: number): void {
    this.checkOriginal(absolute, file, bytes);
    const previous = this.originals.get(absolute) ?? 0;
    const retained = Math.max(previous, bytes);
    this.originals.set(absolute, retained);
    this.originalTotal += retained - previous;
    this.total += retained - previous;
  }

  stageWrite(file: string, content: string | null): void {
    const bytes = this.writeSize(file, content);
    const delta = bytes - (this.pending.get(file) ?? 0);
    this.checkTotal(file, delta);
    this.total += delta;
    this.pending.set(file, bytes);
  }

  flushPending(): void {
    // Flushed contents remain retained by the execution plan.
    this.pending.clear();
  }

  addWrite(file: string, content: string): void {
    const bytes = this.writeSize(file, content);
    this.checkTotal(file, bytes);
    this.total += bytes;
  }

  private writeSize(file: string, content: string | null): number {
    const bytes = content === null ? 0 : Buffer.byteLength(content, "utf8");
    checkFileSize(file, bytes);
    return bytes;
  }

  private checkTotal(file: string, delta: number): void {
    if (this.total + delta > PATCH_LIMITS.totalBytes) {
      throw new Error(`Patch content budget exceeded at ${file}: ${this.total + delta} bytes exceeds the limit of ${PATCH_LIMITS.totalBytes} bytes (original files and planned writes).`);
    }
  }
}

export async function readPatchFile(absolute: string, file: string, budget: PatchBudget, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    signal?.throwIfAborted();
    const stat = await handle.stat();
    signal?.throwIfAborted();
    if (!stat.isFile()) throw new Error(`Cannot patch ${file}: only regular files are supported.`);
    budget.checkOriginal(absolute, file, stat.size);
    const limit = budget.maxReadBytes(absolute);
    const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1));
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      signal?.throwIfAborted();
      // Read at most one extra byte to detect growth beyond the remaining budget.
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit - size + 1));
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      size += bytesRead;
      budget.checkOriginal(absolute, file, size);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    budget.recordOriginal(absolute, file, size);
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
}
