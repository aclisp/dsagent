import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { getStoredWebPreferences, getStoredWebWorkspaceId, saveWebWorkspaceId } from "./settings.ts";
import { loadSessionPosition, type DSCodeSessionRuntime, type SessionPosition } from "./session-handoff.ts";
import type { DSCodeRuntimeOptions } from "./runtime-options.ts";

export interface WebPreferences {
  host: string;
  port: number;
  url?: string;
}

export interface WebContinuationService {
  readonly url: string;
  readonly qr: string;
  activate?(): void;
  status?(): string;
  /** Synchronously close request admission and check all runtime/job state. */
  prepareTakeback(): SessionPosition | null;
  close(): Promise<void>;
}

export interface StartWebContinuationOptions {
  workspaceId: string;
  network: WebPreferences;
  runtimeOptions: DSCodeRuntimeOptions;
  position: SessionPosition | null;
  sessionDir: string;
  onStopped(error?: unknown): void;
  onNotice?(message: string): void;
}

export type WebContinuationFactory = (options: StartWebContinuationOptions) => Promise<WebContinuationService>;

export function parseWebArguments(args: string): Partial<WebPreferences> | "status" {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  if (tokens.length === 1 && tokens[0] === "status") return "status";
  const result: Partial<WebPreferences> = {};
  for (let i = 0; i < tokens.length; i++) {
    const match = /^--(host|port|url)(?:=(.*))?$/.exec(tokens[i]!);
    if (!match) throw new Error("Usage: /web [--host <address>] [--port <port>] [--url <origin>], or /web status");
    const name = match[1] as keyof WebPreferences;
    const value = match[2] ?? tokens[++i];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    if (name === "port") result.port = Number(value);
    else result[name] = value;
  }
  return result;
}

const WEB_DEFAULTS = { host: "127.0.0.1", port: 8899 };
const WEB_OPTION_DESCRIPTIONS = {
  host: "Listen address (e.g. 127.0.0.1 or 0.0.0.0)",
  port: "Listen port (1–65535, e.g. 8899)",
  url: "Browser origin (e.g. https://agent.example.com)",
} satisfies Record<keyof WebPreferences, string>;

const completeWebArguments: NonNullable<RegisteredCommand["getArgumentCompletions"]> = (prefix) => {
  // Pi replaces the entire argument prefix, so carry completed options into each result.
  const token = /\S*$/.exec(prefix)![0];
  const before = prefix.slice(0, prefix.length - token.length);
  const pending = /(?:^|\s)--(host|port|url)\s+$/.exec(before);
  const inline = /^--(host|port|url)=(.*)$/.exec(token);
  const key = (pending?.[1] ?? inline?.[1]) as keyof WebPreferences | undefined;
  try {
    const completed = parseWebArguments(pending ? before.slice(0, pending.index) : before);
    if (completed === "status" || token === "status") return null;
    const saved = getStoredWebPreferences();
    const host = completed.host ?? saved.host ?? WEB_DEFAULTS.host;
    const port = completed.port ?? saved.port ?? WEB_DEFAULTS.port;
    const needsUrl = ["0.0.0.0", "::", "[::]"].includes(host) && completed.url === undefined && saved.url === undefined;
    const lanExample = `http://192.168.1.20:${port}`;
    if (key) {
      const partial = pending ? token : inline![2]!;
      const examples = {
        host: [WEB_DEFAULTS.host, "0.0.0.0", "::1"],
        port: [String(WEB_DEFAULTS.port)],
        url: needsUrl ? [lanExample, "https://agent.example.com"] : ["https://agent.example.com"],
      }[key];
      return examples.filter(example => example.startsWith(partial) && example !== partial).map(example => ({
        value: `${before}${pending ? "" : `--${key}=`}${example}`,
        label: example,
        description: key === "url" ? "Example only; replace with your browser origin" : WEB_OPTION_DESCRIPTIONS[key],
      }));
    }

    const keys: (keyof WebPreferences)[] = needsUrl ? ["url", "host", "port"] : ["host", "port", "url"];
    const items = keys.filter(option => completed[option] === undefined && `--${option}`.startsWith(token)).map(option => ({
      value: `${before}--${option} `,
      label: `--${option}`,
      description: option === "url" && needsUrl ? `Required for wildcard host (e.g. ${lanExample})` : WEB_OPTION_DESCRIPTIONS[option],
    }));
    if (!before.trim() && "status".startsWith(token)) {
      items.push({ value: `${before}status`, label: "status", description: "Show the running service and its URL" });
    }
    return items;
  } catch {
    // Completion should not interrupt typing when the command or config is incomplete or invalid.
    return null;
  }
};

