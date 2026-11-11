import QRCode from "qrcode";
import { getDSCodeHome, webOrigin, type StartWebContinuationOptions, type WebContinuationService } from "@aclisp/dsagent-core/session-runtime";
import type { HttpSessionControl } from "@aclisp/dsagent-http-adapter";
import { DEFAULT_CHAT_AGENT_NAME } from "./chat-page.ts";
import { createWebUiServer } from "./web-ui-server.ts";
import { configuredContinuationProviders } from "./configured-chat-providers.ts";
import type { WebBackgroundServices } from "./background-services.ts";

export async function startWebContinuation(options: StartWebContinuationOptions): Promise<WebContinuationService> {
  const { workspaceId } = options;
  const url = `${webOrigin(options.network)}/chat/${workspaceId}`;
  const qr = await QRCode.toString(url, { type: "terminal", small: true });
  let control: HttpSessionControl | undefined;
  let background: WebBackgroundServices | undefined;
  const maxUploadBytes = 100 * 1024 * 1024;
  const providers = await configuredContinuationProviders({
    homePath: getDSCodeHome(), workspacePath: options.runtimeOptions.cwd, maxUploadBytes,
  });
  const server = await createWebUiServer({
    workspaces: { [workspaceId]: options.runtimeOptions.cwd },
    runtimeOptions: options.runtimeOptions,
    sessionDir: options.sessionDir,
    initialPosition: options.position,
    deferAdmission: true,
    deferBackgroundServices: true,
    strictBackgroundStartup: true,
    chatProviders: providers,
    onBackgroundServices: services => { background = services; },
    ...(options.onNotice ? { onBackgroundNotice: options.onNotice } : {}),
    chatAgentName: DEFAULT_CHAT_AGENT_NAME,
    maxUploadBytes,
    requireWorkspaceIdForSessionList: true,
    onSessionControl: (value) => { control = value; },
  }).catch(async error => {
    await Promise.allSettled(providers.map(provider => provider.dispose?.()));
    throw error;
  });
  let stopping = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    stopping = true;
    control!.closeAdmission();
    return closePromise ??= server.close();
  };
  try {
    await server.listen({ host: options.network.host, port: options.network.port });
  } catch (error) {
    await close();
    throw error;
  }
  const stopped = (error?: unknown): void => {
    if (stopping) return;
    options.onStopped(error);
    void close().catch((cleanupError: unknown) => options.onStopped(cleanupError));
  };
  server.server.once("close", () => stopped());
  server.server.once("error", stopped);
  return {
    url, qr,
    activate() { control!.openAdmission(); background!.start(); },
    status: () => background!.status(),
    prepareTakeback: () => control!.prepareTakeback(workspaceId),
    close,
  };
}
