import multipart from "@fastify/multipart";
import {
  createHttpAdapter,
  type CreateHttpAdapterServerOptions,
} from "@aclisp/dsagent-http-adapter";
import type { ChatProvider } from "@aclisp/dsagent-chat-client";
import type { SessionPosition } from "@aclisp/dsagent-core/session-runtime";
import type { FastifyInstance } from "fastify";
import { renderChatPage } from "./chat-page.ts";
import { readWebAsset } from "./web-assets.ts";
import { prepareBackgroundServices, type WebBackgroundServices } from "./background-services.ts";
import { registerFileRoutes } from "./files.ts";
import {
  assertValidScheduleTimezone,
  resolveConfiguredTimezone,
} from "./task-scheduler.ts";

export interface CreateWebUiServerOptions
  extends CreateHttpAdapterServerOptions {
  chatAgentName: string;
  maxUploadBytes: number;
  /** Scheduler timezone. Defaults to TZ or Asia/Shanghai. */
  timezone?: string;
  /** Preferred multi-Provider form. All Providers share one Session Port. */
  chatProviders?: readonly ChatProvider[];
  onChatProviderStarted?: (providerId: string) => void;
  /** Browser-only embedding, without background services. */
  continuationMode?: boolean;
  deferBackgroundServices?: boolean;
  strictBackgroundStartup?: boolean;
  coordinationDirectory?: string;
  onBackgroundServices?: (services: WebBackgroundServices) => void;
  onBackgroundNotice?: (message: string) => void;
  initialPosition?: SessionPosition | null;
}

export async function createWebUiServer(
  options: CreateWebUiServerOptions,
): Promise<FastifyInstance> {
  const {
    chatAgentName,
    maxUploadBytes,
    timezone,
    chatProviders,
    onChatProviderStarted,
    continuationMode, deferBackgroundServices, strictBackgroundStartup,
    coordinationDirectory, onBackgroundServices, onBackgroundNotice,
    initialPosition,
    ...httpAdapterOptions
  } = options;
  const firstWorkspaceId = Object.keys(options.workspaces)[0];
  const firstWorkspacePath =
    firstWorkspaceId === undefined ? undefined : options.workspaces[firstWorkspaceId];
  if (firstWorkspaceId === undefined || firstWorkspacePath === undefined) {
    throw new Error("The Web UI Server requires at least one workspace");
  }

  const providers = chatProviders === undefined ? [] : [...chatProviders];
  let sessionControl: import("@aclisp/dsagent-http-adapter").HttpSessionControl | undefined;
  const { server, sessionPort } = createHttpAdapter({
    ...httpAdapterOptions,
    scheduledTaskWorkspaces: continuationMode ? [] : [firstWorkspaceId],
    onSessionControl: control => { sessionControl = control; httpAdapterOptions.onSessionControl?.(control); },
  });
  await server.register(multipart);
  registerFileRoutes(server, options.workspaces, { maxUploadBytes });

  // Pages are served only with a configured workspace id, which is also the secret
  // credential. The friendly chat owns /chat; the raw terminal remains at /debug.
  server.get<{ Params: { workspaceId: string } }>(
    "/chat/:workspaceId",
    async (request, reply) => {
      if (!options.workspaces[request.params.workspaceId]) {
        return reply.code(404).send({ error: "workspace_not_found" });
      }
      const html = await readWebAsset("chat.html");
      return reply
        .type("text/html; charset=utf-8")
        .send(renderChatPage(html, chatAgentName));
    },
  );

  server.get<{ Params: { workspaceId: string } }>(
    "/debug/:workspaceId",
    async (request, reply) => {
      if (!options.workspaces[request.params.workspaceId]) {
        return reply.code(404).send({ error: "workspace_not_found" });
      }
      const html = await readWebAsset("index.html");
      return reply.type("text/html; charset=utf-8").send(html);
    },
  );

  server.get("/chat.js", async (_request, reply) => {
    const script = await readWebAsset("chat.js");
    return reply.type("text/javascript; charset=utf-8").send(script);
  });

  server.get("/chat.css", async (_request, reply) => {
    const css = await readWebAsset("chat.css");
    return reply.type("text/css; charset=utf-8").send(css);
  });

  server.get("/marked.esm.js", async (_request, reply) => {
    const script = await readWebAsset("marked.esm.js");
    return reply.type("text/javascript; charset=utf-8").send(script);
  });

  server.get("/termino.js", async (_request, reply) => {
    const script = await readWebAsset("termino.js");
    return reply.type("text/javascript; charset=utf-8").send(script);
  });

  server.get("/app.js", async (_request, reply) => {
    const script = await readWebAsset("app.js");
    return reply.type("text/javascript; charset=utf-8").send(script);
  });

  server.get("/style.css", async (_request, reply) => {
    const css = await readWebAsset("style.css");
    return reply.type("text/css; charset=utf-8").send(css);
  });

  server.get("/favicon.png", async (_request, reply) => {
    const favicon = await readWebAsset("favicon.png");
    return reply.type("image/png").send(favicon);
  });

  if (continuationMode) return server;

  const schedulerTimezone = resolveConfiguredTimezone(timezone ?? process.env.TZ);
  assertValidScheduleTimezone(schedulerTimezone);
  let background: WebBackgroundServices | undefined;
  server.addHook("preClose", async () => { await background?.close(); });
  try {
    if (initialPosition !== undefined) await sessionControl!.activate(firstWorkspaceId, initialPosition);
    background = await prepareBackgroundServices({
      workspaceId: firstWorkspaceId, workspacePath: firstWorkspacePath, sessionPort,
      providers, timezone: schedulerTimezone, strict: strictBackgroundStartup ?? false,
      logger: server.log,
      ...(coordinationDirectory ? { coordinationDirectory } : {}),
      ...(onChatProviderStarted ? { onProviderStarted: onChatProviderStarted } : {}),
      ...(onBackgroundNotice ? { onNotice: onBackgroundNotice } : {}),
      onOwnershipLost: error => {
        onBackgroundNotice?.(error.message);
        void server.close().catch(() => undefined);
      },
    });
    onBackgroundServices?.(background);
    if (!deferBackgroundServices) background.start();
    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
}
