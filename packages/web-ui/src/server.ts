import { mkdir, readFile } from "node:fs/promises";
import process from "node:process";
import multipart from "@fastify/multipart";
import { createHttpAdapterServer } from "@thinkany/dscode-http-adapter";
import { renderChatPage, resolveChatAgentName } from "./chat-page.js";
import { registerFileRoutes } from "./files.js";
import { parseWorkspaces } from "./workspaces.js";

const workspacesConfig = process.env.WORKSPACES;
if (!workspacesConfig?.trim()) {
  throw new Error("WORKSPACES is required (comma-separated id=path pairs; ids are secrets)");
}
const workspaces = parseWorkspaces(workspacesConfig);
for (const cwd of Object.values(workspaces)) {
  await mkdir(cwd, { recursive: true });
}

const runtimeArgs = process.env.RUNTIME_ARGS?.trim()
  ? process.env.RUNTIME_ARGS.trim().split(/\s+/)
  : undefined;

const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);
const chatAgentName = resolveChatAgentName(process.env.CHAT_AGENT_NAME);

const server = createHttpAdapterServer({
  workspaces,
  logger: false,
  maxSessionFileBytes: 1024*1024,
  requireWorkspaceIdForSessionList: true,
  ...(runtimeArgs !== undefined ? { runtimeArgs } : {}),
});

await server.register(multipart);
registerFileRoutes(server, workspaces, { maxUploadBytes });

const staticFile = (name: string): Promise<Buffer> =>
  readFile(new URL(`../static/${name}`, import.meta.url));
const markedModule = (): Promise<Buffer> =>
  readFile(new URL(import.meta.resolve("marked")));

// Pages are served only with a configured workspace id, which is also the secret
// credential. The friendly chat owns /chat; the raw terminal remains at /debug.
server.get<{ Params: { workspaceId: string } }>(
  "/chat/:workspaceId",
  async (request, reply) => {
    if (!workspaces[request.params.workspaceId]) {
      return reply.code(404).send({ error: "workspace_not_found" });
    }
    const html = await staticFile("chat.html");
    return reply.type("text/html; charset=utf-8").send(renderChatPage(html, chatAgentName));
  },
);

server.get<{ Params: { workspaceId: string } }>(
  "/debug/:workspaceId",
  async (request, reply) => {
    if (!workspaces[request.params.workspaceId]) {
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

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8899);
await server.listen({ host, port });
console.log(`dscode web-ui listening on http://${host}:${port}`);
