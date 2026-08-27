import { randomUUID } from "node:crypto";
import { chmod, open, mkdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export type ConversationType = "group" | "direct";

export interface ConversationAddress {
  readonly providerId: string;
  readonly type: ConversationType;
  /** Provider-internal address. Never include this value in a Prompt or task config. */
  readonly address: string;
}

export interface ConversationReference extends ConversationAddress {
  readonly alias: string;
}

export interface SenderAddress {
  readonly providerId: string;
  /** Provider-internal sender address. Never include this value in a Prompt or task config. */
  readonly address: string;
}

export interface SenderReference extends SenderAddress {
  readonly alias: string;
}

export type ConversationResolution =
  | { readonly status: "resolved"; readonly reference: ConversationReference }
  | { readonly status: "unavailable"; readonly reason: "unknown_alias" };

export type SenderResolution =
  | { readonly status: "resolved"; readonly reference: SenderReference }
  | { readonly status: "unavailable"; readonly reason: "unknown_alias" };

export interface ConversationAliasRegistryOptions {
  /** Omit for an in-memory registry. */
  readonly filePath?: string;
  /** Injectable only for deterministic tests; production uses randomUUID. */
  readonly random?: () => string;
}

export type ConversationAliasRegistryErrorReason = "unreadable" | "corrupt";

export class ConversationAliasRegistryError extends Error {
  readonly reason: ConversationAliasRegistryErrorReason;

  constructor(reason: ConversationAliasRegistryErrorReason, message: string) {
    super(message);
    this.name = "ConversationAliasRegistryError";
    this.reason = reason;
  }
}

interface PersistedConversation {
  alias: string;
  providerId: string;
  type: ConversationType;
  address: string;
}

interface PersistedSender {
  alias: string;
  providerId: string;
  address: string;
}

interface PersistedRegistry {
  version: 1;
  conversations: PersistedConversation[];
  senders: PersistedSender[];
}

const REGISTRY_VERSION = 1;
const CONVERSATION_ALIAS_PATTERN = /^conv-[a-z0-9][a-z0-9-]*$/u;
const SENDER_ALIAS_PATTERN = /^sender-[a-z0-9][a-z0-9-]*$/u;
const ALIAS_SUFFIX_PATTERN = /^[a-zA-Z0-9_-]+$/u;
const MAX_ALIAS_ATTEMPTS = 1_000;

function requiredText(value: string, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} must not be blank`);
  return normalized;
}

function conversationType(value: ConversationType): ConversationType {
  if (value !== "group" && value !== "direct") {
    throw new Error("Conversation type must be group or direct");
  }
  return value;
}

function normalizeConversationAddress(
  address: ConversationAddress,
): ConversationAddress {
  return {
    providerId: requiredText(address.providerId, "Provider ID"),
    type: conversationType(address.type),
    address: requiredText(address.address, "Conversation address"),
  };
}

function normalizeSenderAddress(address: SenderAddress): SenderAddress {
  return {
    providerId: requiredText(address.providerId, "Provider ID"),
    address: requiredText(address.address, "Sender address"),
  };
}

function conversationKey(address: ConversationAddress): string {
  return JSON.stringify([address.providerId, address.type, address.address]);
}

function senderKey(address: SenderAddress): string {
  return JSON.stringify([address.providerId, address.address]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function persistedText(
  value: unknown,
  name: string,
  reason: ConversationAliasRegistryErrorReason,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConversationAliasRegistryError(reason, `Invalid registry ${name}`);
  }
  return value.trim();
}

function persistedType(
  value: unknown,
  reason: ConversationAliasRegistryErrorReason,
): ConversationType {
  if (value !== "group" && value !== "direct") {
    throw new ConversationAliasRegistryError(reason, "Invalid registry conversation type");
  }
  return value;
}

function validateKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  reason: ConversationAliasRegistryErrorReason,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ConversationAliasRegistryError(
        reason,
        `Unknown registry field: ${key}`,
      );
    }
  }
}

function persistedConversation(
  value: unknown,
  reason: ConversationAliasRegistryErrorReason,
): PersistedConversation {
  if (!isRecord(value)) {
    throw new ConversationAliasRegistryError(reason, "Invalid registry conversation");
  }
  validateKeys(
    value,
    new Set(["alias", "providerId", "type", "address"]),
    reason,
  );
  const alias = persistedText(value.alias, "conversation alias", reason);
  if (!CONVERSATION_ALIAS_PATTERN.test(alias)) {
    throw new ConversationAliasRegistryError(reason, "Invalid conversation alias");
  }
  return {
    alias,
    providerId: persistedText(value.providerId, "provider ID", reason),
    type: persistedType(value.type, reason),
    address: persistedText(value.address, "conversation address", reason),
  };
}

function persistedSender(
  value: unknown,
  reason: ConversationAliasRegistryErrorReason,
): PersistedSender {
  if (!isRecord(value)) {
    throw new ConversationAliasRegistryError(reason, "Invalid registry sender");
  }
  validateKeys(value, new Set(["alias", "providerId", "address"]), reason);
  const alias = persistedText(value.alias, "sender alias", reason);
  if (!SENDER_ALIAS_PATTERN.test(alias)) {
    throw new ConversationAliasRegistryError(reason, "Invalid sender alias");
  }
  return {
    alias,
    providerId: persistedText(value.providerId, "provider ID", reason),
    address: persistedText(value.address, "sender address", reason),
  };
}

function parseRegistry(raw: string): PersistedRegistry {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ConversationAliasRegistryError("corrupt", "Registry JSON is invalid");
  }
  if (!isRecord(value)) {
    throw new ConversationAliasRegistryError("corrupt", "Registry root must be an object");
  }
  validateKeys(value, new Set(["version", "conversations", "senders"]), "corrupt");
  if (value.version !== REGISTRY_VERSION) {
    throw new ConversationAliasRegistryError("corrupt", "Unsupported registry version");
  }
  if (!Array.isArray(value.conversations) || !Array.isArray(value.senders)) {
    throw new ConversationAliasRegistryError("corrupt", "Registry collections are invalid");
  }
  return {
    version: REGISTRY_VERSION,
    conversations: value.conversations.map((entry) =>
      persistedConversation(entry, "corrupt"),
    ),
    senders: value.senders.map((entry) => persistedSender(entry, "corrupt")),
  };
}

function cloneConversation(reference: ConversationReference): ConversationReference {
  return { ...reference };
}

function cloneSender(reference: SenderReference): SenderReference {
  return { ...reference };
}

/**
 * Provider-neutral alias registry.
 *
 * The registry deliberately has no delete or caller-supplied alias operation:
 * once an address has an alias, that alias is stable for the lifetime of the
 * persisted registry and can never be accidentally rebound by this API.
 */
export class ConversationAliasRegistry {
  private readonly conversationsByKey = new Map<string, ConversationReference>();
  private readonly conversationsByAlias = new Map<string, ConversationReference>();
  private readonly sendersByKey = new Map<string, SenderReference>();
  private readonly sendersByAlias = new Map<string, SenderReference>();
  private mutation = Promise.resolve();

  private constructor(
    private readonly filePath: string | undefined,
    private readonly random: () => string,
  ) {}

  static async open(
    options: ConversationAliasRegistryOptions = {},
  ): Promise<ConversationAliasRegistry> {
    const filePath = options.filePath;
    if (filePath !== undefined && filePath.trim().length === 0) {
      throw new Error("Conversation alias registry file path must not be blank");
    }
    const registry = new ConversationAliasRegistry(
      filePath,
      options.random ?? randomUUID,
    );
    await registry.load();
    return registry;
  }

  async registerConversation(
    address: ConversationAddress,
  ): Promise<ConversationReference> {
    const normalized = normalizeConversationAddress(address);
    return this.enqueue(async () => {
      const key = conversationKey(normalized);
      const existing = this.conversationsByKey.get(key);
      if (existing !== undefined) return cloneConversation(existing);

      const reference: ConversationReference = {
        alias: this.allocateAlias("conv", this.conversationsByAlias),
        ...normalized,
      };
      this.conversationsByKey.set(key, reference);
      this.conversationsByAlias.set(reference.alias, reference);
      try {
        await this.persist();
      } catch (error) {
        this.conversationsByKey.delete(key);
        this.conversationsByAlias.delete(reference.alias);
        throw error;
      }
      return cloneConversation(reference);
    });
  }

  async registerSender(address: SenderAddress): Promise<SenderReference> {
    const normalized = normalizeSenderAddress(address);
    return this.enqueue(async () => {
      const key = senderKey(normalized);
      const existing = this.sendersByKey.get(key);
      if (existing !== undefined) return cloneSender(existing);

      const reference: SenderReference = {
        alias: this.allocateAlias("sender", this.sendersByAlias),
        ...normalized,
      };
      this.sendersByKey.set(key, reference);
      this.sendersByAlias.set(reference.alias, reference);
      try {
        await this.persist();
      } catch (error) {
        this.sendersByKey.delete(key);
        this.sendersByAlias.delete(reference.alias);
        throw error;
      }
      return cloneSender(reference);
    });
  }

  resolveConversation(alias: string): ConversationResolution {
    const normalized = typeof alias === "string" ? alias.trim() : "";
    const reference = this.conversationsByAlias.get(normalized);
    return reference === undefined
      ? { status: "unavailable", reason: "unknown_alias" }
      : { status: "resolved", reference: cloneConversation(reference) };
  }

  resolveSender(alias: string): SenderResolution {
    const normalized = typeof alias === "string" ? alias.trim() : "";
    const reference = this.sendersByAlias.get(normalized);
    return reference === undefined
      ? { status: "unavailable", reason: "unknown_alias" }
      : { status: "resolved", reference: cloneSender(reference) };
  }

  get conversationCount(): number {
    return this.conversationsByAlias.size;
  }

  get senderCount(): number {
    return this.sendersByAlias.size;
  }

  private allocateAlias(
    prefix: "conv" | "sender",
    aliases: ReadonlyMap<string, unknown>,
  ): string {
    for (let attempt = 0; attempt < MAX_ALIAS_ATTEMPTS; attempt += 1) {
      const suffix = this.random().trim();
      if (suffix.length === 0 || !ALIAS_SUFFIX_PATTERN.test(suffix)) {
        throw new Error("Alias generator returned an invalid value");
      }
      const alias = `${prefix}-${suffix.toLowerCase()}`;
      if (
        (prefix === "conv" && !CONVERSATION_ALIAS_PATTERN.test(alias)) ||
        (prefix === "sender" && !SENDER_ALIAS_PATTERN.test(alias))
      ) {
        throw new Error("Alias generator returned an invalid value");
      }
      if (!aliases.has(alias)) return alias;
    }
    throw new Error("Could not allocate a unique conversation alias");
  }

  private async load(): Promise<void> {
    if (this.filePath === undefined) return;

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ConversationAliasRegistryError(
        "unreadable",
        "Conversation alias registry could not be read",
      );
    }
    const parsed = parseRegistry(raw);
    for (const entry of parsed.conversations) {
      const reference: ConversationReference = { ...entry };
      const key = conversationKey(reference);
      if (
        this.conversationsByKey.has(key) ||
        this.conversationsByAlias.has(reference.alias)
      ) {
        throw new ConversationAliasRegistryError(
          "corrupt",
          "Conversation alias registry contains a duplicate",
        );
      }
      this.conversationsByKey.set(key, reference);
      this.conversationsByAlias.set(reference.alias, reference);
    }
    for (const entry of parsed.senders) {
      const reference: SenderReference = { ...entry };
      const key = senderKey(reference);
      if (this.sendersByKey.has(key) || this.sendersByAlias.has(reference.alias)) {
        throw new ConversationAliasRegistryError(
          "corrupt",
          "Conversation alias registry contains a duplicate",
        );
      }
      this.sendersByKey.set(key, reference);
      this.sendersByAlias.set(reference.alias, reference);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persist(): Promise<void> {
    if (this.filePath === undefined) return;

    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${randomUUID()}.tmp`,
    );
    const snapshot: PersistedRegistry = {
      version: REGISTRY_VERSION,
      conversations: [...this.conversationsByAlias.values()]
        .map(({ alias, providerId, type, address }) => ({
          alias,
          providerId,
          type,
          address,
        }))
        .sort((left, right) => left.alias.localeCompare(right.alias)),
      senders: [...this.sendersByAlias.values()]
        .map(({ alias, providerId, address }) => ({ alias, providerId, address }))
        .sort((left, right) => left.alias.localeCompare(right.alias)),
    };
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export function createConversationAliasRegistry(
  options: ConversationAliasRegistryOptions = {},
): Promise<ConversationAliasRegistry> {
  return ConversationAliasRegistry.open(options);
}
