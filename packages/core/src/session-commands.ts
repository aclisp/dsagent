import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerSessionCommands(pi: ExtensionAPI): void {
  pi.registerCommand("clear", {
    description: "Clear context and start a new session (alias for /new)",
    handler: async (_args, ctx) => {
      // Replacing a session invalidates this command context immediately. Do not access
      // ctx (including ctx.ui) after the awaited call.
      await ctx.newSession();
    },
  });
}