export function resolveWebPreferences(saved: Partial<WebPreferences>, overrides: Partial<WebPreferences>): WebPreferences {
  const preferences = { ...WEB_DEFAULTS, ...saved, ...overrides };
  if (typeof preferences.host !== "string" || !preferences.host || /[\s/\\?#@]/.test(preferences.host)) {
    throw new Error("Web host must be a hostname or IP address, without a URL scheme or path.");
  }
  preferences.host = preferences.host.replace(/^\[([\da-fA-F:]+)\]$/, "$1");
  if (!Number.isInteger(preferences.port) || preferences.port < 1 || preferences.port > 65535) {
    throw new Error("Web port must be an integer between 1 and 65535.");
  }
  if (preferences.url !== undefined) {
    const parsed = new URL(preferences.url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== "/") {
      throw new Error("Web URL must be an HTTP(S) origin, without a path, credentials, query, or fragment.");
    }
    preferences.url = parsed.origin;
  }
  webOrigin(preferences);
  return preferences;
}

export function webOrigin(preferences: WebPreferences): string {
  if (preferences.url !== undefined) return preferences.url;
  const host = preferences.host.includes(":") ? `[${preferences.host}]` : preferences.host;
  const parsed = new URL(`http://${host}:${preferences.port}`);
  if (["0.0.0.0", "[::]"].includes(parsed.hostname)) {
    throw new Error("A wildcard Web host requires --url <origin> (for example --url http://192.168.1.20:8899).");
  }
  return parsed.origin;
}

const REMINDER = "Web continuation is active. Run /tui before continuing here.";

/** Owned by the CLI, independent of any one Pi session/extension instance. */
export class WebContinuationController {
  private service: WebContinuationService | undefined;
  private network: WebPreferences | undefined;
  private workspace: string | undefined;
  private current: { runtime: DSCodeSessionRuntime; ctx: ExtensionContext } | undefined;
  private transitioning = false;
  private readonly startService: WebContinuationFactory;

  constructor(startService: WebContinuationFactory) {
    this.startService = startService;
  }

  attach(runtime: DSCodeSessionRuntime, ctx: ExtensionContext): void {
    this.current = { runtime, ctx };
    this.remind();
  }

  detach(): void {
    this.current = undefined;
  }

  private remind(): void {
    this.current?.ctx.ui.setWidget("dscode-web", this.service ? [REMINDER] : undefined);
  }

  private notify(message: string, type: "info" | "warning" | "error" = "info"): void {
    this.current?.ctx.ui.notify(message, type);
  }

  register(pi: ExtensionAPI, baseOptions: DSCodeRuntimeOptions): void {
    pi.registerCommand("web", {
      description: "Continue in a browser; Enter uses defaults, Space shows options",
      getArgumentCompletions: completeWebArguments,
      handler: async (args, ctx) => {
        if (ctx.mode !== "tui") return;
        try {
          const overrides = parseWebArguments(args);
          if (overrides === "status") {
            this.notify(this.service ? `Web is running.\n${this.service.url}\n${this.service.status?.() ?? ""}` : "Web is stopped.");
            return;
          }
          if (this.transitioning) throw new Error("A Web handoff is already in progress.");
          if (this.service) {
            const requested = resolveWebPreferences(this.network!, overrides);
            if (JSON.stringify(requested) !== JSON.stringify(this.network)) {
              throw new Error("Run /tui before changing the Web service's network parameters.");
            }
            this.notify(`Web is running.\n${this.service.url}\n${this.service.status?.() ?? ""}\n${this.service.qr}`);
            return;
          }
          this.transitioning = true;
          try {
            const runtime = this.current!.runtime;
            runtime.assertIdle();
            const position = runtime.getPosition();
            const runtimeOptions = runtime.getOptions();
            const network = resolveWebPreferences(getStoredWebPreferences(), overrides);
            const workspaceId = getStoredWebWorkspaceId(runtimeOptions.cwd) ?? randomBytes(24).toString("base64url");
            let service: WebContinuationService | undefined;
            service = await this.startService({
              workspaceId, network, position, runtimeOptions, sessionDir: runtime.sessionDir,
              onStopped: (error) => {
                if (this.service !== service) return;
                this.service = undefined;
                this.network = undefined;
                this.workspace = undefined;
                this.remind();
                this.notify(`Web stopped${error ? `: ${errorMessage(error)}` : "."} Use /resume to recover saved work.`, "error");
              },
              onNotice: message => { if (service && this.service === service) this.notify(message, "warning"); },
            });
            try {
              runtime.assertIdle();
              service.activate?.();
            } catch (error) {
              await service.close();
              throw error;
            }
            this.service = service;
            this.network = network;
            this.workspace = runtimeOptions.cwd;
            this.remind();
            this.notify(`Web is running.\n${service.url}\n${service.status?.() ?? ""}\n${service.qr}\nRun /tui when you return.`);
            try {
              await saveWebWorkspaceId({ cwd: runtimeOptions.cwd, id: workspaceId });
            } catch (error) {
              this.notify(`Web is running, but its workspace ID was not saved; the browser URL may change on the next start: ${errorMessage(error)}`, "warning");
            }
          } finally {
            this.transitioning = false;
          }
        } catch (error) {
          this.notify(errorMessage(error), "error");
        }
      },
    });

    pi.registerCommand("tui", {
      description: "Stop Web and resume its conversation here, keeping this TUI's settings",
      handler: async (args, ctx) => {
        if (ctx.mode !== "tui") return;
        let replacing = false;
        try {
          if (args.trim()) throw new Error("Usage: /tui");
          if (this.transitioning) throw new Error("A Web handoff is already in progress.");
          if (!this.service) { this.notify("Web is not running."); return; }
          this.current!.runtime.assertIdle();
          const options = this.current!.runtime.getOptions();
          if (options.cwd !== this.workspace) {
            throw new Error(`Return the TUI to ${this.workspace} before running /tui. Use /resume to select a session in that workspace.`);
          }
          // No await between the Web idle check and closing admission.
          const position = this.service.prepareTakeback();
          this.transitioning = true;
          try {
            await this.close();
            Object.assign(baseOptions, options);
            replacing = true;
            const controller = this;
            const result = await ctx.newSession({
              ...(position ? { setup: async (manager) => loadSessionPosition(manager, position) } : {}),
              withSession: async (fresh) => {
                await controller.current!.runtime.restoreOptions(options);
                controller.remind();
                fresh.ui.notify("Web stopped. Conversation resumed in the TUI.", "info");
              },
            });
            if (result.cancelled) controller.notify("Web stopped. TUI resumption was cancelled; use /resume to recover saved work.", "warning");
          } finally {
            this.transitioning = false;
          }
        } catch (error) {
          // A failed replacement can invalidate the old command context.
          const message = `${errorMessage(error)}${replacing ? " Use /resume to recover saved work." : ""}`;
          this.notify(message, "error");
        }
      },
    });
  }

  async close(): Promise<void> {
    const service = this.service;
    this.service = undefined;
    this.network = undefined;
    this.workspace = undefined;
    this.remind();
    await service?.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
