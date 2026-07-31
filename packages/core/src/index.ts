export {
  formatDSCodeError,
  runDSCode,
  runDSCodeProcess,
} from "./cli-runtime.js";
export { createDSCodeExtension } from "./dscode-extension.js";
export {
  createDSCodeRpcClient,
  getDSCodeRpcEntryPath,
  RpcClient,
  type DSCodeRpcClientOptions,
  type RpcClientOptions,
} from "./rpc-client.js";
export {
  authenticateProvider,
  getDSCodeAgentDir,
  getDSCodeAuthPath,
  hasDeepSeekEnvironmentKey,
  hasStoredDeepSeekKey,
  hasStoredProviderCredential,
  removeStoredDeepSeekKey,
  removeStoredProviderCredential,
  runAuthCommand,
  saveDeepSeekKey,
  saveProviderApiKey,
  validateDeepSeekKey,
  type ApiKeyProviderId,
  type KeyValidation,
  type ProviderLoginResult,
} from "./auth.js";
export type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
export {
  getDSCodeHome,
  getDSCodeSessionsDir,
  initializeDSCodeHome,
  migrateLegacyDSCodeHome,
} from "./home.js";
export {
  DEFAULT_DEEPSEEK_BASE_URL,
  getDSCodeSettingsPath,
  getStoredDeepSeekBaseUrl,
  normalizeDeepSeekBaseUrl,
  saveDeepSeekBaseUrl,
} from "./settings.js";
export {
  MODEL_CREDENTIAL_ENV_KEYS,
  SUPPORTED_PROVIDER_IDS,
  defaultEffortForProvider,
  defaultModelForProvider,
  getStoredModelSelection,
  isSupportedProviderId,
  parseSupportedProviderId,
  providerDisplayName,
  providerEnvironmentKey,
  stripModelCredentialEnvironment,
  type StoredModelSelection,
  type SupportedProviderId,
} from "./providers.js";
export {
  parseRuntimeArgs,
  printDSCodeHelp,
  sandboxModeSchema,
  type DSCodeRuntimeOptions,
  type ParsedRuntimeArgs,
  type SandboxMode,
} from "./runtime-options.js";
export { DSCODE_VERSION } from "./version.js";
