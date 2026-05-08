import { PersistentMemoryStore } from "./persistentMemoryStore.js";
import { SessionMemoryStore } from "./sessionMemoryStore.js";
import type {
  MemoryPromptContext,
  MemoryServiceConfig,
  MemorySnapshot,
  MemorySource,
  MemoryVolatileSnapshot,
  SessionMemoryFileState
} from "./types.js";

// MemoryService 统一封装会话记忆与持久记忆，提供单一接入点。
export class MemoryService {
  private readonly sessionStore: SessionMemoryStore;
  private readonly persistentStore: PersistentMemoryStore;
  private sessionMemory: SessionMemoryFileState | null = null;
  private sessionMemorySourcePath = "session history";
  private sessionMemoryEnabled: boolean;

  constructor(private readonly config: MemoryServiceConfig) {
    this.sessionStore = new SessionMemoryStore(config.maxSessionEntries);
    this.persistentStore = new PersistentMemoryStore(
      config.workspaceRoot,
      config.directory,
      config.fileName,
      config.maxPersistentEntries
    );
    this.sessionMemoryEnabled = config.sessionMemory.enabled;
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

  async clearSession() {
    this.sessionStore.clear();
    this.sessionMemory = null;
  }

  createVolatileSnapshot(): MemoryVolatileSnapshot {
    return {
      session: this.sessionStore.list(Number.MAX_SAFE_INTEGER).map((entry) => ({ ...entry })),
      sessionMemory: this.cloneSessionMemory()
    };
  }

  restoreVolatileSnapshot(snapshot: MemoryVolatileSnapshot) {
    this.sessionStore.replace(snapshot.session);
    this.sessionMemory = cloneSessionMemory(snapshot.sessionMemory);
  }

  async clearPersistent() {
    await this.persistentStore.clear();
  }

  async getSnapshot(): Promise<MemorySnapshot> {
    const persistent = await this.persistentStore.list();
    return {
      session: this.sessionStore.list(),
      persistent,
      sessionMemory: this.cloneSessionMemory(),
      sessionMemoryPath: this.getSessionMemoryFilePath(),
      sessionMemoryEnabled: this.sessionMemoryEnabled
    };
  }

  async getPromptContext(): Promise<MemoryPromptContext> {
    const [session, persistent] = await Promise.all([
      Promise.resolve(this.sessionStore.list(this.config.maxPromptEntries)),
      this.persistentStore.list(this.config.maxPromptEntries)
    ]);
    const sessionMemory = this.cloneSessionMemory();

    return {
      sessionSummary:
        this.sessionMemoryEnabled && sessionMemory
          ? trimSummaryForPrompt(sessionMemory.markdown)
          : undefined,
      summaryUpdatedAt: sessionMemory?.updatedAt,
      sessionMemoryPath: sessionMemory ? this.getSessionMemoryFilePath() : undefined,
      sessionNotes: session.map((entry) => formatPromptNote(entry.createdAt, entry.content)),
      persistentNotes: persistent.map((entry) => formatPromptNote(entry.createdAt, entry.content))
    };
  }

  updateSessionMemory(markdown: string) {
    const normalized = normalizeSessionMemoryMarkdown(markdown);
    this.sessionMemory = normalized
      ? {
          markdown: normalized,
          updatedAt: new Date().toISOString()
        }
      : null;
  }

  getSessionMemory() {
    return this.cloneSessionMemory();
  }

  setSessionMemory(sessionMemory: SessionMemoryFileState | null | undefined) {
    this.sessionMemory = cloneSessionMemory(sessionMemory);
  }

  getPersistentFilePath() {
    return this.persistentStore.getRelativeFilePath();
  }

  getSessionMemoryFilePath() {
    return this.sessionMemorySourcePath;
  }

  setSessionMemorySourcePath(sourcePath: string) {
    this.sessionMemorySourcePath = sourcePath.trim() || "session history";
  }

  setSessionMemoryEnabled(enabled: boolean) {
    this.sessionMemoryEnabled = enabled;
  }

  private cloneSessionMemory() {
    return cloneSessionMemory(this.sessionMemory);
  }
}

function formatPromptNote(createdAt: string, content: string) {
  const shortDate = createdAt.slice(0, 10);
  return `[${shortDate}] ${content}`;
}

function trimSummaryForPrompt(summary: string) {
  const lines = summary
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(0, 18);

  return lines.join("\n");
}

function normalizeSessionMemoryMarkdown(markdown: string) {
  return markdown.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function cloneSessionMemory(
  sessionMemory: SessionMemoryFileState | null | undefined
): SessionMemoryFileState | null {
  return sessionMemory ? { ...sessionMemory } : null;
}
