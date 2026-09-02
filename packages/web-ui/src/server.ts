import { mkdir } from "node:fs/promises";
import process from "node:process";
import { getDSCodeHome } from "@aclisp/dsagent-core";
import { createWeComChatProviderFromEnv } from "@aclisp/dsagent-wecom";
import { resolveChatAgentName } from "./chat-page.js";
import { resolveConfiguredTimezone } from "./task-scheduler.js";
import { createWebUiServer } from "./web-ui-server.js";
import { parseWorkspaces, resolveWorkspacesConfig } from "./workspaces.js";

const host = process.env.HOST ?? "127.0.0.1";
const workspacesConfig = resolveWorkspacesConfig(
  process.env.WORKSPACES,
  host,
  getDSCodeHome(),
);
const workspaces = parseWorkspaces(workspacesConfig);
const timezone = resolveConfiguredTimezone(process.env.TZ);
for (const cwd of Object.values(workspaces)) {
  await mkdir(cwd, { recursive: true });
}
const firstWorkspaceId = Object.keys(workspaces)[0];
const firstWorkspacePath =
  firstWorkspaceId === undefined ? undefined : workspaces[firstWorkspaceId];
if (firstWorkspacePath === undefined) {
  throw new Error("WORKSPACES resolved to no workspaces");
}

const runtimeArgs = process.env.RUNTIME_ARGS?.trim()
  ? process.env.RUNTIME_ARGS.trim().split(/\s+/)
  : undefined;

const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);
const chatAgentName = resolveChatAgentName(process.env.CHAT_AGENT_NAME);
const corsOrigins = process.env.CORS_ORIGINS?.trim()
  ? process.env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  : undefined;
const chatProvider = createWeComChatProviderFromEnv(process.env, {
  workspacePath: firstWorkspacePath,
  maxUploadBytes,
});

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
  ...(chatProvider !== undefined ? { chatProviders: [chatProvider] } : {}),
  onChatProviderStarted: (providerId) =>
    console.log(`dscode chat provider ${providerId} started`),
});

const port = Number(process.env.PORT ?? 8899);
await server.listen({ host, port });
console.log(`dscode web-ui listening on http://${host}:${port}`);
