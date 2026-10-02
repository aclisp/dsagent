export {
  formatDSCodeError,
  runDSCode,
  runDSCodeProcess,
} from "./cli-runtime.ts";
export { createDSCodeExtension } from "./dscode-extension.ts";
export {
  createDSCodeRpcClient,
  getDSCodeRpcEntryPath,
  RpcClient,
  type DSCodeRpcClientOptions,
  type RpcClientOptions,
} from "./rpc-client.ts";
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
} from "./auth.ts";
export type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
export {
  createDSCodeCredentialStore,
  FileCredentialStore,
  installDSCodeCredentialStore,
  KeyringCredentialStore,
  type CreateCredentialStoreOptions,
  type DSCodeKeyringFactory,
} from "./credential-store.ts";
export {
  getDSCodeArchivedSessionsDir,
  getDSCodeHome,
  getDSCodeSessionsDir,
  initializeDSCodeHome,
  migrateLegacyDSCodeHome,
  partitionExistingSessions,
  partitionSessionFile,
  type PartitionedSessionPath,
} from "./home.ts";
export {
  DEFAULT_DEEPSEEK_BASE_URL,
  getDSCodeStorageSettings,
  getDSCodeSettingsPath,
  getStoredDeepSeekBaseUrl,
  normalizeDeepSeekBaseUrl,
  saveDeepSeekBaseUrl,
  type CredentialStoreMode,
  type DSCodeStorageSettings,
  type HistoryPersistence,
} from "./settings.ts";
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
} from "./providers.ts";
export {
  parseRuntimeArgs,
  printDSCodeHelp,
  promptContractSchema,
  sandboxModeSchema,
  type DSCodeRuntimeOptions,
  type ParsedRuntimeArgs,
  type PromptContractMode,
  type SandboxMode,
} from "./runtime-options.ts";
export {
  loadVisionRuntimeConfig,
  parseVisionCliArgs,
  runVisionCli,
  runVisionCliProcess,
  visionCliHelp,
  type ParsedVisionCliArgs,
  type VisionCliInvocation,
  type VisionRuntimeConfig,
} from "./vision-cli.ts";
export { DSCODE_VERSION } from "./version.ts";
export { createDSCodePiBuiltins } from "./pi-builtins.ts";
