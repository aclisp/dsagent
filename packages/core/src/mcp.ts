import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DSCODE_VERSION } from "./version.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import { renderCollapsibleToolResult, renderToolCall } from "./tool-ui.js";
import { getDSCodeHome } from "./home.js";
import { stripModelCredentialEnvironment } from "./providers.js";

const stdioServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  disabled: z.boolean().optional(),
});
const httpServerSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
});
const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), z.union([stdioServerSchema, httpServerSchema])).default({}),
});
type MCPServerConfig = z.infer<typeof mcpConfigSchema>["mcpServers"][string];

interface ConnectedServer {
  name: string;
  client: Client;
  close(): Promise<void>;
  tools: ConnectedTool[];
}

interface ConnectedTool {
  name: string;
  summary: string;
}

const MCP_TOOL_SUMMARY_MAX_LENGTH = 120;

export class MCPManager {
  private readonly servers: ConnectedServer[] = [];
  private errors: string[] = [];
  private disabledReason: string | undefined;
  private disabledServers: string[] = [];

  async connectConfigured(pi: ExtensionAPI, ctx: ExtensionContext, disabledReason?: string): Promise<void> {
    this.errors = [];
    this.disabledServers = [];
    this.disabledReason = disabledReason;
    if (disabledReason) return;
    const trusted = ctx.isProjectTrusted();
    if (!trusted) {
      this.errors.push("Project is not trusted; project MCP servers were not started.");
    }
    let configs: Record<string, MCPServerConfig>;
    try {
      configs = await loadMcpConfigs(ctx.cwd, trusted);
    } catch (error) {
      this.errors.push((error as Error).message);
      return;
    }
    for (const [serverName, config] of Object.entries(configs)) {
      if (config.disabled) {
        this.disabledServers.push(serverName);
        continue;
      }
      try {
        await this.connectServer(pi, ctx, serverName, config);
      } catch (error) {
        this.errors.push(`${serverName}: ${(error as Error).message}`);
      }
    }
  }

  status(): string {
    if (this.disabledReason) return `MCP disabled by ${this.disabledReason}.`;
    const lines = this.servers.map(
      (server) => `${server.name}: connected (${server.tools.length} tools)`,
    );
    lines.push(...this.errors.map((error) => `error: ${error}`));
    lines.push(...this.disabledServers.map((name) => `${name}: disabled by configuration`));
    return lines.length > 0 ? lines.join("\n") : "No MCP servers configured.";
  }

  detailedStatus(activeTools?: readonly string[], inactiveReason = "inactive"): string {
    if (this.disabledReason) return `MCP disabled by ${this.disabledReason}.`;
    const active = activeTools === undefined ? undefined : new Set(activeTools);
    const lines: string[] = [];
    for (const server of this.servers) {
      lines.push(`${server.name}: connected (${server.tools.length} tools)`);
      lines.push(...server.tools.map((tool) =>
        `- ${tool.name}${active ? ` [${active.has(tool.name) ? "active" : inactiveReason}]` : ""}: ${tool.summary}`,
      ));
    }
    lines.push(...this.errors.map((error) => `error: ${error}`));
    lines.push(...this.disabledServers.map((name) => `${name}: disabled by configuration`));
    return lines.length > 0 ? lines.join("\n") : "No MCP servers configured.";
  }

  toolNames(): string[] {
    return this.servers.flatMap((server) => server.tools.map((tool) => tool.name));
  }

