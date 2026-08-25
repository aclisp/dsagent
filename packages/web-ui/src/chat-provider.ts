import {
  createHeadlessChatClient,
  type ChatClientLogger,
  type ChatProvider,
  type ProactiveDeliveryListener,
} from "@thinkany/dscode-chat-client";
import type { SessionPort } from "@thinkany/dscode-http-adapter/session-port";

export interface BindWebUiChatProviderOptions {
  workspaceId: string;
  sessionPort: SessionPort;
  provider: ChatProvider;
  logger?: ChatClientLogger;
}

export interface WebUiChatProviderBinding {
  registerTurnForGroupDelivery(
    turnId: string,
    listener?: ProactiveDeliveryListener,
  ): boolean;
  dispose(): void;
}

export function bindWebUiChatProvider(
  options: BindWebUiChatProviderOptions,
): WebUiChatProviderBinding {
  const client = createHeadlessChatClient({
    workspaceId: options.workspaceId,
    groupChatId: options.provider.groupChatId,
    sessionPort: options.sessionPort,
    delivery: options.provider,
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });

  let unsubscribe: () => void;
  try {
    unsubscribe = options.provider.subscribe((message) =>
      client.handleMessage(message),
    );
  } catch (error) {
    client.dispose();
    throw error;
  }

  let disposed = false;
  return {
    registerTurnForGroupDelivery(turnId, listener) {
      return client.registerTurnForGroupDelivery(turnId, listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe();
      } finally {
        client.dispose();
      }
    },
  };
}
