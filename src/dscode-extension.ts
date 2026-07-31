import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
  SessionEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { brandBlue } from "./brand.js";
import { capturePatchCheckpoint, restoreCheckpoint, type PatchCheckpoint } from "./checkpoint.js";
import { permissionSchema, type PermissionMode } from "./config.js";
import { optimizeDeepSeekResponsesPayload } from "./deepseek.js";
import { registerDiagnosticsTool } from "./diagnostics.js";
import { registerNaturalExit } from "./exit.js";
import { registerHooks } from "./hooks.js";
import { ManagedProcessRegistry, type ManagedProcessResult } from "./managed-process.js";
import { MCPManager } from "./mcp.js";
import { applyWorkspacePatch, type ApplyPatchResult } from "./patch.js";
import {
  formatPlanForExecution,
  PLAN_STATE_ENTRY,
  planWidgetLines,
  registerPlanTool,
  restorePlanState,
  type PlanState,
} from "./plan.js";
import { discoverProjectCommands } from "./project-profile.js";
import type { DSCodeRuntimeOptions } from "./runtime-options.js";
import { executeSandboxedCommand, sandboxDescription } from "./sandbox.js";
import { formatStatusReport } from "./status.js";
import { registerSubagentTools } from "./subagents.js";
import { createCodingTools } from "./tools.js";
import { registerCodingTui } from "./tui-experience.js";
import { Workspace } from "./workspace.js";

const CHECKPOINT_ENTRY = "dscode-checkpoint";
const CHECKPOINT_UNDO_ENTRY = "dscode-checkpoint-undone";
const DIFF_ENTRY = "dscode-diff";

const planAllowedTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "read_file",
  "list_files",
  "search_files",
  "language_diagnostics",
  "exec_command",
  "write_stdin",
  "update_plan",
]);
const askWithoutPromptTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "read_file",
  "list_files",
  "search_files",
  "language_diagnostics",
]);

const execCommandParameters = Type.Object({
  cmd: Type.String({
    minLength: 1,
    description: "Shell command to execute from the current workspace",
  }),
  yield_time_ms: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 30_000,
      description: "Return after this many milliseconds if the process is still running",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 1_000,
      maximum: 600_000,
      description: "Terminate the process after this many milliseconds",
    }),
  ),
});

const writeStdinParameters = Type.Object({
  process_id: Type.String({ minLength: 1 }),
  chars: Type.Optional(Type.String({ description: "Characters to write to stdin" })),
  yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })),
  terminate: Type.Optional(Type.Boolean({ description: "Terminate this process" })),
});

const applyPatchParameters = Type.Object({
  input: Type.String({
    minLength: 1,
    description: "A complete *** Begin Patch / *** End Patch patch",
  }),
});

