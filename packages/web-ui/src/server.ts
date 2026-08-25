import { mkdir } from "node:fs/promises";
import process from "node:process";
import { createWeComChatProviderFromEnv } from "@thinkany/dscode-wecom";
import { resolveChatAgentName } from "./chat-page.js";
import { createWebUiServer } from "./web-ui-server.js";
import { parseWorkspaces } from "./workspaces.js";

const workspacesConfig = process.env.WORKSPACES;
if (!workspacesConfig?.trim()) {
  throw new Error("WORKSPACES is required (comma-separated id=path pairs; ids are secrets)");
}
const workspaces = parseWorkspaces(workspacesConfig);
const timezone = process.env.TZ;
if (!timezone?.trim()) {
  throw new Error("TZ is required and must be a valid IANA timezone");
}
for (const cwd of Object.values(workspaces)) {
  await mkdir(cwd, { recursive: true });
}

const runtimeArgs = process.env.RUNTIME_ARGS?.trim()
  ? process.env.RUNTIME_ARGS.trim().split(/\s+/)
  : undefined;

const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);
const chatAgentName = resolveChatAgentName(process.env.CHAT_AGENT_NAME);
const corsOrigins = process.env.CORS_ORIGINS?.trim()
  ? process.env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  : undefined;
const chatProvider = createWeComChatProviderFromEnv();

const server = await createWebUiServer({
  workspaces,
  logger: false,
  maxSessionFileBytes: 1024 * 1024,
  requireWorkspaceIdForSessionList: true,
  maxUploadBytes,
  chatAgentName,
  timezone,
  ...(runtimeArgs !== undefined ? { runtimeArgs } : {}),
  ...(corsOrigins !== undefined ? { corsOrigins } : {}),
  ...(chatProvider !== undefined ? { chatProvider } : {}),
});

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8899);
await server.listen({ host, port });
console.log(`dscode web-ui listening on http://${host}:${port}`);
