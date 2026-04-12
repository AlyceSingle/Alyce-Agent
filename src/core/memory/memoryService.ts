import { PersistentMemoryStore } from "./persistentMemoryStore.js";
import { SessionMemoryStore } from "./sessionMemoryStore.js";
import type {
  MemoryPromptContext,
  MemoryServiceConfig,
  MemorySnapshot,
  MemorySource
} from "./types.js";

// MemoryService 统一封装会话记忆与持久记忆，提供单一接入点。
export class MemoryService {
  private readonly sessionStore: SessionMemoryStore;
  private readonly persistentStore: PersistentMemoryStore;

  constructor(private readonly config: MemoryServiceConfig) {
    this.sessionStore = new SessionMemoryStore(config.maxSessionEntries);
    this.persistentStore = new PersistentMemoryStore(
      config.workspaceRoot,
      config.directory,
      config.fileName,
      config.maxPersistentEntries
    );
  }

  async initialize() {
    await this.persistentStore.initialize();
  }

  async remember(note: string, options?: { source?: MemorySource; persist?: boolean }) {
    const source = options?.source ?? "user";
    const persist = options?.persist ?? true;

    this.sessionStore.add(note, source);

    if (persist) {
      await this.persistentStore.add(note, source);
    }
  }

  clearSession() {
    this.sessionStore.clear();
  }

  async clearPersistent() {
    await this.persistentStore.clear();
  }

  async getSnapshot(): Promise<MemorySnapshot> {
    const persistent = await this.persistentStore.list();
    return {
      session: this.sessionStore.list(),
      persistent
    };
  }

  async getPromptContext(): Promise<MemoryPromptContext> {
    const [session, persistent] = await Promise.all([
      Promise.resolve(this.sessionStore.list(this.config.maxPromptEntries)),
      this.persistentStore.list(this.config.maxPromptEntries)
    ]);

    return {
      sessionNotes: session.map((entry) => formatPromptNote(entry.createdAt, entry.content)),
      persistentNotes: persistent.map((entry) => formatPromptNote(entry.createdAt, entry.content))
    };
  }

  getPersistentFilePath() {
    return this.persistentStore.getRelativeFilePath();
  }
}

function formatPromptNote(createdAt: string, content: string) {
  const shortDate = createdAt.slice(0, 10);
  return `[${shortDate}] ${content}`;
}
