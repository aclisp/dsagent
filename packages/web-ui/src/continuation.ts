import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { webOrigin, type StartWebContinuationOptions, type WebContinuationService } from "@aclisp/dsagent-core/session-runtime";
import type { HttpSessionControl } from "@aclisp/dsagent-http-adapter";
import { createWebUiServer } from "./web-ui-server.ts";

export async function startWebContinuation(options: StartWebContinuationOptions): Promise<WebContinuationService> {
  const workspaceId = randomBytes(24).toString("base64url");
  const url = `${webOrigin(options.network)}/chat/${workspaceId}`;
  const qr = await QRCode.toString(url, { type: "terminal", small: true });
  let control: HttpSessionControl | undefined;
  const server = await createWebUiServer({
    workspaces: { [workspaceId]: options.runtimeOptions.cwd },
    runtimeOptions: options.runtimeOptions,
    sessionDir: options.sessionDir,
    continuationMode: true,
    chatAgentName: "DSCode",
    maxUploadBytes: 100 * 1024 * 1024,
    timezone: "UTC",
    requireWorkspaceIdForSessionList: true,
    onSessionControl: (value) => { control = value; },
  });
  let stopping = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    stopping = true;
    return closePromise ??= server.close();
  };
  try {
    await control!.activate(workspaceId, options.position);
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
    prepareTakeback: () => control!.prepareTakeback(workspaceId),
    close,
  };
}
