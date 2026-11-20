import { constants } from "node:fs";
import { access, open, readFile } from "node:fs/promises";
import { createReadToolDefinition, detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { renderCollapsibleToolResult, renderToolCall } from "./tool-ui.ts";

// Bun 1.3.14 leaks the descriptor when a FileHandle is closed after createReadStream().
async function* readFileChunks(path: string, { signal }: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
  signal?.throwIfAborted();
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    // Match pi: cap regular files at their initial size, but read size-zero pseudo-files to EOF.
    let remaining = stat.isFile() && stat.size > 0 ? stat.size : Infinity;
    const buffer = Buffer.alloc(Math.min(64 * 1024, remaining));
    while (remaining > 0) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      remaining -= bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

/** Keep pi's read semantics while using the same presentation as DSCode tools. */
export function createDSCodeReadTool(cwd: string): ReturnType<typeof createReadToolDefinition> {
  return {
    ...createReadToolDefinition(cwd, {
      operations: {
        access: (path) => access(path, constants.R_OK),
        readFile,
        detectImageMimeType: detectSupportedImageMimeTypeFromFile,
        createReadStream: readFileChunks,
      },
    }),
    renderShell: "self",
    renderCall(args, theme, context) {
      const start = args.offset ?? 1;
      const range = args.limit !== undefined
        ? `:${start}-${start + args.limit - 1}`
        : args.offset !== undefined ? `:${start}…` : "";
      return renderToolCall("Read", `${args.path ?? "file"}${range}`, theme, context, context.expanded);
    },
    renderResult(result, options, theme, context) {
      return renderCollapsibleToolResult(result, options, theme, context);
    },
  };
}
