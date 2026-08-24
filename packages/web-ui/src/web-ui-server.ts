import { readFile } from "node:fs/promises";
import multipart from "@fastify/multipart";
import {
  createHttpAdapter,
  type CreateHttpAdapterServerOptions,
} from "@thinkany/dscode-http-adapter";
import type { FastifyInstance } from "fastify";
import { renderChatPage } from "./chat-page.js";
import {
  bindWebUiChatProvider,
  type WebUiChatProvider,
} from "./chat-provider.js";
import { registerFileRoutes } from "./files.js";
import {
  assertValidScheduleTimezone,
  createTaskScheduler,
} from "./task-scheduler.js";

export interface CreateWebUiServerOptions
  extends CreateHttpAdapterServerOptions {
  chatAgentName: string;
  maxUploadBytes: number;
  timezone: string;
  chatProvider?: WebUiChatProvider;
}

const staticFile = (name: string): Promise<Buffer> =>
  readFile(new URL(`../static/${name}`, import.meta.url));
const markedModule = (): Promise<Buffer> =>
  readFile(new URL(import.meta.resolve("marked")));

export async function createWebUiServer(
  options: CreateWebUiServerOptions,
): Promise<FastifyInstance> {
  const {
    chatAgentName,
    maxUploadBytes,
    timezone,
    chatProvider,
    ...httpAdapterOptions
  } = options;
  assertValidScheduleTimezone(timezone);
  const firstWorkspaceId = Object.keys(options.workspaces)[0];
  const firstWorkspacePath =
    firstWorkspaceId === undefined ? undefined : options.workspaces[firstWorkspaceId];
  if (firstWorkspaceId === undefined || firstWorkspacePath === undefined) {
    throw new Error("The Web UI Server requires at least one workspace");
  }

  const { server, sessionPort } = createHttpAdapter(httpAdapterOptions);
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
      const html = await staticFile("chat.html");
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
      const html = await staticFile("index.html");
      return reply.type("text/html; charset=utf-8").send(html);
    },
  );

  server.get("/chat.js", async (_request, reply) => {
    const script = await staticFile("chat.js");
    return reply.type("text/javascript; charset=utf-8").send(script);
  });

  server.get("/chat.css", async (_request, reply) => {
    const css = await staticFile("chat.css");
    return reply.type("text/css; charset=utf-8").send(css);
  });

  server.get("/marked.esm.js", async (_request, reply) => {
    const script = await markedModule();
    return reply.type("text/javascript; charset=utf-8").send(script);
  });

  server.get("/termino.js", async (_request, reply) => {
    const script = await staticFile("termino.js");
    return reply.type("text/javascript; charset=utf-8").send(script);
  });

  server.get("/app.js", async (_request, reply) => {
    const script = await staticFile("app.js");
    return reply.type("text/javascript; charset=utf-8").send(script);
  });

  server.get("/style.css", async (_request, reply) => {
    const css = await staticFile("style.css");
    return reply.type("text/css; charset=utf-8").send(css);
  });

  server.get("/favicon.png", async (_request, reply) => {
    const favicon = await staticFile("favicon.png");
    return reply.type("image/png").send(favicon);
  });

  const binding =
    chatProvider === undefined
      ? undefined
      : bindWebUiChatProvider({
          workspaceId: firstWorkspaceId,
          sessionPort,
          provider: chatProvider,
        });
  let scheduler: Awaited<ReturnType<typeof createTaskScheduler>>;
  try {
    scheduler = await createTaskScheduler({
      workspaceId: firstWorkspaceId,
      workspacePath: firstWorkspacePath,
      timezone,
      sessionPort,
      logger: server.log,
      ...(binding !== undefined ? { groupDelivery: binding } : {}),
    });
  } catch (error) {
    binding?.dispose();
    await server.close();
    throw error;
  }

  server.addHook("preClose", async () => {
    await scheduler.dispose();
    binding?.dispose();
  });

  return server;
}
