import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

interface StoredSession {
  version: 1;
  workspace: string;
  model: string;
  updatedAt: string;
  messages: AgentMessage[];
}

export class SessionStore {
  readonly file: string;

  constructor(
    private readonly workspace: string,
    private readonly model: string,
  ) {
    const id = crypto.createHash("sha256").update(workspace).digest("hex").slice(0, 20);
    this.file = path.join(os.homedir(), ".dscode", "sessions", `${id}.json`);
  }

  async load(): Promise<AgentMessage[]> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      if (
        parsed.version !== 1 ||
        parsed.workspace !== this.workspace ||
        parsed.model !== this.model ||
        !Array.isArray(parsed.messages)
      ) {
        return [];
      }
      return parsed.messages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw new Error(`Could not load session ${this.file}: ${(error as Error).message}`);
    }
  }

  async save(messages: AgentMessage[]): Promise<void> {
    const session: StoredSession = {
      version: 1,
      workspace: this.workspace,
      model: this.model,
      updatedAt: new Date().toISOString(),
      messages,
    };
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.file);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

