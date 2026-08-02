import path from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type AgentSessionRuntimeDiagnostic,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionRuntimeFactory,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import {
  createDSCodeExtension,
  initializeDSCodeHome,
  parseRuntimeArgs,
} from "@thinkany/dscode-core";
import {
  createHttpUiBroker,
  type HttpUiBroker,
  type HttpUiBrokerListener,
} from "./ui-broker.js";

export interface CreateAgentSessionHostOptions {
  cwd: string;
  runtimeArgs?: readonly string[];
  uiBroker?: HttpUiBroker;
}

export interface AgentSessionHost {
  readonly session: AgentSession;
  readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
  readonly uiBroker: HttpUiBroker;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(listener: HttpUiBrokerListener): () => void;
  dispose(): Promise<void>;
}

export async function createAgentSessionHost(
  options: CreateAgentSessionHostOptions,
): Promise<AgentSessionHost> {
  const cwd = path.resolve(options.cwd);
  validateRuntimeArgs(options.runtimeArgs ?? []);
  const parsed = parseRuntimeArgs(["-C", cwd, ...(options.runtimeArgs ?? [])]);
  if (parsed.help || parsed.version) {
    throw new Error("Help and version flags are not supported by the direct session host");
  }
  const thinkingLevel = getThinkingLevel(parsed.piArgs);

  const agentDir = await initializeDSCodeHome();
  ensureThemeInitialized();
  const uiBroker = options.uiBroker ?? createHttpUiBroker();
  const sessionManager = SessionManager.inMemory(cwd);

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: runtimeCwd,
    agentDir: runtimeAgentDir,
    sessionManager: runtimeSessionManager,
    sessionStartEvent,
  }) => {
    const runtimeOptions = { ...parsed.options, cwd: runtimeCwd };
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      resourceLoaderOptions: {
        extensionFactories: [createDSCodeExtension(runtimeOptions)],
      },
    });
    const model = services.modelRuntime.getModel(
      runtimeOptions.providerId,
      runtimeOptions.modelId,
    );
    if (!model) {
      throw new Error(
        `Model not found: ${runtimeOptions.providerId}/${runtimeOptions.modelId}`,
      );
    }

    const result = await createAgentSessionFromServices({
      services,
      sessionManager: runtimeSessionManager,
      ...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
      model,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      tools: runtimeOptions.activeTools,
    });

    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };

  let runtime: AgentSessionRuntime | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager,
    });
    const session = runtime.session;
    uiBroker.attachBaseContext(session.extensionRunner.getUIContext());
    unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      uiBroker.publishSessionEvent(event);
    });
    await session.bindExtensions({
      mode: "rpc",
      uiContext: uiBroker.uiContext,
      onError(error) {
        uiBroker.publishExtensionError(error);
      },
    });
    return createHost(runtime, uiBroker, unsubscribe);
  } catch (error) {
    unsubscribe?.();
    uiBroker.dispose();
    await runtime?.dispose();
    throw error;
  }
}

function createHost(
  runtime: AgentSessionRuntime,
  uiBroker: HttpUiBroker,
  unsubscribe: () => void,
): AgentSessionHost {
  let disposePromise: Promise<void> | undefined;

  const assertActive = (): void => {
    if (disposePromise) throw new Error("Agent session host is disposed");
  };

  return {
    get session() {
      return runtime.session;
    },
    get diagnostics() {
      return runtime.diagnostics;
    },
    uiBroker,
    async prompt(message) {
      assertActive();
      assertPromptSupported(message);
      await runtime.session.prompt(message, { source: "rpc" });
    },
    async abort() {
      assertActive();
      await runtime.session.abort();
    },
    async waitForIdle() {
      assertActive();
      await runtime.session.waitForIdle();
    },
    subscribe(listener) {
      assertActive();
      return uiBroker.subscribe(listener);
    },
    dispose() {
      disposePromise ??= (async () => {
        uiBroker.dispose();
        unsubscribe();
        await runtime.dispose();
      })();
      return disposePromise;
    },
  };
}

const UNSUPPORTED_SESSION_COMMANDS = new Set([
  "clear",
  "new",
  "resume",
  "fork",
  "clone",
  "import",
  "tree",
]);

function assertPromptSupported(message: string): void {
  const match = /^\/([^\s]+)/.exec(message.trimStart());
  const command = match?.[1]?.toLowerCase();
  if (command && UNSUPPORTED_SESSION_COMMANDS.has(command)) {
    throw new Error(`Session command /${command} is not supported by this host`);
  }
}

let themeInitialized = false;

function ensureThemeInitialized(): void {
  if (themeInitialized) return;
  initTheme(undefined, false);
  themeInitialized = true;
}

type ThinkingLevel = NonNullable<
  CreateAgentSessionFromServicesOptions["thinkingLevel"]
>;

const VALUE_RUNTIME_FLAGS = new Set([
  "--provider",
  "--base-url",
  "--transport",
  "--harness",
  "--permission",
  "--sandbox",
  "--effort",
  "--model",
  "--tools",
]);
const BOOLEAN_RUNTIME_FLAGS = new Set([
  "--network",
  "--web",
  "--no-tools",
  "--no-resume",
]);
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function validateRuntimeArgs(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const hasInlineValue = equals !== -1;

    if (BOOLEAN_RUNTIME_FLAGS.has(flag)) {
      if (hasInlineValue) throw new Error(`${flag} does not accept a value`);
      continue;
    }
    if (VALUE_RUNTIME_FLAGS.has(flag)) {
      if (!hasInlineValue) {
        if (args[index + 1] === undefined) throw new Error(`${flag} requires a value`);
        index += 1;
      }
      continue;
    }
    throw new Error(`Unsupported direct session argument: ${argument}`);
  }
}

function getThinkingLevel(args: readonly string[]): ThinkingLevel | undefined {
  const index = args.indexOf("--thinking");
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined) return undefined;
  if (!THINKING_LEVELS.includes(value as ThinkingLevel)) {
    throw new Error(`Unsupported thinking level: ${value}`);
  }
  return value as ThinkingLevel;
}
