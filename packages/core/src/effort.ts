import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultEffortForProvider, isSupportedProviderId } from "./providers.ts";
import type { DSCodeRuntimeOptions } from "./runtime-options.ts";

/** Let Pi resolve explicit overrides, restored sessions, and settings before product defaults. */
export function registerEffortDefaults(pi: ExtensionAPI, options: DSCodeRuntimeOptions): void {
  pi.on("session_start", (event, ctx) => {
    if (event.reason === "reload" || options.effort !== undefined || !ctx.model) return;
    if (ctx.sessionManager.buildSessionProjection().messages.length > 0) return;

    const settings = pi.getSettings();
    if (settings.modelThinkingLevels?.[`${ctx.model.provider}/${ctx.model.id}`] !== undefined ||
      settings.defaultThinkingLevel !== undefined) return;
    if (isSupportedProviderId(ctx.model.provider)) {
      pi.setThinkingLevel(defaultEffortForProvider(ctx.model.provider) as ThinkingLevel);
    }
  });
}
