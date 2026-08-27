import { readFile } from "node:fs/promises";
import path from "node:path";
import multipart from "@fastify/multipart";
import {
  createHttpAdapter,
  type CreateHttpAdapterServerOptions,
} from "@thinkany/dscode-http-adapter";
import {
  createConversationAliasRegistry,
  type ChatProvider,
} from "@thinkany/dscode-chat-client";
import type { FastifyInstance } from "fastify";
import { renderChatPage } from "./chat-page.js";
import {
  bindWebUiChatProvider,
} from "./chat-provider.js";
import { registerFileRoutes } from "./files.js";
import {
  assertValidScheduleTimezone,
  createTaskScheduler,
  type ScheduledSourceDeliveryPort,
} from "./task-scheduler.js";

export interface CreateWebUiServerOptions
  extends CreateHttpAdapterServerOptions {
  chatAgentName: string;
  maxUploadBytes: number;
  timezone: string;
  /** Preferred multi-Provider form. All Providers share one Session Port. */
  chatProviders?: readonly ChatProvider[];
  /** @deprecated Use chatProviders. */
  chatProvider?: ChatProvider;
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
    chatProviders,
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

  if (chatProviders !== undefined && chatProvider !== undefined) {
    throw new Error("Specify chatProviders or chatProvider, not both");
  }
  const providers =
    chatProviders !== undefined
      ? [...chatProviders]
      : chatProvider === undefined
        ? []
        : [chatProvider];
  const conversationRegistry = await createConversationAliasRegistry({
    filePath: path.join(firstWorkspacePath, ".dscode", "conversations.json"),
  });
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

  const activeProviders: Array<{
    provider: ChatProvider;
    binding: Awaited<ReturnType<typeof bindWebUiChatProvider>>;
  }> = [];
  const providerId = (provider: ChatProvider): string => {
    try {
      return provider.providerId;
    } catch {
      return "unknown";
    }
  };
  for (const provider of providers) {
    let binding: Awaited<ReturnType<typeof bindWebUiChatProvider>> | undefined;
    try {
      binding = bindWebUiChatProvider({
        workspaceId: firstWorkspaceId,
        sessionPort,
        provider,
        conversationRegistry,
      });
      await provider.start?.();
      activeProviders.push({ provider, binding });
    } catch (error) {
      try {
        binding?.dispose();
      } catch (disposeError) {
        server.log.error(
          { err: disposeError, providerId: providerId(provider) },
          "Chat Provider cleanup failed after startup error",
        );
      }
      try {
        await provider.dispose?.();
      } catch (disposeError) {
        server.log.error(
          { err: disposeError, providerId: providerId(provider) },
          "Chat Provider disposal failed after startup error",
        );
      }
      server.log.error(
        { err: error, providerId: providerId(provider) },
        "Chat Provider isolated after startup failure",
      );
    }
  }

  const disposeProviders = async (): Promise<void> => {
    for (const { provider, binding } of activeProviders) {
      try {
        binding.dispose();
      } catch (error) {
        server.log.error(
          { err: error, providerId: providerId(provider) },
          "Chat Provider binding disposal failed",
        );
      }
      try {
        await provider.dispose?.();
      } catch (error) {
        server.log.error(
          { err: error, providerId: providerId(provider) },
          "Chat Provider disposal failed",
        );
      }
    }
  };
  const sourceDelivery: ScheduledSourceDeliveryPort = {
    registerTurnForSourceDelivery(turnId, conversationAlias, listener) {
      const resolved = conversationRegistry.resolveConversation(conversationAlias);
      if (resolved.status !== "resolved") return "unavailable";
      const active = activeProviders.find(
        ({ provider }) => providerId(provider) === resolved.reference.providerId,
      );
      if (active === undefined) return "unavailable";
      try {
        return active.binding.registerTurnForDelivery(
          turnId,
          resolved.reference,
          listener,
        )
          ? "registered"
          : "failed";
      } catch (error) {
        server.log.error(
          { err: error, turnId, providerId: resolved.reference.providerId },
          "Scheduled source delivery registration failed",
        );
        return "failed";
      }
    },
  };
  let scheduler: Awaited<ReturnType<typeof createTaskScheduler>>;
  try {
    scheduler = await createTaskScheduler({
      workspaceId: firstWorkspaceId,
      workspacePath: firstWorkspacePath,
      timezone,
      sessionPort,
      logger: server.log,
      ...(activeProviders.length > 0 ? { sourceDelivery } : {}),
    });
  } catch (error) {
    try {
      await disposeProviders();
    } finally {
      await server.close();
    }
    throw error;
  }

  server.addHook("preClose", async () => {
    try {
      await scheduler.dispose();
    } finally {
      await disposeProviders();
    }
  });

  return server;
}