export function createDSCodeExtension(options: DSCodeRuntimeOptions): InlineExtension {
  return {
    name: "dscode",
    factory(pi) {
      const processes = new ManagedProcessRegistry();
      const mcp = new MCPManager();
      let permission: PermissionMode = options.permission;
      let permissionBeforePlan: Exclude<PermissionMode, "plan"> =
        options.permission === "plan" ? "auto" : options.permission;
      const checkpoints: PatchCheckpoint[] = [];
      const undone = new Set<string>();
      let toolsBeforePlan: string[] | undefined;
      let projectCommands: string[] = [];
      let lastAgentFailed = false;
      let planState: PlanState | undefined;
      let lastOfferedPlanRevision = 0;

      registerDeepSeekProvider(pi, options);
      registerNaturalExit(pi);
      registerCommandTools(pi, options, processes, () => permission);
      registerPatchTool(pi, checkpoints);
      if (options.harness === "safe") {
        registerSafeHarness(pi, options.cwd);
        registerDiagnosticsTool(
          pi,
          options,
          () => permission === "plan" ? "read-only" : options.sandbox,
        );
      }
      registerSubagentTools(pi, options);
      registerEntryRenderers(pi);
      registerPlanTool(
        pi,
        () => planState,
        (nextPlan, ctx) => {
          planState = nextPlan;
          ctx.ui.setWidget("dscode-plan", planWidgetLines(planState, ctx));
        },
      );
      registerCodingTui(pi, options, () => permission);

      const updateStatus = (ctx: ExtensionContext): void => {
        const sandbox = permission === "plan" ? "read-only" : options.sandbox;
        const status = `DSCode · ${permission} · ${sandboxDescription({ mode: sandbox, network: options.network })}`;
        ctx.ui.setStatus(
          "dscode",
          permission === "plan"
            ? ctx.ui.theme.fg("warning", status)
            : brandBlue(status, ctx.ui.theme),
        );
        ctx.ui.setTitle(`DSCode — ${ctx.cwd}`);
        ctx.ui.setWidget("dscode-plan", planWidgetLines(planState, ctx));
      };

      const applyPermissionTools = (): void => {
        if (permission === "plan") {
          const active = pi.getActiveTools();
          if (toolsBeforePlan === undefined) {
            toolsBeforePlan = active;
          } else {
            toolsBeforePlan = [...new Set([...toolsBeforePlan, ...active])];
          }
          pi.setActiveTools(
            [...new Set([...toolsBeforePlan.filter((tool) => planAllowedTools.has(tool)), "update_plan"])],
          );
          return;
        }
        if (toolsBeforePlan !== undefined) {
          pi.setActiveTools(toolsBeforePlan);
          toolsBeforePlan = undefined;
        }
      };

      pi.on("before_provider_request", (event, ctx) => {
        if (ctx.model?.provider !== "deepseek" || options.transport !== "responses") return;
        return optimizeDeepSeekResponsesPayload(event.payload, { webSearch: options.webSearch });
      });

      pi.on("session_start", async (_event, ctx) => {
        checkpoints.length = 0;
        undone.clear();
        projectCommands = await discoverProjectCommands(ctx.cwd);
        restoreCheckpointState(ctx.sessionManager.getBranch(), checkpoints, undone);
        planState = restorePlanState(ctx.sessionManager.getBranch());
        lastOfferedPlanRevision = planState?.revision ?? 0;
        updateStatus(ctx);
        ctx.ui.setHiddenThinkingLabel("DeepSeek V4 Flash 正在思考");
        const staleMcpTools = new Set(mcp.toolNames());
        if (staleMcpTools.size > 0) {
          pi.setActiveTools(
            pi.getActiveTools().filter((tool) => !staleMcpTools.has(tool)),
          );
          toolsBeforePlan = toolsBeforePlan?.filter((tool) => !staleMcpTools.has(tool));
        }
        await mcp.close();
        try {
          await mcp.connectConfigured(pi, ctx);
        } catch (error) {
          ctx.ui.notify(`MCP initialization failed: ${(error as Error).message}`, "warning");
        }
        const intendedTools = options.toolsExplicit
          ? options.activeTools
          : [...new Set([...options.activeTools, ...mcp.toolNames()])];
        pi.setActiveTools(intendedTools);
        toolsBeforePlan = undefined;
        applyPermissionTools();
      });

      pi.on("session_shutdown", async () => {
        processes.dispose();
        await mcp.close();
      });

      pi.on("before_agent_start", async (event) => {
        lastAgentFailed = false;
        const systemPrompt = `${event.systemPrompt}\n\n${engineeringInstructions(options, projectCommands)}`;
        if (permission !== "plan") return { systemPrompt };
        return {
          systemPrompt,
          message: {
            customType: "dscode-plan-context",
            display: false,
            content: [
              "[PLAN MODE ACTIVE]",
              "Explore and reason only. File mutation tools are unavailable.",
              "Commands run in a read-only OS sandbox with network disabled unless explicitly enabled.",
              "Use update_plan to publish a concrete implementation plan after exploration.",
              "Include validation and important risks in the plan steps or explanation.",
              "Do not claim to have changed or tested anything you could not actually run.",
            ].join("\n"),
          },
        };
      });

      pi.on("tool_call", async (event, ctx) => {
        if (
          event.toolName === "bash" ||
          event.toolName === "run_command" ||
          event.toolName === "edit" ||
          event.toolName === "write"
        ) {
          return {
            block: true,
            reason:
              event.toolName === "bash" || event.toolName === "run_command"
                ? "This shell tool bypasses DSCode's managed OS sandbox. Use exec_command instead."
                : "This write tool bypasses DSCode checkpoints. Use apply_patch instead.",
          };
        }
        if (permission === "plan" && !planAllowedTools.has(event.toolName)) {
          return {
            block: true,
            reason: `Plan mode does not allow ${event.toolName}. Run /plan to leave plan mode.`,
          };
        }
        const externalMcp = event.toolName.startsWith("mcp__");
        if (permission !== "ask" && !(permission === "auto" && externalMcp)) return;
        if (!externalMcp && askWithoutPromptTools.has(event.toolName)) return;
        if (
          event.toolName === "write_stdin" &&
          isRecord(event.input) &&
          typeof event.input.chars !== "string" &&
          event.input.terminate !== true
        ) {
          return;
        }
        if (!ctx.hasUI) {
          return {
            block: true,
            reason:
              "This action requires an interactive approval UI. Use --permission full for an explicitly trusted non-interactive run.",
          };
        }
        if (
          event.toolName === "apply_patch" &&
          isRecord(event.input) &&
          typeof event.input.input === "string"
        ) {
          for (const section of patchApprovalSections(event.input.input)) {
            const approved = await ctx.ui.confirm(`Apply ${section.file}?`, section.patch);
            if (!approved) return { block: true, reason: `Denied ${section.file} by user` };
          }
        } else {
          const approved = await ctx.ui.confirm(
            `Allow ${event.toolName}?`,
            approvalSummary(event.toolName, event.input),
          );
          if (!approved) return { block: true, reason: "Denied by user" };
        }
      });

      pi.on("user_bash", (_event, _ctx) => {
        const operations: BashOperations = {
          exec: (command, cwd, execution) =>
            executeSandboxedCommand(
              command,
              cwd,
              {
                mode: permission === "plan" ? "read-only" : options.sandbox,
                network: options.network,
              },
              execution,
            ),
        };
        return { operations };
      });

      pi.on("message_end", (event) => {
        if (event.message.role !== "assistant") return;
        lastAgentFailed =
          "stopReason" in event.message &&
          (event.message.stopReason === "error" || event.message.stopReason === "aborted");
      });

      pi.on("agent_end", async (_event, ctx) => {
        if (
          permission !== "plan" ||
          ctx.mode !== "tui" ||
          !planState ||
          planState.revision <= lastOfferedPlanRevision
        ) {
          return;
        }
        lastOfferedPlanRevision = planState.revision;
        ctx.ui.setWorkingVisible(false);
        let choice: string | undefined;
        try {
          choice = await ctx.ui.select("Plan ready — what next?", [
            "Execute the plan",
            "Stay in plan mode",
            "Refine the plan",
          ]);
        } finally {
          ctx.ui.setWorkingVisible(true);
        }
        if (choice === "Execute the plan") {
          permission = permissionBeforePlan;
          applyPermissionTools();
          updateStatus(ctx);
          pi.appendEntry("dscode-permission", { permission });
          pi.sendUserMessage(
            [
              "Execute the approved plan below. Keep update_plan statuses current as you work.",
              "Maintain at most one in_progress step and only mark completed after verification.",
              "",
              formatPlanForExecution(planState),
            ].join("\n"),
            { deliverAs: "followUp" },
          );
        } else if (choice === "Refine the plan") {
          const refinement = await ctx.ui.editor("How should the plan change?", "");
          if (refinement?.trim()) {
            pi.sendUserMessage(
              `Refine the current plan using update_plan. Requested changes:\n${refinement.trim()}`,
              { deliverAs: "followUp" },
            );
          }
        }
      });

      pi.on("agent_settled", (_event, ctx) => {
        if (ctx.mode === "json" || ctx.mode === "print") {
          process.exitCode = lastAgentFailed ? 1 : 0;
        }
      });

      pi.registerCommand("plan", {
        description: "Toggle read-only planning; use /plan show or /plan clear",
        handler: async (args, ctx) => {
          const action = args.trim();
          if (action === "show") {
            ctx.ui.notify(
              planState ? formatPlanForExecution(planState) : "No structured plan is available.",
              "info",
            );
            return;
          }
          if (action === "clear") {
            planState = undefined;
            pi.appendEntry(PLAN_STATE_ENTRY, { cleared: true, updatedAt: new Date().toISOString() });
            ctx.ui.setWidget("dscode-plan", undefined);
            ctx.ui.notify("Structured plan cleared.", "info");
            return;
          }
          if (action) {
            ctx.ui.notify("Expected /plan, /plan show, or /plan clear", "warning");
            return;
          }
          if (permission === "plan") {
            permission = permissionBeforePlan;
          } else {
            permissionBeforePlan = permission;
            permission = "plan";
          }
          applyPermissionTools();
          updateStatus(ctx);
          pi.appendEntry("dscode-permission", { permission });
          ctx.ui.notify(`Permission mode: ${permission}`, "info");
        },
      });

      pi.registerCommand("permissions", {
        description: "Show or set plan|ask|auto|full",
        handler: async (args, ctx) => {
          if (!args.trim()) {
            ctx.ui.notify(
              `permission: ${permission}\nsandbox: ${options.sandbox}\nnetwork: ${options.network ? "enabled" : "blocked"}`,
              "info",
            );
            return;
          }
          const parsed = permissionSchema.safeParse(args.trim());
          if (!parsed.success) {
            ctx.ui.notify("Expected /permissions plan|ask|auto|full", "warning");
            return;
          }
          if (parsed.data === "plan" && permission !== "plan") {
            permissionBeforePlan = permission;
          }
          permission = parsed.data;
          applyPermissionTools();
          updateStatus(ctx);
          pi.appendEntry("dscode-permission", { permission });
          ctx.ui.notify(`Permission mode: ${permission}`, "info");
        },
      });

      pi.registerCommand("effort", {
        description: "Show or set DeepSeek thinking effort: low|high|max",
        handler: async (args, ctx) => {
          const value = args.trim();
          if (!value) {
            ctx.ui.notify(`Thinking effort: ${pi.getThinkingLevel()}`, "info");
            return;
          }
          if (!["low", "high", "max"].includes(value)) {
            ctx.ui.notify("Expected /effort low|high|max", "warning");
            return;
          }
          pi.setThinkingLevel(value as ThinkingLevel);
          ctx.ui.notify(`Thinking effort: ${pi.getThinkingLevel()}`, "info");
        },
      });

      pi.registerCommand("undo", {
        description: "Restore the last patch checkpoint; add --force to override conflicts",
        handler: async (args, ctx) => {
          const checkpoint = [...checkpoints]
            .reverse()
            .find((candidate) => !undone.has(candidate.id));
          if (!checkpoint) {
            ctx.ui.notify("No patch checkpoint is available to undo.", "info");
            return;
          }
          const force = args.trim() === "--force";
          if (ctx.hasUI) {
            const confirmed = await ctx.ui.confirm(
              `Undo ${checkpoint.id}?`,
              `${checkpoint.before.map((file) => file.path).join("\n")}\n\nChanges made after this checkpoint are protected unless --force is used.`,
            );
            if (!confirmed) return;
          }
          const workspace = new Workspace(ctx.cwd);
          await workspace.initialize();
          try {
            const restored = await restoreCheckpoint(workspace, checkpoint, force);
            undone.add(checkpoint.id);
            pi.appendEntry(CHECKPOINT_UNDO_ENTRY, {
              checkpointId: checkpoint.id,
              restoredAt: new Date().toISOString(),
            });
            ctx.ui.notify(`Restored ${restored.join(", ")}`, "info");
          } catch (error) {
            ctx.ui.notify((error as Error).message, "error");
          }
        },
      });

      pi.registerCommand("checkpoints", {
        description: "List durable patch checkpoints in the current branch",
        handler: async (_args, ctx) => {
          if (checkpoints.length === 0) {
            ctx.ui.notify("No patch checkpoints in this branch.", "info");
            return;
          }
          ctx.ui.notify(
            checkpoints
              .map(
                (checkpoint) =>
                  `${undone.has(checkpoint.id) ? "↶" : "●"} ${checkpoint.id}  ${checkpoint.before
                    .map((file) => file.path)
                    .join(", ")}`,
              )
              .join("\n"),
            "info",
          );
        },
      });

      pi.registerCommand("diff", {
        description: "Show the latest patch diff in the transcript",
        handler: async (_args, ctx) => {
          const checkpoint = [...checkpoints]
            .reverse()
            .find((candidate) => !undone.has(candidate.id));
          if (!checkpoint) {
            ctx.ui.notify("No active patch diff is available.", "info");
            return;
          }
          pi.appendEntry(DIFF_ENTRY, {
            checkpointId: checkpoint.id,
            patch: checkpoint.patch,
          });
        },
      });

      pi.registerCommand("jobs", {
        description: "List managed background command processes",
        handler: async (_args, ctx) => {
          const jobs = processes.list();
          ctx.ui.notify(
            jobs.length
              ? jobs
                  .map(
                    (job) =>
                      `${job.running ? "●" : "○"} ${job.processId} — ${job.sandbox}`,
                  )
                  .join("\n")
              : "No managed background processes.",
            "info",
          );
        },
      });

      pi.registerCommand("mcp", {
        description: "Show MCP server and tool status",
        handler: async (_args, ctx) => ctx.ui.notify(mcp.status(), "info"),
      });

      pi.registerCommand("status", {
        description: "Show model, access, context, cache, token, and cost details",
        handler: async (_args, ctx) => {
          const usage = ctx.getContextUsage();
          const git = await pi
            .exec("git", ["branch", "--show-current"], { cwd: ctx.cwd })
            .catch(() => undefined);
          ctx.ui.notify(
            formatStatusReport({
              provider: ctx.model?.provider ?? "deepseek",
              model: ctx.model?.id ?? options.modelId,
              transport: options.transport,
              effort: ctx.thinkingLevel ?? pi.getThinkingLevel(),
              permission,
              sandbox: sandboxDescription({
                mode: permission === "plan" ? "read-only" : options.sandbox,
                network: options.network,
              }),
              network: options.network,
              cwd: ctx.cwd,
              branch: git?.stdout.trim() || undefined,
              sessionName: ctx.sessionManager.getSessionName(),
              sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
              context: usage
                ? {
                    tokens: usage.tokens ?? 0,
                    contextWindow: usage.contextWindow,
                    percent: usage.percent,
                  }
                : undefined,
              entries: ctx.sessionManager.getEntries(),
            }),
            "info",
          );
        },
      });

      pi.registerCommand("doctor", {
        description: "Show DSCode runtime diagnostics",
        handler: async (_args, ctx) => {
          const usage = ctx.getContextUsage();
          ctx.ui.notify(
            [
              `model: ${ctx.model?.provider ?? "?"}/${ctx.model?.id ?? "?"}`,
              `transport: ${options.transport}`,
              `thinking: ${ctx.thinkingLevel ?? pi.getThinkingLevel()}`,
              `permission: ${permission}`,
              `sandbox: ${sandboxDescription({
                mode: permission === "plan" ? "read-only" : options.sandbox,
                network: options.network,
              })}`,
              `workspace trusted: ${ctx.isProjectTrusted() ? "yes" : "no"}`,
              `session: ${ctx.sessionManager.getSessionFile() ?? "memory only"}`,
              `tools: ${pi.getActiveTools().join(", ")}`,
              usage
                ? `context: ${usage.tokens?.toLocaleString() ?? "?"}/${usage.contextWindow.toLocaleString()}`
                : "context: unavailable",
              `checkpoints: ${checkpoints.length - undone.size} active`,
              `mcp:\n${mcp.status()}`,
            ].join("\n"),
            "info",
          );
        },
      });

      registerHooks(pi, options, () =>
        permission === "plan" ? "read-only" : options.sandbox,
      );
    },
  };
}

