import {
  createHeadlessChatClient,
  type ChatClientLogger,
  type ChatConversation,
  type ChatProvider,
  type ProactiveDeliveryListener,
} from "@thinkany/dscode-chat-client";
import type { ConversationAliasRegistry } from "@thinkany/dscode-chat-client";
import type { SessionPort } from "@thinkany/dscode-http-adapter/session-port";

export interface BindWebUiChatProviderOptions {
  workspaceId: string;
  sessionPort: SessionPort;
  provider: ChatProvider;
  conversationRegistry: ConversationAliasRegistry;
  logger?: ChatClientLogger;
}

export interface WebUiChatProviderBinding {
  registerTurnForDelivery(
    turnId: string,
    conversation: ChatConversation,
    listener?: ProactiveDeliveryListener,
  ): boolean;
  dispose(): void;
}

export function bindWebUiChatProvider(
  options: BindWebUiChatProviderOptions,
): WebUiChatProviderBinding {
  const client = createHeadlessChatClient({
    workspaceId: options.workspaceId,
    providerId: options.provider.providerId,
    conversationRegistry: options.conversationRegistry,
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
    registerTurnForDelivery(turnId, conversation, listener) {
      return client.registerTurnForDelivery(turnId, conversation, listener);
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
