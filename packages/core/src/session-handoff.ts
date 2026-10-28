import { existsSync } from "node:fs";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { DSCodeRuntimeOptions } from "./runtime-options.ts";

/** A saved branch, or null for a persistent session which has not been flushed yet. */
export interface SessionPosition {
  sessionId: string;
  sessionFile: string;
  leafId: string | null;
}

export interface DSCodeSessionRuntime {
  readonly sessionDir: string;
  assertIdle(): void;
  getPosition(): SessionPosition | null;
  getOptions(): DSCodeRuntimeOptions;
  restoreOptions(options: DSCodeRuntimeOptions): Promise<void>;
}

export function getSessionPosition(manager: ExtensionContext["sessionManager"]): SessionPosition | null {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error("Web continuation requires a persistent session. Restart without --no-session.");
  if (!existsSync(sessionFile)) {
    if (manager.getEntries().some(entry => entry.type === "message" && ["user", "assistant"].includes(entry.message.role))) {
      throw new Error("Saved session is missing. Use /resume to recover saved work.");
    }
    return null;
  }
  return {
    sessionId: manager.getSessionId(),
    sessionFile,
    leafId: manager.getLeafId(),
  };
}

/** Use public SessionManager APIs before the receiving runtime builds its context. */
export function loadSessionPosition(manager: SessionManager, position: SessionPosition): void {
  if (!existsSync(position.sessionFile)) throw new Error("Saved session is missing. Use /resume to recover saved work.");
  manager.setSessionFile(position.sessionFile);
  if (manager.getSessionId() !== position.sessionId) throw new Error("Saved session identity has changed.");
  if (position.leafId === null) manager.resetLeaf();
  else manager.branch(position.leafId);
}
