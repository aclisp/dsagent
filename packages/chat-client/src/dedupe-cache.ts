export const CHAT_DEDUPE_MAX_ENTRIES = 10_000;
export const CHAT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1_000;

export class DedupeCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = CHAT_DEDUPE_TTL_MS,
    private readonly maxEntries = CHAT_DEDUPE_MAX_ENTRIES,
  ) {
    if (ttlMs <= 0) throw new Error("Dedupe TTL must be positive");
    if (maxEntries <= 0) throw new Error("Dedupe capacity must be positive");
  }

  rememberIfNew(key: string): boolean {
    const now = this.now();
    for (const [entryKey, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(entryKey);
    }

    if (this.entries.has(key)) return false;
    while (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
    this.entries.set(key, now + this.ttlMs);
    return true;
  }

  clear(): void {
    this.entries.clear();
  }
}