function registerDeepSeekProvider(pi: ExtensionAPI, options: DSCodeRuntimeOptions): void {
  const api = options.transport === "responses" ? "openai-responses" : "openai-completions";
  pi.registerProvider("deepseek", {
    name: "DeepSeek",
    baseUrl: options.baseUrl,
    apiKey: "$DEEPSEEK_API_KEY",
    api,
    authHeader: true,
    models: [
      {
        id: options.modelId,
        name: "DeepSeek V4 Flash",
        api,
        reasoning: true,
        input: ["text"],
        cost: {
          input: 0.14,
          output: 0.28,
          cacheRead: 0.0028,
          cacheWrite: 0,
        },
        contextWindow: 1_048_576,
        maxTokens: 384_000,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: "high",
          high: "high",
          xhigh: "high",
          max: "max",
        },
        compat:
          options.transport === "responses"
            ? {
                supportsDeveloperRole: true,
                supportsLongCacheRetention: false,
                supportsStrictMode: false,
                supportsOpenAIGrammarTools: true,
                sessionAffinityFormat: "openai-nosession",
              }
            : {
                supportsStore: false,
                supportsDeveloperRole: false,
                requiresReasoningContentOnAssistantMessages: true,
                thinkingFormat: "deepseek",
              },
      },
    ],
  });
}

