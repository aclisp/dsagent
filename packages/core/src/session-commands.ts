import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerSessionCommands(pi: ExtensionAPI): void {
  pi.registerCommand("clear", {
    description: "Clear context and start a new session (alias for /new)",
    handler: async (_args, ctx) => {
      const result = await ctx.newSession();
      if (!result.cancelled) {
        ctx.ui.notify("New session started. Context cleared.", "info");
      }
    },
  });
}
