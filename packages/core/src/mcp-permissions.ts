import type { McpApprovalInfo } from "./mcp-confirmation.ts";

/** Explicit grants for the live session only; never restored from the transcript. */
export class McpSessionPermissions {
  private readonly tools = new Map<string, string | undefined>();
  private readonly servers = new Set<string>();
  epoch = 0;

  isApproved(info: McpApprovalInfo): boolean {
    return this.tools.has(info.tool) || (info.server !== undefined && this.servers.has(info.server));
  }

  grant(info: McpApprovalInfo, scope: "tool" | "server"): void {
    if (scope === "tool") this.tools.set(info.tool, info.server);
    else if (info.server) this.servers.add(info.server);
  }

  describe(): string[] {
    return [
      ...[...this.servers].sort().map((server) => `${server} (all tools)`),
      ...[...this.tools.keys()].sort(),
    ];
  }

  clear(): void {
    this.tools.clear();
    this.servers.clear();
    this.epoch++;
  }

  revoke(name: string): boolean {
    if (name === "all") {
      this.clear();
      return true;
    }
    let removed = this.servers.delete(name);
    for (const [tool, server] of this.tools) {
      if (tool === name || server === name) {
        this.tools.delete(tool);
        removed = true;
      }
    }
    if (removed) this.epoch++;
    return removed;
  }
}
