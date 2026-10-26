/** Embedded session hosts do not need CLI entrypoints or the separate vision CLI. */
export { createDSCodeExtension } from "./dscode-extension.ts";
export { createDSCodePiBuiltins } from "./pi-builtins.ts";
export { getDSCodeSessionsDir, initializeDSCodeHome } from "./home.ts";
export { parseRuntimeArgs, type DSCodeRuntimeOptions } from "./runtime-options.ts";
export { getSessionPosition, loadSessionPosition, type DSCodeSessionRuntime, type SessionPosition } from "./session-handoff.ts";
export { webOrigin, type StartWebContinuationOptions, type WebContinuationService } from "./web-continuation.ts";
