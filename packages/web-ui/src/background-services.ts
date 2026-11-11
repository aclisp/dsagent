import path from "node:path";
import { createConversationAliasRegistry, type ChatProvider } from "@aclisp/dsagent-chat-client";
import type { SessionPort } from "@aclisp/dsagent-http-adapter";
import { acquireBackgroundResources } from "./background-resources.ts";
import { bindWebUiChatProvider, type WebUiChatProviderBinding } from "./chat-provider.ts";
import { createTaskScheduler, type ScheduledSourceDeliveryPort, type TaskScheduler, type TaskSchedulerLogger } from "./task-scheduler.ts";

export interface WebBackgroundServices {
  /** Synchronous commit: only called after the intended Session is restored. */
  start(): void;
  status(): string;
  close(): Promise<void>;
}

interface Entry {
  provider: ChatProvider;
  binding?: WebUiChatProviderBinding;
  admit(allowed: boolean): void;
  unsubscribeStatus?: () => void;
  failed: boolean;
  activate?: () => void;
}

export async function prepareBackgroundServices(options: {
  workspaceId: string;
  workspacePath: string;
  sessionPort: SessionPort;
  providers: readonly ChatProvider[];
  timezone: string;
  strict: boolean;
  logger: TaskSchedulerLogger;
  coordinationDirectory?: string;
  onProviderStarted?: (id: string) => void;
  onNotice?: (message: string) => void;
  onOwnershipLost(error: Error): void;
}): Promise<WebBackgroundServices> {
  const entries: Entry[] = [];
  let scheduler: TaskScheduler | undefined;
  let release: (() => Promise<void>) | undefined;
  let started = false;
  let prepared = false;
  let ownershipLost: Error | undefined;
  let closing: Promise<void> | undefined;
  const checkOwnership = () => { if (ownershipLost) throw ownershipLost; };
  const latest = new Map<string, string>();
  const changed = (id: string, status: string) => {
    if (latest.get(id) === status) return;
    latest.set(id, status);
    if (started && /failed|paused|disconnected|reconnecting|invalid|unavailable/u.test(status)) {
      try { options.onNotice?.(`${id}: ${status}`); } catch { /* Diagnostic observer. */ }
    }
  };
  const closeEntry = async (entry: Entry) => {
    entry.unsubscribeStatus?.();
    try { entry.binding?.dispose(); }
    finally {
      // Abort the Provider before releasing held inbound listeners. WeChat then
      // retains these unadmitted inbox records for the next start.
      let disposal: void | Promise<void>;
      try { disposal = entry.provider.dispose?.(); }
      finally { entry.admit(false); }
      await disposal;
    }
  };
  const close = (): Promise<void> => closing ??= (async () => {
    const results = await Promise.allSettled([
      scheduler?.dispose(), ...entries.map(entry => closeEntry(entry)),
    ]);
    try {
      for (const result of results) if (result.status === "rejected") {
        options.logger.error({}, "Background service cleanup failed");
      }
    } finally {
      try { await release?.(); }
      catch { options.logger.error({}, "Service resource release failed"); }
    }
  })();
  try {
    release = await acquireBackgroundResources({
      workspace: options.workspacePath,
      accounts: options.providers.flatMap(provider => provider.resourceKey
        ? [{ key: provider.resourceKey, label: `${provider.providerId} account` }] : []),
      ...(options.coordinationDirectory ? { directory: options.coordinationDirectory } : {}),
      onCompromised: error => {
        ownershipLost = error;
        if (prepared) { options.onOwnershipLost(error); void close().catch(() => undefined); }
      },
    });
    checkOwnership();
    const registry = await createConversationAliasRegistry({
      filePath: path.join(options.workspacePath, ".dscode", "conversations.json"),
    });
    checkOwnership();
    for (const provider of options.providers) {
      let admit!: (allowed: boolean) => void;
      const admission = new Promise<boolean>(resolve => { admit = resolve; });
      const entry: Entry = { provider, admit, failed: false };
      entries.push(entry);
      try {
        entry.binding = bindWebUiChatProvider({
          workspaceId: options.workspaceId, sessionPort: options.sessionPort,
          provider, conversationRegistry: registry, waitForAdmission: () => admission,
        });
        if (provider.subscribeStatus) entry.unsubscribeStatus = provider.subscribeStatus(status => changed(provider.providerId, status));
        if (provider.prepare) entry.activate = await provider.prepare();
        else await provider.start?.();
        checkOwnership();
        changed(provider.providerId, provider.getStatus?.() ?? "initialized");
        options.onProviderStarted?.(provider.providerId);
      } catch (error) {
        entry.failed = true;
        changed(provider.providerId, "failed (local initialization)");
        if (options.strict) throw new Error(`Could not initialize ${provider.providerId}`, { cause: error });
        await closeEntry(entry);
        options.logger.error({ providerId: provider.providerId }, "Chat Provider isolated after startup failure");
      }
    }
    const active = entries.filter(entry => !entry.failed);
    const sourceDelivery: ScheduledSourceDeliveryPort = {
      registerTurnForSourceDelivery(turnId, alias, listener) {
        const resolved = registry.resolveConversation(alias);
        if (resolved.status !== "resolved") return "unavailable";
        const entry = active.find(entry => entry.provider.providerId === resolved.reference.providerId);
        if (!entry) return "unavailable";
        try { return entry.binding!.registerTurnForDelivery(turnId, resolved.reference, listener) ? "registered" : "failed"; }
        catch { return "failed"; }
      },
    };
    scheduler = await createTaskScheduler({
      workspaceId: options.workspaceId, workspacePath: options.workspacePath,
      sessionPort: options.sessionPort, timezone: options.timezone, logger: options.logger,
      startPaused: true, strictInitialConfig: options.strict,
      onStatusChange: () => { if (scheduler) changed("scheduler", scheduler.getStatus()); },
      ...(active.length ? { sourceDelivery } : {}),
    });
    checkOwnership();
    prepared = true;
    return {
      start() {
        checkOwnership();
        if (closing) throw new Error("Background services are closing");
        if (started) return;
        scheduler!.start();
        for (const entry of active) entry.activate?.();
        started = true;
        for (const entry of active) entry.admit(true);
      },
      status: () => [
        `Scheduler: ${scheduler!.getStatus()}`,
        ...entries.map(entry => `${entry.provider.providerId}: ${entry.failed ? latest.get(entry.provider.providerId) : entry.provider.getStatus?.() ?? "initialized"}`),
        ...(entries.length ? [] : ["IM: not configured"]),
      ].join("\n"),
      close,
    };
  } catch (error) { await close(); throw error; }
}