function registerCommandTools(
  pi: ExtensionAPI,
  options: DSCodeRuntimeOptions,
  registry: ManagedProcessRegistry,
  getPermission: () => PermissionMode,
): void {
  pi.registerTool({
    name: "exec_command",
    label: "Execute command",
    description:
      "Run a shell command in a managed OS sandbox. Long-running commands yield a process_id for write_stdin.",
    promptSnippet: "exec_command: run tests, builds, git, and other shell commands in an OS sandbox",
    promptGuidelines: [
      "Use rg or rg --files first for repository search.",
      "Use focused checks first, then broader validation.",
      "When a process is still running, use write_stdin with its process_id.",
    ],
    parameters: execCommandParameters,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      const mode = getPermission() === "plan" ? "read-only" : options.sandbox;
      const result = await registry.start(params.cmd, {
        cwd: ctx.cwd,
        sandbox: { mode, network: options.network },
        yieldTimeMs: params.yield_time_ms ?? 10_000,
        timeoutMs: params.timeout_ms ?? 120_000,
        ...(signal ? { signal } : {}),
      });
      return {
        content: [{ type: "text", text: formatManagedResult(result) }],
        details: result,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("exec"))} ${theme.fg("muted", args.cmd)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "write_stdin",
    label: "Write to process",
    description:
      "Write characters to, poll, or terminate a managed process returned by exec_command.",
    promptSnippet: "write_stdin: interact with or poll a managed background process",
    parameters: writeStdinParameters,
    executionMode: "sequential",
    async execute(_id, params) {
      const result = await registry.interact(params.process_id, {
        ...(params.chars === undefined ? {} : { chars: params.chars }),
        yieldTimeMs: params.yield_time_ms ?? 5_000,
        terminate: params.terminate ?? false,
      });
      return {
        content: [{ type: "text", text: formatManagedResult(result) }],
        details: result,
      };
    },
  });
}

