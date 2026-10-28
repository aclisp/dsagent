import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { createDSCodeExtension } from "../packages/core/src/dscode-extension.ts";
import { parseRuntimeArgs } from "../packages/core/src/runtime-options.ts";
import * as sandbox from "../packages/core/src/sandbox.ts";
import { WebSnapshotStore } from "../packages/core/src/web-snapshots.ts";

vi.mock("../packages/core/src/hooks.ts", () => ({ registerHooks: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each([
  {
    mode: "danger-full-access", description: "host access", shell: "/bin/sh",
    expected: "- Commands execute locally on the host (shell: /bin/sh).",
  },
  {
    mode: "workspace-write", description: "Docker workspace-write", shell: "/bin/sh",
    expected: "- Commands execute locally in Docker workspace-write (shell: /bin/sh); this is the DSCode OS sandbox, not a model-provider cloud sandbox.",
  },
  {
    mode: "read-only", description: "unavailable (read-only)", shell: "unavailable",
    expected: "- Local command environment: unavailable (read-only) (shell: unavailable).",
  },
  {
    mode: "workspace-write", description: "Windows native sandbox unavailable (workspace-write)", shell: "pwsh.exe",
    expected: "- Local command environment: Windows native sandbox unavailable (workspace-write) (shell: pwsh.exe).",
  },
])("describes the command environment accurately ($description)", async sample => {
  vi.spyOn(sandbox, "sandboxDescription").mockReturnValue(sample.description);
  vi.spyOn(sandbox, "sandboxShellName").mockReturnValue(sample.shell);
  vi.spyOn(WebSnapshotStore.prototype, "cleanup").mockResolvedValue();
  const handlers: ((event: any, ctx: ExtensionContext) => unknown)[] = [];
  const pi = new Proxy({
    on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
      if (name === "before_agent_start") handlers.push(handler);
    },
    getActiveTools: () => [],
  }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as unknown as ExtensionAPI;
  const options = parseRuntimeArgs([
    "--permission", "auto", "--sandbox", sample.mode, "--prompt-contract", "engineering", "--no-tools",
  ]).options;
  const extension = createDSCodeExtension(options);
  await (typeof extension === "function" ? extension : extension.factory)(pi);
  const sections: Record<string, string> = {};
  for (const handler of handlers) await handler({ systemPromptOptions: { sections } }, {} as ExtensionContext);
  const environment = sections.dscode?.split("\n").find(line => line.includes("(shell: "));
  expect(environment).toBe(sample.expected);
});
