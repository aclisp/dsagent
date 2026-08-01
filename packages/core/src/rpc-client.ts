import { fileURLToPath } from "node:url";
import {
  RpcClient,
  type RpcClientOptions,
} from "@earendil-works/pi-coding-agent";
import type { SupportedProviderId } from "./providers.js";

export type DSCodeRpcClientOptions = Omit<RpcClientOptions, "cliPath" | "provider"> & {
  /** Model provider for this session. Defaults to DeepSeek. */
  provider?: SupportedProviderId;
};

/**
 * Create a typed client backed by the bundled DSCode RPC worker.
 * The caller owns start/stop and can render all events in a graphical interface.
 */
export function createDSCodeRpcClient(options: DSCodeRpcClientOptions = {}): RpcClient {
  return new RpcClient({
    ...options,
    cliPath: getDSCodeRpcEntryPath(),
    provider: options.provider ?? "deepseek",
  });
}

export function getDSCodeRpcEntryPath(): string {
  return fileURLToPath(new URL("./rpc-entry.js", import.meta.url));
}

export { RpcClient };
export type { RpcClientOptions };
