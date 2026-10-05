import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";
import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { StdioTransport } from "@earendil-works/pi-mcp";
import { isStandalone } from "./distribution.ts";
import { stripModelCredentialEnvironment } from "./providers.ts";
import type { DSCodeRuntimeOptions } from "./runtime-options.ts";

let credentialGuard: Promise<void> | undefined;
const guardedTransports = new WeakSet<typeof StdioTransport>();

/** Also covers Pi's native MCP CLI, which creates transports outside extensions. */
export function installMcpCredentialGuard(): Promise<void> {
  return credentialGuard ??= (async () => {
    guardTransport(StdioTransport);
    if (isStandalone) return;
    // npm may give Pi its own MCP dependency instance. Resolve from Pi rather
    // than assuming our direct dependency is the transport used by native CLI.
    const manifest = nodeModule.findPackageJSON(
      "@earendil-works/pi-mcp", import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    if (!manifest) throw new Error("Cannot locate Pi's MCP transport dependency");
    const native = await import(new URL("./dist/index.js", pathToFileURL(manifest)).href) as { StdioTransport: typeof StdioTransport };
    guardTransport(native.StdioTransport);
  })();
}

function guardTransport(Transport: typeof StdioTransport): void {
  if (guardedTransports.has(Transport)) return;
  guardedTransports.add(Transport);
  const start = Transport.prototype.start;
  Transport.prototype.start = async function () {
    const options = this.options;
    // Keep Pi's config/env resolution and explicitly supplied server credentials.
    // Pi 1.0's public transport options are frozen, so replace the options object.
    Object.defineProperty(this, "options", {
      value: Object.freeze({
        ...options,
        inheritEnv: false,
        env: {
          ...(options.inheritEnv === false ? {} : stripModelCredentialEnvironment({ ...process.env })),
          ...options.env,
        },
      }),
    });
    return start.call(this);
  };
}

export function isMcpResourceTool(name: string): boolean {
  return [
    "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
  ].includes(name);
}

export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__") || isMcpResourceTool(name);
}

/** Named replacements work in both Pi's CLI and the SDK, including /reload. */
export async function createDSCodePiBuiltins(options: DSCodeRuntimeOptions): Promise<InlineExtension[]> {
  await installMcpCredentialGuard();
  const disabled = options.noTools;
  return [
    { name: "codemode", builtin: true, factory: disabled ? () => {} : createCodemodeExtension({ mode: "on", models: false }) },
    { name: "tool-search", builtin: true, factory: disabled ? () => {} : createToolSearchExtension() },
    { name: "mcp", builtin: true, factory: disabled || options.noMcp ? () => {} : createMcpExtension() },
  ];
}
