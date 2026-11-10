// Resume an explicitly prepared, isolated phone acceptance fixture.
import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";

const root = process.argv[2] && path.resolve(process.argv[2]);
if (!root || process.argv.length !== 3) throw new Error("Usage: node scripts/wechat-live.mjs <isolated-fixture-root>");
const info = JSON.parse(await fs.readFile(path.join(root, "server.json"), "utf8"));
if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !/^[A-Za-z0-9_-]{16,128}$/u.test(info.workspaceId)) {
  throw new Error("Invalid isolated server.json fixture");
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith("IM_WECOM_") || ["DSCODE_SESSIONS_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "CORS_ORIGINS"].includes(key)) delete process.env[key];
}
process.env.DSCODE_HOME = path.join(root, "home");
process.env.DSCODE_SQLITE_HOME = path.join(root, "sqlite");
// Match the Docker deployment's existing task-management instructions.
const skillDirectory = path.join(process.env.DSCODE_HOME, "skills", "scheduled-tasks");
await fs.mkdir(skillDirectory, { recursive: true, mode: 0o700 });
try {
  await fs.copyFile(new URL("../deploy/default-skills/scheduled-tasks/SKILL.md", import.meta.url),
    path.join(skillDirectory, "SKILL.md"), constants.COPYFILE_EXCL);
} catch (error) { if (error.code !== "EEXIST") throw error; }
const { createWebUiServer } = await import("../packages/web-ui/dist/web-ui-server.js");
const { createWeChatChatProviderFromHome } = await import("../packages/wechat/dist/index.js");
const workspace = path.join(root, "workspace");
const provider = createWeChatChatProviderFromHome({ homePath: process.env.DSCODE_HOME, workspacePath: workspace, enabled: "true" });
const server = await createWebUiServer({
  workspaces: { [info.workspaceId]: workspace }, chatAgentName: "DSCode 微信验收", maxUploadBytes: 100 * 1024 * 1024,
  logger: { level: "warn" }, timezone: "Asia/Shanghai", chatProviders: [provider],
  runtimeArgs: ["--provider", "deepseek", "--model", "deepseek-flash", "--permission", "auto", "--sandbox", "workspace-write", "--network", "--effort", "low"],
});
let closing;
const close = () => { closing ??= server.close().then(() => { process.exitCode = 0; }); return closing; };
process.once("SIGINT", close);
process.once("SIGTERM", close);
await fs.writeFile(path.join(root, "server.pid"), String(process.pid), { mode: 0o600 });
await server.listen({ host: "127.0.0.1", port: info.port });
console.log(`Isolated WeChat acceptance listening on http://127.0.0.1:${info.port}`);