function registerPatchTool(pi: ExtensionAPI, checkpoints: PatchCheckpoint[]): void {
  pi.registerTool({
    name: "apply_patch",
    label: "Apply patch",
    description:
      "Apply an atomic, workspace-confined patch. Every successful patch creates a durable checkpoint that /undo can restore.",
    promptSnippet: "apply_patch: atomically add, update, move, or delete workspace files",
    promptGuidelines: [
      "Use apply_patch for file changes; keep each patch focused and reviewable.",
      "Never report a change as complete before running relevant validation.",
    ],
    parameters: applyPatchParameters,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const workspace = new Workspace(ctx.cwd);
      await workspace.initialize();
      let applied: ApplyPatchResult | undefined;
      const checkpoint = await capturePatchCheckpoint(workspace, params.input, async () => {
        applied = await applyWorkspacePatch(workspace, params.input);
      });
      checkpoints.push(checkpoint);
      pi.appendEntry(CHECKPOINT_ENTRY, checkpoint);
      const result = applied!;
      return {
        content: [
          {
            type: "text",
            text: [
              `Applied checkpoint ${checkpoint.id}.`,
              `files: ${result.files.join(", ")}`,
              `diff: +${result.additions} -${result.deletions}`,
              "Use /diff to inspect or /undo to restore this checkpoint.",
            ].join("\n"),
          },
        ],
        details: { ...result, checkpointId: checkpoint.id, patch: params.input },
      };
    },
    renderCall(args, theme, context) {
      const summary = summarizePatch(args.input);
      return new Text(
        [
          `${theme.fg("toolTitle", theme.bold("apply_patch"))} ${theme.fg("muted", summary)}`,
          ...(context.expanded ? [colorPatch(args.input, theme)] : []),
        ].join("\n"),
        0,
        0,
      );
    },
  });
}

