import type { ChatProvider } from "@aclisp/dsagent-chat-client";
import { createWeComChatProviderFromEnv } from "@aclisp/dsagent-wecom";
import { createWeChatChatProviderFromHome } from "@aclisp/dsagent-wechat";

/** Same account sources as Server; local configuration errors are fatal to /web.
 * SDK output stays out of the TUI renderer. Safe lifecycle states are shown there. */
export async function configuredContinuationProviders(options: {
  homePath: string; workspacePath: string; maxUploadBytes: number;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<ChatProvider[]> {
  const env = options.env ?? process.env;
  const providers: ChatProvider[] = [];
  const logger = { error(_message: string) {} };
  try {
    const wecom = createWeComChatProviderFromEnv(env, { ...options, logger });
    if (wecom) providers.push(wecom);
    const wechat = createWeChatChatProviderFromHome({ ...options, logger,
      ...(env.IM_WECHAT_ENABLED === undefined ? {} : { enabled: env.IM_WECHAT_ENABLED }),
    });
    if (wechat) providers.push(wechat);
    return providers;
  } catch (error) {
    await Promise.allSettled(providers.map(provider => provider.dispose?.()));
    throw error;
  }
}
