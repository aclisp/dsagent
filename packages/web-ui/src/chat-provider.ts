import {
  createHeadlessChatClient,
  type ChatClientLogger,
  type ChatDelivery,
  type ChatMessageHandlingResult,
  type InboundGroupMessage,
} from "@thinkany/dscode-chat-client";
import type { SessionPort } from "@thinkany/dscode-http-adapter/session-port";

export type WebUiChatProviderListener = (
  message: InboundGroupMessage,
) => Promise<ChatMessageHandlingResult>;

export interface WebUiChatProvider extends ChatDelivery {
  readonly groupChatId: string;
  subscribe(listener: WebUiChatProviderListener): () => void;
}

export interface BindWebUiChatProviderOptions {
  workspaceId: string;
  sessionPort: SessionPort;
  provider: WebUiChatProvider;
  logger?: ChatClientLogger;
}

export interface WebUiChatProviderBinding {
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
