import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isStandalone } from "./distribution.ts";
import { BoundedOutput } from "./process.ts";
import type { DSCodeRuntimeOptions } from "./runtime-options.ts";
import { renderCollapsibleToolResult, renderToolCall } from "./tool-ui.ts";

export const SUBAGENT_TOOLS = ["read", "grep", "find", "ls"] as const;
const timeoutMs = 120_000;

export function isSubagent(): boolean {
  return Number(process.env.DSCODE_SUBAGENT_DEPTH ?? "0") >= 1;
}

interface SubagentResult {
  success: boolean;
  output: string;
}

export function registerSubagentTools(pi: ExtensionAPI, runtime: DSCodeRuntimeOptions): void {
  if (isSubagent()) return;

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Run one investigation-only child agent in the current workspace and return its findings. The child can read and search files; it cannot run commands, edit files, use MCP, or delegate.",
    promptSnippet: "Obtain independent file investigation from one child agent",
    promptGuidelines: [
      "Give the child a self-contained task and the context it needs; it does not receive this conversation.",
      "Use the parent agent for commands, edits, integration, and verification.",
    ],
    parameters: Type.Object({ task: Type.String({ minLength: 1 }) }),
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      let result: SubagentResult;
      try {
        if (!params.task.trim()) throw new Error("The investigation task cannot be blank.");
        const prefix = isStandalone ? [] : [process.argv[1] ?? ""];
        if (!isStandalone && !prefix[0]) throw new Error("Cannot locate the DSCode entrypoint");
        result = await runChild([
          ...prefix,
          "-C", ctx.cwd,
          "--provider", ctx.model?.provider ?? runtime.providerId,
          "--base-url", runtime.baseUrl,
          "--transport", runtime.transport,
          "--model", ctx.model?.id ?? runtime.modelId,
          "--prompt-contract", runtime.promptContract,
          "--thinking", pi.getThinkingLevel(),
          "--mode", "json",
          "--print", "--no-session", "--no-mcp", "--no-extensions",
          "--permission", "auto",
          "--sandbox", runtime.sandbox,
          "--tools", SUBAGENT_TOOLS.join(","),
          `Investigate files only. Return concise findings with exact file references and unresolved questions.\n\nTask:\n${params.task}`,
        ], ctx.cwd, signal);
      } catch (error) {
        result = { success: false, output: (error as Error).message };
      }
      return {
        content: [{ type: "text", text: result.output }],
        details: result,
        ...(result.success ? {} : { isError: true }),
      };
    },
    renderCall(args, theme, context) {
      return renderToolCall("Investigating", args.task, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderCollapsibleToolResult(result, options, theme, context, {
        collapsedSummary: result.isError ? "Investigation failed" : "Investigation completed",
        forceError: result.isError === true,
      });
    },
  });
}

function runChild(args: string[], cwd: string, signal?: AbortSignal): Promise<SubagentResult> {
  if (signal?.aborted) return Promise.resolve({ success: false, output: "Investigation cancelled." });
  return new Promise((resolve, reject) => {
    // Agent subprocesses need model credentials; shell-command runners strip them.
    const child = spawn(process.execPath, args, {
      cwd, env: { ...process.env, DSCODE_SUBAGENT_DEPTH: "1" },
      shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = new BoundedOutput(100_000);
    const lines = createInterface({ input: child.stdout });
    let finalOutput = "";
    let failed = false;
    let timedOut = false;
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const sendSignal = (kind: NodeJS.Signals): void => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try { process.kill(-child.pid, kind); return; } catch { /* Fall back to the direct child. */ }
      }
      child.kill(kind);
    };
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      sendSignal("SIGTERM");
      killTimer = setTimeout(() => sendSignal("SIGKILL"), 1_500);
      killTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event.type !== "message_end" || event.message?.role !== "assistant") return;
        const message = event.message;
        const text = message.content?.filter((item: { type: string }) => item.type === "text")
          .map((item: { text: string }) => item.text).join("\n") ?? "";
        failed = message.stopReason === "error" || message.stopReason === "aborted";
        const output = new BoundedOutput(100_000);
        output.append([text, ...(failed ? [message.errorMessage || `Request ${message.stopReason}`] : [])]
          .filter(Boolean).join("\n"));
        finalOutput = output.value();
      } catch { /* Ignore non-protocol startup output. */ }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk.toString("utf8")));
    const cleanup = (): void => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
      lines.close();
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (exitCode) => {
      cleanup();
      const reason = timedOut ? "Investigation timed out." : signal?.aborted ? "Investigation cancelled." : "";
      resolve({
        success: exitCode === 0 && !failed && !reason && Boolean(finalOutput.trim()),
        output: [finalOutput || stderr.value() || "Child agent returned no findings.", reason].filter(Boolean).join("\n"),
      });
    });
  });
}