function registerSafeHarness(pi: ExtensionAPI, initialCwd: string): void {
  const initialWorkspace = new Workspace(initialCwd);
  const safeTools = createCodingTools(initialWorkspace, "safe").filter((tool) =>
    ["read_file", "list_files", "search_files"].includes(tool.name),
  );
  for (const template of safeTools) {
    const definition = {
      ...template,
      async execute(
        id: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: Parameters<AgentTool["execute"]>[3],
        ctx: ExtensionContext,
      ) {
        const workspace = new Workspace(ctx.cwd);
        await workspace.initialize();
        const live = createCodingTools(workspace, "safe").find(
          (tool) => tool.name === template.name,
        );
        if (!live) throw new Error(`Tool disappeared: ${template.name}`);
        return live.execute(id, params as never, signal, onUpdate);
      },
    } as ToolDefinition;
    pi.registerTool(definition);
  }
}

function registerEntryRenderers(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<PatchCheckpoint>(
    CHECKPOINT_ENTRY,
    (entry, { expanded }, theme) => {
      if (!entry.data) return undefined;
      const files = entry.data.before.map((file) => file.path).join(", ");
      return new Text(
        [
          `${theme.fg("success", "✓ checkpoint")} ${entry.data.id} ${theme.fg("muted", files)}`,
          ...(expanded ? [colorPatch(entry.data.patch, theme)] : []),
        ].join("\n"),
        0,
        0,
      );
    },
  );
  pi.registerEntryRenderer<{ checkpointId: string; restoredAt: string }>(
    CHECKPOINT_UNDO_ENTRY,
    (entry, _options, theme) =>
      entry.data
        ? new Text(
            `${theme.fg("warning", "↶ undo")} ${entry.data.checkpointId}`,
            0,
            0,
          )
        : undefined,
  );
  pi.registerEntryRenderer<{ checkpointId: string; patch: string }>(
    DIFF_ENTRY,
    (entry, _options, theme) =>
      entry.data
        ? new Text(
            `${brandBlue(`diff ${entry.data.checkpointId}`, theme)}\n${colorPatch(entry.data.patch, theme)}`,
            0,
            0,
          )
        : undefined,
  );
}

