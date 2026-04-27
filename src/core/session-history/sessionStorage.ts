import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  SESSION_HISTORY_SCHEMA_VERSION,
  type LoadedSessionHistory,
  type SessionHistoryApiMessage,
  type SessionHistoryEntry,
  type SessionHistoryListItem,
  type SessionHistoryUiMessage,
  type SessionId
} from "./types.js";

const SESSION_FILE_EXTENSION = ".jsonl";
const MAX_TITLE_CHARS = 200;

type UnknownRecord = Record<string, unknown>;

export class SessionHistoryStore {
  private currentSessionId: SessionId;
  private currentSequence = 0;
  private readonly materializedSessions = new Set<SessionId>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      sessionsDirectory: string;
      workspaceRoot: string;
      sessionId?: SessionId;
    }
  ) {
    this.currentSessionId = options.sessionId ?? randomUUID();
  }

  getCurrentSessionId(): SessionId {
    return this.currentSessionId;
  }

  getCurrentSessionFilePath(): string {
    return this.getSessionFilePath(this.currentSessionId);
  }

  getSessionFilePath(sessionId: SessionId): string {
    return path.join(this.options.sessionsDirectory, `${sessionId}${SESSION_FILE_EXTENSION}`);
  }

  startNewSession(sessionId: SessionId = randomUUID()): SessionId {
    this.currentSessionId = sessionId;
    this.currentSequence = 0;
    return this.currentSessionId;
  }

  adoptExistingSession(sessionId: SessionId, lastSequence: number): void {
    this.currentSessionId = sessionId;
    this.currentSequence = Math.max(0, Math.trunc(lastSequence));
    this.materializedSessions.add(sessionId);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async recordTurn(options: {
    apiMessages: SessionHistoryApiMessage[];
    uiMessages: SessionHistoryUiMessage[];
  }): Promise<void> {
    if (options.apiMessages.length === 0 && options.uiMessages.length === 0) {
      return;
    }

    const sessionId = this.currentSessionId;
    const timestamp = new Date().toISOString();
    const entries: SessionHistoryEntry[] = [];
    let wroteMetaEntry = false;

    if (!this.materializedSessions.has(sessionId)) {
      entries.push({
        type: "session-meta",
        schemaVersion: SESSION_HISTORY_SCHEMA_VERSION,
        sessionId,
        workspaceRoot: this.options.workspaceRoot,
        createdAt: timestamp
      });
      wroteMetaEntry = true;
    }

    for (const message of options.apiMessages) {
      entries.push({
        type: "api-message",
        sessionId,
        sequence: this.nextSequence(),
        timestamp,
        message
      });
    }

    for (const message of options.uiMessages) {
      entries.push({
        type: "ui-message",
        sessionId,
        sequence: this.nextSequence(),
        timestamp,
        message
      });
    }

    const title = extractTitleFromApiMessages(options.apiMessages);
    if (title) {
      entries.push({
        type: "session-title",
        sessionId,
        sequence: this.nextSequence(),
        timestamp,
        title
      });
    }

    await this.appendEntries(sessionId, entries);
    if (wroteMetaEntry) {
      this.materializedSessions.add(sessionId);
    }
  }

  async loadSession(sessionId: SessionId): Promise<LoadedSessionHistory> {
    return this.loadSessionFromFile(this.getSessionFilePath(sessionId), sessionId);
  }

  async listSessions(options: {
    limit?: number;
    excludeSessionId?: SessionId;
  } = {}): Promise<SessionHistoryListItem[]> {
    let entries;
    try {
      entries = await fs.readdir(this.options.sessionsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }

      throw error;
    }

    const sessions: SessionHistoryListItem[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(SESSION_FILE_EXTENSION)) {
        continue;
      }

      const sessionId = entry.name.slice(0, -SESSION_FILE_EXTENSION.length);
      if (!sessionId || sessionId === options.excludeSessionId) {
        continue;
      }

      const fullPath = path.join(this.options.sessionsDirectory, entry.name);
      try {
        const loaded = await this.loadSessionFromFile(fullPath, sessionId);
        sessions.push(toListItem(loaded));
      } catch {
        // Corrupt or partial transcript files should not break the picker.
      }
    }

    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return options.limit ? sessions.slice(0, options.limit) : sessions;
  }

  async findSessions(
    query: string,
    options: { excludeSessionId?: SessionId } = {}
  ): Promise<SessionHistoryListItem[]> {
    const normalized = query.trim();
    if (!normalized) {
      return [];
    }

    if (normalized !== options.excludeSessionId) {
      try {
        const direct = await this.loadSession(normalized);
        return [toListItem(direct)];
      } catch {
        // Fall through to prefix/title matching.
      }
    }

    const lowerQuery = normalized.toLowerCase();
    const sessions = await this.listSessions({
      excludeSessionId: options.excludeSessionId
    });

    return sessions.filter(
      (session) =>
        session.sessionId.toLowerCase().startsWith(lowerQuery) ||
        session.title.toLowerCase().includes(lowerQuery)
    );
  }

  private async loadSessionFromFile(
    filePath: string,
    fallbackSessionId: SessionId
  ): Promise<LoadedSessionHistory> {
    const [raw, stats] = await Promise.all([
      fs.readFile(filePath, "utf8"),
      fs.stat(filePath)
    ]);
    const apiMessages: SessionHistoryApiMessage[] = [];
    const uiMessages: SessionHistoryUiMessage[] = [];
    let sessionId = fallbackSessionId;
    let workspaceRoot: string | undefined;
    let createdAt = stats.birthtime.toISOString();
    let updatedAt = stats.mtime.toISOString();
    let title = "";
    let lastSequence = 0;

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      const parsed = safeParseJson(line);
      const entry = asRecord(parsed);
      if (!entry) {
        continue;
      }

      const entrySessionId = asString(entry.sessionId);
      if (entrySessionId) {
        sessionId = entrySessionId;
      }

      const sequence = asNumber(entry.sequence);
      if (sequence !== undefined) {
        lastSequence = Math.max(lastSequence, sequence);
      }

      const timestamp = asString(entry.timestamp);
      if (timestamp) {
        updatedAt = timestamp;
      }

      if (entry.type === "session-meta") {
        workspaceRoot = asString(entry.workspaceRoot) ?? workspaceRoot;
        createdAt = asString(entry.createdAt) ?? createdAt;
        continue;
      }

      if (entry.type === "api-message") {
        const message = asRecord(entry.message);
        if (message) {
          apiMessages.push(message as unknown as SessionHistoryApiMessage);
        }
        continue;
      }

      if (entry.type === "ui-message") {
        const message = asRecord(entry.message);
        if (isUiMessage(message)) {
          uiMessages.push(message);
        }
        continue;
      }

      if (entry.type === "session-title") {
        title = asString(entry.title) ?? title;
      }
    }

    if (!title) {
      title = extractTitleFromApiMessages(apiMessages) || "(session)";
    }

    return {
      sessionId,
      filePath,
      workspaceRoot,
      createdAt,
      updatedAt,
      title,
      messageCount: apiMessages.filter((message) => message.role !== "system").length,
      lastSequence,
      apiMessages,
      uiMessages
    };
  }

  private nextSequence(): number {
    this.currentSequence += 1;
    return this.currentSequence;
  }

  private async appendEntries(sessionId: SessionId, entries: SessionHistoryEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const filePath = this.getSessionFilePath(sessionId);
    const payload = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const write = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.appendFile(filePath, payload, "utf8");
      });
    this.writeQueue = write;
    await write;
  }
}

function toListItem(history: LoadedSessionHistory): SessionHistoryListItem {
  return {
    sessionId: history.sessionId,
    filePath: history.filePath,
    workspaceRoot: history.workspaceRoot,
    createdAt: history.createdAt,
    updatedAt: history.updatedAt,
    title: history.title,
    messageCount: history.messageCount
  };
}

function extractTitleFromApiMessages(messages: SessionHistoryApiMessage[]): string {
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    const text = extractText(message.content);
    if (text) {
      return truncateTitle(text);
    }
  }

  return "";
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      const record = asRecord(item);
      return record ? asString(record.text) ?? "" : "";
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateTitle(value: string): string {
  return value.length > MAX_TITLE_CHARS
    ? value.slice(0, MAX_TITLE_CHARS).trimEnd() + "..."
    : value;
}

function isUiMessage(value: unknown): value is SessionHistoryUiMessage {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.kind === "string" &&
      typeof record.title === "string" &&
      Array.isArray(record.blocks) &&
      typeof record.content === "string" &&
      typeof record.preview === "string" &&
      Array.isArray(record.metadata) &&
      typeof record.createdAt === "string" &&
      typeof record.isTruncated === "boolean"
  );
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" ? (value as UnknownRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
