import { mkdir, readFile } from "node:fs/promises";
import process from "node:process";
import multipart from "@fastify/multipart";
import { createHttpAdapterServer } from "@thinkany/dscode-http-adapter";
import { registerFileRoutes } from "./files.js";

function parseWorkspaces(value: string): Record<string, string> {
  const workspaces: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      throw new Error(`Invalid WORKSPACES entry "${trimmed}" — expected id=path`);
    }
    const id = trimmed.slice(0, separator).trim();
    const cwd = trimmed.slice(separator + 1).trim();
    if (id.length === 0 || cwd.length === 0) {
      throw new Error(`Invalid WORKSPACES entry "${trimmed}" — expected id=path`);
    }
    workspaces[id] = cwd;
  }
  if (Object.keys(workspaces).length === 0) {
    throw new Error("WORKSPACES resolved to no workspaces");
  }
  return workspaces;
}

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

// The page is served only at /chat/<workspaceId>, where the workspaceId is the secret
// credential — the root and unknown ids 404.
server.get<{ Params: { workspaceId: string } }>(
  "/chat/:workspaceId",
  async (request, reply) => {
    if (!workspaces[request.params.workspaceId]) {
      return reply.code(404).send({ error: "workspace_not_found" });
    }
    const html = await staticFile("index.html");
    return reply.type("text/html; charset=utf-8").send(html);
  },
);

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

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8899);
await server.listen({ host, port });
console.log(`dscode web-ui listening on http://${host}:${port}`);