function restoreCheckpointState(
  entries: SessionEntry[],
  checkpoints: PatchCheckpoint[],
  undone: Set<string>,
): void {
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    if (entry.customType === CHECKPOINT_ENTRY && isCheckpoint(entry.data)) {
      checkpoints.push(entry.data);
    } else if (
      entry.customType === CHECKPOINT_UNDO_ENTRY &&
      isRecord(entry.data) &&
      typeof entry.data.checkpointId === "string"
    ) {
      undone.add(entry.data.checkpointId);
    }
  }
}

function isCheckpoint(value: unknown): value is PatchCheckpoint {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.patch === "string" &&
    Array.isArray(value.before) &&
    Array.isArray(value.after)
  );
}

function approvalSummary(tool: string, input: unknown): string {
  if (!isRecord(input)) return `Tool: ${tool}`;
  if (tool === "apply_patch" && typeof input.input === "string") {
    return `${summarizePatch(input.input)}\n\n${input.input.slice(0, 8_000)}`;
  }
  if (tool === "exec_command" && typeof input.cmd === "string") return input.cmd;
  return JSON.stringify(input, null, 2).slice(0, 8_000);
}

function summarizePatch(input: string): string {
  const files = input
    .split("\n")
    .flatMap((line) => {
      const match = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
  const additions = input.split("\n").filter((line) => line.startsWith("+")).length;
  const deletions = input.split("\n").filter((line) => line.startsWith("-")).length;
  return `${[...new Set(files)].join(", ") || "patch"} (+${additions} -${deletions})`;
}

function patchApprovalSections(input: string): Array<{ file: string; patch: string }> {
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  const sections: Array<{ file: string; lines: string[] }> = [];
  let current: { file: string; lines: string[] } | undefined;
  for (const line of lines) {
    const match = /^\*\*\* (?:Add File|Delete File|Update File): (.+)$/.exec(line);
    if (match?.[1]) {
      if (current) sections.push(current);
      current = { file: match[1], lines: [line] };
      continue;
    }
    if (!current || line === "*** Begin Patch" || line === "*** End Patch") continue;
    current.lines.push(line);
  }
  if (current) sections.push(current);
  if (sections.length === 0) {
    return [{ file: "patch", patch: input.slice(0, 8_000) }];
  }
  return sections.map((section) => ({
    file: section.file,
    patch: section.lines.join("\n").slice(0, 8_000),
  }));
}

function colorPatch(
  patch: string,
  theme: ExtensionContext["ui"]["theme"],
): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
      if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
      return theme.fg("toolDiffContext", line);
    })
    .join("\n");
}

