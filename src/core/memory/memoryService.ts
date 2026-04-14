import OpenAI from "openai";
import { isTurnInterruptedError, toTurnInterruptedError } from "../abort.js";
import { buildAutoSessionSummary, getConversationMessageCount } from "./autoSummary.js";
import { PersistentMemoryStore } from "./persistentMemoryStore.js";
import { SessionMemoryStore } from "./sessionMemoryStore.js";
import type {
  MemoryAutoSummary,
  MemoryPromptContext,
  MemoryServiceConfig,
  MemorySnapshot,
  MemorySource
} from "./types.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

// MemoryService 统一封装会话记忆与持久记忆，提供单一接入点。
export class MemoryService {
  private readonly sessionStore: SessionMemoryStore;
  private readonly persistentStore: PersistentMemoryStore;
  private autoSummary: MemoryAutoSummary | null = null;
  private autoSummaryUpdating = false;
  private autoSummaryEnabled: boolean;

  constructor(private readonly config: MemoryServiceConfig) {
    this.sessionStore = new SessionMemoryStore(config.maxSessionEntries);
    this.persistentStore = new PersistentMemoryStore(
      config.workspaceRoot,
      config.directory,
      config.fileName,
      config.maxPersistentEntries
    );
    this.autoSummaryEnabled = config.autoSummary.enabled;
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
    this.autoSummary = null;
    this.autoSummaryUpdating = false;
  }

  async clearPersistent() {
    await this.persistentStore.clear();
  }

  async getSnapshot(): Promise<MemorySnapshot> {
    const persistent = await this.persistentStore.list();
    return {
      session: this.sessionStore.list(),
      persistent,
      autoSummary: this.autoSummary,
      autoSummaryEnabled: this.autoSummaryEnabled
    };
  }

  async getPromptContext(): Promise<MemoryPromptContext> {
    const [session, persistent] = await Promise.all([
      Promise.resolve(this.sessionStore.list(this.config.maxPromptEntries)),
      this.persistentStore.list(this.config.maxPromptEntries)
    ]);

    return {
      sessionSummary:
        this.autoSummaryEnabled && this.autoSummary
          ? trimSummaryForPrompt(this.autoSummary.markdown)
          : undefined,
      summaryUpdatedAt: this.autoSummary?.updatedAt,
      sessionNotes: session.map((entry) => formatPromptNote(entry.createdAt, entry.content)),
      persistentNotes: persistent.map((entry) => formatPromptNote(entry.createdAt, entry.content))
    };
  }

  // 按阈值更新会话自动摘要，不每轮都触发。
  async maybeRefreshAutoSummary(options: {
    client: OpenAI;
    model: string;
    messages: MessageParam[];
    abortSignal?: AbortSignal;
  }): Promise<boolean> {
    if (!this.autoSummaryEnabled) {
      return false;
    }

    if (this.autoSummaryUpdating) {
      return false;
    }

    const messageCount = getConversationMessageCount(options.messages);
    if (!this.shouldRefreshAutoSummary(messageCount)) {
      return false;
    }

    this.autoSummaryUpdating = true;
    try {
      const markdown = await buildAutoSessionSummary(options.client, {
        model: options.model,
        existingSummary: this.autoSummary?.markdown,
        messages: options.messages,
        windowMessages: this.config.autoSummary.windowMessages,
        maxCharsPerMessage: this.config.autoSummary.maxCharsPerMessage,
        abortSignal: options.abortSignal
      });

      this.autoSummary = {
        markdown,
        updatedAt: new Date().toISOString(),
        lastMessageCount: messageCount
      };

      return true;
    } catch (error) {
      if (isTurnInterruptedError(error, options.abortSignal)) {
        throw toTurnInterruptedError(error, options.abortSignal);
      }

      return false;
    } finally {
      this.autoSummaryUpdating = false;
    }
  }

  getPersistentFilePath() {
    return this.persistentStore.getRelativeFilePath();
  }

  setAutoSummaryEnabled(enabled: boolean) {
    this.autoSummaryEnabled = enabled;
    if (!enabled) {
      this.autoSummaryUpdating = false;
    }
  }

  private shouldRefreshAutoSummary(messageCount: number) {
    if (!this.autoSummary) {
      return messageCount >= this.config.autoSummary.minMessagesToInit;
    }

    const delta = messageCount - this.autoSummary.lastMessageCount;
    return delta >= this.config.autoSummary.messagesBetweenUpdates;
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