  initializationErrors(): readonly string[] {
    return this.errors;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.servers.map((server) => server.close()));
    this.servers.length = 0;
  }

  private async connectServer(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    serverName: string,
    config: MCPServerConfig,
  ): Promise<void> {
    const client = new Client({ name: "dscode", version: DSCODE_VERSION });
    let close: (() => Promise<void>) | undefined;
    try {
      if ("command" in config) {
        const environment = {
          ...defaultStringEnvironment(),
          ...expandEnvironment(config.env ?? {}),
        };
        const transport = new StdioClientTransport({
          command: config.command,
          ...(config.args ? { args: config.args } : {}),
          env: environment,
          cwd: config.cwd ? path.resolve(ctx.cwd, config.cwd) : ctx.cwd,
          stderr: "inherit",
        });
        close = async () => transport.close();
        await client.connect(transport as any);
      } else {
        const transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: expandEnvironment(config.headers ?? {}) },
        });
        close = async () => transport.close();
        await client.connect(transport as any);
      }

      let listed = await client.listTools();
      const tools = [...listed.tools];
      const cursors = new Set<string>();
      while (listed.nextCursor) {
        if (cursors.has(listed.nextCursor)) throw new Error("Repeated MCP tools/list cursor");
        cursors.add(listed.nextCursor);
        listed = await client.listTools({ cursor: listed.nextCursor });
        tools.push(...listed.tools);
      }
      const registered: ConnectedTool[] = [];
      for (const tool of tools) {
        const localName = `mcp__${sanitizeName(serverName)}__${sanitizeName(tool.name)}`;
        registered.push({
          name: localName,
          summary: summarizeTool(tool.description, tool.title, tool.name),
        });
        pi.registerTool({
          name: localName,
          label: `${serverName}: ${tool.title ?? tool.name}`,
          description: tool.description ?? `Call MCP tool ${tool.name} on ${serverName}`,
          promptSnippet: `${localName}: ${tool.description ?? tool.name}`,
          parameters: tool.inputSchema as any,
          renderShell: "self",
          executionMode: "parallel",
          async execute(_id, params, signal) {
            const result = await client.callTool(
              { name: tool.name, arguments: params as Record<string, unknown> },
              undefined,
              signal ? { signal } : {},
            );
            const formatted = formatMcpResult(result);
            if (result.isError) throw new Error(formatted.text);
            return {
              content: formatted.content,
              details: { server: serverName, tool: tool.name },
            };
          },
          renderCall(_args, theme, context) {
            return renderToolCall("Called MCP", `${serverName}.${tool.name}`, theme, context);
          },
          renderResult(result, renderOptions, theme, context) {
            return renderCollapsibleToolResult(result, renderOptions, theme, context, {
              collapsedSummary: "response received",
            });
          },
        });
      }
      this.servers.push({ name: serverName, client, close, tools: registered });
    } catch (error) {
      if (close) await close().catch(() => {});
      throw error;
    }
  }
}

async function loadMcpConfigs(
  cwd: string,
  includeProject: boolean,
): Promise<Record<string, MCPServerConfig>> {
  const configs: Record<string, MCPServerConfig> = {};
  const files = [path.join(getDSCodeHome(), "mcp.json")];
  if (includeProject) files.push(path.join(cwd, ".dscode", "mcp.json"));
  for (const file of files) {
    try {
      const parsed = mcpConfigSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
      Object.assign(configs, parsed.mcpServers);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Invalid MCP configuration ${file}: ${(error as Error).message}`);
    }
  }
  return configs;
}

function expandEnvironment(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => process.env[name] ?? ""),
    ]),
  );
}

function defaultStringEnvironment(): Record<string, string> {
  return stripModelCredentialEnvironment(
    Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  );
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function summarizeTool(
  description: string | undefined,
  title: string | undefined,
  name: string,
): string {
  const summary = (description?.trim() || title?.trim() || name).replace(/\s+/g, " ");
  if (summary.length <= MCP_TOOL_SUMMARY_MAX_LENGTH) return summary;
  return `${summary.slice(0, MCP_TOOL_SUMMARY_MAX_LENGTH - 1).trimEnd()}…`;
}

interface FormattedMcpResult {
  content: Array<TextContent | ImageContent>;
  text: string;
}

function formatMcpResult(result: Awaited<ReturnType<Client["callTool"]>>): FormattedMcpResult {
  const content: Array<TextContent | ImageContent> = [];
  const textParts: string[] = [];
  const addText = (text: string): void => {
    content.push({ type: "text", text });
    textParts.push(text);
  };
  const resultContent = Array.isArray(result.content) ? result.content : [];
  for (const item of resultContent as Array<Record<string, unknown>>) {
    if (item.type === "text") {
      addText(typeof item.text === "string" ? item.text : "(MCP text content was invalid)");
    } else if (
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else if (item.type === "resource") {
      const resource = item.resource;
      if (isRecord(resource)) {
        addText(
          typeof resource.text === "string"
            ? resource.text
            : `[binary resource: ${typeof resource.uri === "string" ? resource.uri : "unknown"}]`,
        );
      } else {
        addText("(MCP resource content was invalid)");
      }
    } else if (item.type === "resource_link") {
      addText(
        `[resource: ${typeof item.name === "string" ? item.name : "unnamed"}](${typeof item.uri === "string" ? item.uri : "unknown"})`,
      );
    } else {
      addText(
        `[${typeof item.type === "string" ? item.type : "unknown"} content omitted from this MCP tool result]`,
      );
    }
  }
  if (result.structuredContent !== undefined) {
    addText(JSON.stringify(result.structuredContent, null, 2));
  }
  if (content.length === 0) addText("(MCP tool returned no content)");
  return {
    content,
    text: textParts.join("\n\n") || "(MCP tool returned image content without error details)",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