function formatManagedResult(result: ManagedProcessResult): string {
  return [
    result.output.trimEnd(),
    `process_id: ${result.processId}`,
    `status: ${result.running ? "running" : "completed"}`,
    ...(result.running ? ["Use write_stdin to poll or interact."] : []),
    ...(result.exitCode === undefined ? [] : [`exit_code: ${result.exitCode}`]),
    ...(result.timedOut ? ["timed_out: true"] : []),
    `sandbox: ${result.sandbox}`,
  ].join("\n");
}

function engineeringInstructions(
  options: DSCodeRuntimeOptions,
  projectCommands: string[],
): string {
  const instructions = [
    "# DSCode engineering contract",
    "- Work to a verified repository outcome: inspect first, make focused changes, run the narrowest relevant checks, then broaden validation in proportion to risk.",
    "- When a check fails, diagnose the evidence and keep repairing while a safe in-scope next step remains. Never hide, truncate in prose, or reinterpret a failing exit code as success.",
    "- Before changing files below nested directories, discover applicable AGENTS.md and CLAUDE.md files and obey them from broadest to most specific scope.",
    "- Preserve user changes and unrelated dirty-worktree edits. Never use destructive Git recovery commands unless explicitly requested.",
    "- Prefer rg and rg --files for search. Use apply_patch for focused writes so changes are checkpointed and undoable.",
    "- Use update_plan for complex multi-step work. Keep at most one step in_progress and update statuses as verified work advances.",
    "- Use delegate only for genuinely independent work. The parent agent owns integration and final verification.",
    `- Command network access is ${options.network ? "enabled" : "disabled"}; do not work around this boundary.`,
    "- Keep the final answer evidence-based: changed files, checks actually run, failures or limitations, and the shortest useful next action.",
  ];
  if (projectCommands.length > 0) {
    instructions.push(
      "- Detected project commands (inspect their definitions before relying on them):",
      ...projectCommands.map((command) => `  - ${command}`),
    );
  }
  return instructions.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
