/** Build-time constants. Ordinary Node builds retain their existing behavior. */
declare const DSCODE_STANDALONE: boolean;
declare const DSCODE_BUILD_VERSION: string;

export const isStandalone = typeof DSCODE_STANDALONE !== "undefined" && DSCODE_STANDALONE;
export const embeddedVersion = typeof DSCODE_BUILD_VERSION === "undefined" ? undefined : DSCODE_BUILD_VERSION;
