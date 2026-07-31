import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOCAL_EXIT_INPUTS = new Set(["quit", "exit", "退出"]);

export function registerNaturalExit(pi: ExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    if (
      event.source !== "interactive" ||
      (event.images?.length ?? 0) > 0 ||
      !isNaturalExitInput(event.text)
    ) {
      return { action: "continue" };
    }
    if (!ctx.isIdle()) ctx.abort();
    ctx.shutdown();
    return { action: "handled" };
  });
}

export function isNaturalExitInput(text: string): boolean {
  return LOCAL_EXIT_INPUTS.has(text.trim().toLocaleLowerCase("en-US"));
}
