import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerSessionCommands } from "../src/session-commands.js";

describe("DSCode session commands", () => {
  it("registers /clear as a new-session alias", async () => {
    let command:
      | {
          description?: string;
          handler(args: string, ctx: any): Promise<void>;
        }
      | undefined;
    const pi = {
      registerCommand(name: string, definition: typeof command) {
        if (name === "clear") command = definition;
      },
    } as unknown as ExtensionAPI;
    registerSessionCommands(pi);

    const newSession = vi.fn(async () => ({ cancelled: false }));
    const notify = vi.fn();
    await command!.handler("", { newSession, ui: { notify } });

    expect(command?.description).toContain("alias for /new");
    expect(newSession).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith("New session started. Context cleared.", "info");
  });

  it("does not report success when session replacement is cancelled", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const pi = {
      registerCommand(name: string, definition: { handler: typeof handler }) {
        if (name === "clear") handler = definition.handler;
      },
    } as unknown as ExtensionAPI;
    registerSessionCommands(pi);

    const notify = vi.fn();
    await handler!("", {
      newSession: async () => ({ cancelled: true }),
      ui: { notify },
    });

    expect(notify).not.toHaveBeenCalled();
  });
});
