import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isGeneratedContextMessage } from "../api/generatedMessages.js";
import { asNumber, asRecord, asString } from "../util/unknown.js";
import { extractCollapsedMessageText } from "../api/messageText.js";
import {
  isPersistedFileHistorySnapshot,
  type PersistedFileHistorySnapshot
} from "../file-history/fileBackupStore.js";
import { cloneJson } from "../json/clone.js";
import {
  SESSION_HISTORY_SCHEMA_VERSION,
  type LoadedSessionHistory,
  type SessionHistoryApiMessage,
  type SessionHistoryEntry,
  type SessionHistoryListItem,
  type SessionHistoryRewindMode,
  type SessionHistorySubagentEvent,
  type SessionHistorySubagentEventType,
  type SessionHistorySubagentTaskIndexItem,
  type SessionHistoryUiMessage,
  type SessionId
} from "./types.js";
import type { SessionMemoryFileState } from "../memory/types.js";

const SESSION_FILE_EXTENSION = ".jsonl";
const MAX_TITLE_CHARS = 200;
const MAX_REWIND_COMPAT_CHECKPOINTS = 250;

type UnknownRecord = Record<string, unknown>;

interface SessionHistoryRewindCheckpoint {
  input: string;
  apiMessageCount: number;
  uiMessageCount: number;
  apiMessages: SessionHistoryApiMessage[];
  uiMessages: SessionHistoryUiMessage[];
  sessionMemory: SessionMemoryFileState | null;
}

interface SessionHistorySubagentEventWithSequence {
  type: SessionHistorySubagentEventType;
  sequence: number;
  timestamp: string;
  event: SessionHistorySubagentEvent;
}

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
    const apiMessages = filterPersistableApiMessages(options.apiMessages);
    if (apiMessages.length === 0 && options.uiMessages.length === 0) {
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

    entries.push(...this.buildTurnEntries(sessionId, timestamp, apiMessages, options.uiMessages));

    await this.appendEntries(sessionId, entries);
    if (wroteMetaEntry) {
      this.materializedSessions.add(sessionId);
    }
  }

  async recordConversationSnapshot(options: {
    apiMessages: SessionHistoryApiMessage[];
    uiMessages: SessionHistoryUiMessage[];
    uiBaseMessageCount: number;
    sessionMemory?: SessionMemoryFileState | null;
  }): Promise<void> {
    const apiMessages = filterPersistableApiMessages(options.apiMessages);
    if (apiMessages.length === 0 && options.uiMessages.length === 0) {
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

    entries.push({
      type: "session-rewind",
      sessionId,
      sequence: this.nextSequence(),
      timestamp,
      apiMessageCount: 0,
      uiMessageCount: Math.max(0, Math.trunc(options.uiBaseMessageCount)),
      sessionMemory: cloneSessionMemory(options.sessionMemory ?? null)
    });
    entries.push(...this.buildTurnEntries(sessionId, timestamp, apiMessages, options.uiMessages));

    await this.appendEntries(sessionId, entries);
    if (wroteMetaEntry) {
      this.materializedSessions.add(sessionId);
    }
  }

  async recordRewind(options: {
    apiMessageCount: number;
    uiMessageCount: number;
    sessionMemory?: SessionMemoryFileState | null;
    restoredInput?: string;
    restoreMode?: SessionHistoryRewindMode;
  }): Promise<void> {
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

    entries.push({
      type: "session-rewind",
      sessionId,
      sequence: this.nextSequence(),
      timestamp,
      apiMessageCount: Math.max(0, Math.trunc(options.apiMessageCount)),
      uiMessageCount: Math.max(0, Math.trunc(options.uiMessageCount)),
      sessionMemory: cloneSessionMemory(options.sessionMemory ?? null),
      restoredInput: options.restoredInput,
      restoreMode: options.restoreMode
    });

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
    let lastApiRole: string | undefined;
    let sessionMemory: SessionMemoryFileState | null = null;
    const fileSnapshots = new Map<string, PersistedFileHistorySnapshot>();
    const rewindCheckpoints: SessionHistoryRewindCheckpoint[] = [];
    let subagentEvents: SessionHistorySubagentEventWithSequence[] = [];

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
          const historyMessage = message as unknown as SessionHistoryApiMessage;
          const role = asString(message.role);
          if (isGeneratedContextMessage(historyMessage)) {
            continue;
          }

          if (isConversationUserMessage(historyMessage, lastApiRole)) {
            const input = extractCollapsedMessageText(historyMessage.content);
            if (input) {
              rewindCheckpoints.push({
                input,
                apiMessageCount: apiMessages.length,
                uiMessageCount: uiMessages.length,
                apiMessages: cloneApiMessages(apiMessages),
                uiMessages: cloneUiMessages(uiMessages),
                sessionMemory: cloneSessionMemory(sessionMemory)
              });
              trimRewindCheckpoints(rewindCheckpoints);
            }
          }
          apiMessages.push(historyMessage);
          lastApiRole = role;
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
        continue;
      }

      if (entry.type === "session-memory") {
        sessionMemory = parseSessionMemoryEntry(entry.sessionMemory);
        continue;
      }

      if (entry.type === "file-snapshot") {
        if (isPersistedFileHistorySnapshot(entry.snapshot, sessionId)) {
          fileSnapshots.set(entry.snapshot.turnId, cloneJson(entry.snapshot));
        }
        continue;
      }

      if (entry.type === "session-rewind") {
        const apiMessageCount = asNumber(entry.apiMessageCount);
        const uiMessageCount = asNumber(entry.uiMessageCount);
        const restoredInput = asString(entry.restoredInput);
        const rewindSessionMemory = parseSessionMemoryEntry(entry.sessionMemory);
        const checkpoint = restoredInput
          ? findRewindCheckpoint(
              rewindCheckpoints,
              restoredInput,
              apiMessageCount,
              uiMessageCount,
              apiMessages.length
            )
          : undefined;
        if (checkpoint) {
          apiMessages.splice(0, apiMessages.length, ...cloneApiMessages(checkpoint.apiMessages));
          uiMessages.splice(0, uiMessages.length, ...cloneUiMessages(checkpoint.uiMessages));
          sessionMemory = cloneSessionMemory(checkpoint.sessionMemory);
          pruneRewindCheckpointsAfter(rewindCheckpoints, checkpoint);
        } else {
          if (apiMessageCount !== undefined) {
            apiMessages.splice(Math.max(0, Math.trunc(apiMessageCount)));
          }
          if (uiMessageCount !== undefined) {
            uiMessages.splice(Math.max(0, Math.trunc(uiMessageCount)));
          }
          sessionMemory = rewindSessionMemory;
        }
        lastApiRole = apiMessages.at(-1)?.role;
        title = extractTitleFromApiMessages(apiMessages);
        subagentEvents = pruneSubagentEventsForRewind(
          subagentEvents,
          apiMessages.length,
          uiMessages.length
        );
        continue;
      }

      if (isSubagentEventEntryType(entry.type)) {
        const event = parseSubagentEvent(entry.type, entry.event);
        if (event) {
          subagentEvents.push({
            type: entry.type,
            sequence: sequence ?? 0,
            timestamp: timestamp ?? new Date().toISOString(),
            event
          });
        }
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
      uiMessages,
      sessionMemory,
      fileSnapshots: [...fileSnapshots.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
      ),
      subagentTaskIndex: buildSubagentTaskIndex(subagentEvents),
      subagentEvents: subagentEvents.map((item) => item.event)
    };
  }

  private nextSequence(): number {
    this.currentSequence += 1;
    return this.currentSequence;
  }

  private buildTurnEntries(
    sessionId: SessionId,
    timestamp: string,
    apiMessages: SessionHistoryApiMessage[],
    uiMessages: SessionHistoryUiMessage[]
  ): SessionHistoryEntry[] {
    const entries: SessionHistoryEntry[] = [];

    for (const message of apiMessages) {
      entries.push({
        type: "api-message",
        sessionId,
        sequence: this.nextSequence(),
        timestamp,
        message
      });
    }

    for (const message of uiMessages) {
      entries.push({
        type: "ui-message",
        sessionId,
        sequence: this.nextSequence(),
        timestamp,
        message
      });
    }

    const title = extractTitleFromApiMessages(apiMessages);
    if (title) {
      entries.push({
        type: "session-title",
        sessionId,
        sequence: this.nextSequence(),
        timestamp,
        title
      });
    }

    return entries;
  }

  async recordSessionMemory(sessionMemory: SessionMemoryFileState | null): Promise<void> {
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

    entries.push({
      type: "session-memory",
      sessionId,
      sequence: this.nextSequence(),
      timestamp,
      sessionMemory: cloneSessionMemory(sessionMemory)
    });

    await this.appendEntries(sessionId, entries);
    if (wroteMetaEntry) {
      this.materializedSessions.add(sessionId);
    }
  }

  async recordFileSnapshot(snapshot: PersistedFileHistorySnapshot): Promise<void> {
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

    entries.push({
      type: "file-snapshot",
      sessionId,
      sequence: this.nextSequence(),
      timestamp,
      snapshot: cloneJson(snapshot)
    });

    await this.appendEntries(sessionId, entries);
    if (wroteMetaEntry) {
      this.materializedSessions.add(sessionId);
    }
  }

  async recordSubagentEvent(event: SessionHistorySubagentEvent): Promise<void> {
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

    entries.push({
      type: event.type,
      sessionId,
      sequence: this.nextSequence(),
      timestamp,
      event
    });

    await this.appendEntries(sessionId, entries);
    if (wroteMetaEntry) {
      this.materializedSessions.add(sessionId);
    }
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

function filterPersistableApiMessages(
  messages: SessionHistoryApiMessage[]
): SessionHistoryApiMessage[] {
  return messages.filter((message) => !isGeneratedContextMessage(message));
}

function extractTitleFromApiMessages(messages: SessionHistoryApiMessage[]): string {
  for (const message of messages) {
    if (message.role !== "user" || isGeneratedContextMessage(message)) {
      continue;
    }

    const text = extractCollapsedMessageText(message.content);
    if (text) {
      return truncateTitle(text);
    }
  }

  return "";
}

function isConversationUserMessage(
  message: SessionHistoryApiMessage,
  previousRole: string | undefined
): boolean {
  return message.role === "user" &&
    previousRole !== "tool" &&
    !isGeneratedContextMessage(message);
}


function normalizeMessageText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findRewindCheckpoint(
  checkpoints: SessionHistoryRewindCheckpoint[],
  restoredInput: string,
  apiMessageCount?: number,
  uiMessageCount?: number,
  currentApiMessageCount?: number
) {
  const normalized = normalizeMessageText(restoredInput);
  const normalizedApiCount = apiMessageCount === undefined
    ? undefined
    : Math.max(0, Math.trunc(apiMessageCount));
  const normalizedUiCount = uiMessageCount === undefined
    ? undefined
    : Math.max(0, Math.trunc(uiMessageCount));
  const apiCountLooksUsable = normalizedApiCount !== undefined &&
    (currentApiMessageCount === undefined || normalizedApiCount <= currentApiMessageCount);
  let exactApiMatch: SessionHistoryRewindCheckpoint | undefined;
  let closestApiMatch: SessionHistoryRewindCheckpoint | undefined;
  let fallback: SessionHistoryRewindCheckpoint | undefined;

  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index];
    if (normalizeMessageText(checkpoint.input) !== normalized) {
      continue;
    }

    if (!apiCountLooksUsable) {
      fallback ??= checkpoint;
      continue;
    }

    if (checkpoint.apiMessageCount === normalizedApiCount) {
      if (normalizedUiCount === undefined || checkpoint.uiMessageCount === normalizedUiCount) {
        return checkpoint;
      }

      exactApiMatch ??= checkpoint;
      continue;
    }

    if (
      normalizedApiCount !== undefined &&
      checkpoint.apiMessageCount <= normalizedApiCount
    ) {
      closestApiMatch ??= checkpoint;
    }
  }

  return exactApiMatch ?? closestApiMatch ?? fallback;
}



function cloneApiMessages(messages: SessionHistoryApiMessage[]) {
  return cloneJson(messages);
}

function cloneUiMessages(messages: SessionHistoryUiMessage[]) {
  return cloneJson(messages);
}

function cloneSessionMemory(
  sessionMemory: SessionMemoryFileState | null | undefined
): SessionMemoryFileState | null {
  return sessionMemory ? { ...sessionMemory } : null;
}

function parseSessionMemoryEntry(value: unknown): SessionMemoryFileState | null {
  const record = asRecord(value);
  if (!record || typeof record.markdown !== "string" || record.markdown.trim().length === 0) {
    return null;
  }

  return {
    markdown: record.markdown,
    ...(typeof record.updatedAt === "string" ? { updatedAt: record.updatedAt } : {})
  };
}

function isSubagentEventEntryType(value: unknown): value is SessionHistorySubagentEventType {
  return value === "subagent-started" ||
    value === "subagent-notification" ||
    value === "subagent-stopped" ||
    value === "subagent-retrieved";
}

function parseSubagentEvent(
  type: SessionHistorySubagentEventType,
  value: unknown
): SessionHistorySubagentEvent | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const taskId = asString(record.taskId);
  const agentType = asString(record.agentType);
  const description = asString(record.description);
  const model = asString(record.model);
  const maxSteps = asNumber(record.maxSteps);
  const status = asSubagentTaskStatus(record.status);
  if (!taskId || !agentType || !description || !model || maxSteps === undefined || !status) {
    return null;
  }

  return {
    type,
    taskId,
    agentType,
    description,
    model,
    maxSteps,
    status,
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(typeof record.outputPath === "string" ? { outputPath: record.outputPath } : {}),
    ...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
    ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
    ...(typeof record.apiMessageCount === "number" ? { apiMessageCount: record.apiMessageCount } : {}),
    ...(typeof record.uiMessageCount === "number" ? { uiMessageCount: record.uiMessageCount } : {})
  };
}

function asSubagentTaskStatus(value: unknown): SessionHistorySubagentEvent["status"] | null {
  return value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped"
    ? value
    : null;
}

function pruneSubagentEventsForRewind(
  events: SessionHistorySubagentEventWithSequence[],
  apiMessageCount: number,
  uiMessageCount: number
): SessionHistorySubagentEventWithSequence[] {
  return events.filter((entry) => {
    const eventApiCount = entry.event.apiMessageCount;
    if (typeof eventApiCount === "number" && eventApiCount > apiMessageCount) {
      return false;
    }

    const eventUiCount = entry.event.uiMessageCount;
    if (typeof eventUiCount === "number" && eventUiCount > uiMessageCount) {
      return false;
    }

    return true;
  });
}

function buildSubagentTaskIndex(
  events: SessionHistorySubagentEventWithSequence[]
): SessionHistorySubagentTaskIndexItem[] {
  const index = new Map<string, SessionHistorySubagentTaskIndexItem>();

  for (const entry of events) {
    const event = entry.event;
    const existing = index.get(event.taskId);
    const createdAt = existing?.createdAt ??
      event.startedAt ??
      entry.timestamp;
    const next: SessionHistorySubagentTaskIndexItem = {
      taskId: event.taskId,
      agentType: event.agentType,
      description: event.description,
      model: event.model,
      maxSteps: event.maxSteps,
      status: event.status,
      createdAt,
      updatedAt: entry.timestamp,
      ...(event.startedAt ? { startedAt: event.startedAt } : {}),
      ...(event.completedAt ? { completedAt: event.completedAt } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(event.outputPath ? { outputPath: event.outputPath } : {})
    };

    if (!next.startedAt && existing?.startedAt) {
      next.startedAt = existing.startedAt;
    }
    if (!next.completedAt && existing?.completedAt) {
      next.completedAt = existing.completedAt;
    }
    if (!next.error && existing?.error) {
      next.error = existing.error;
    }
    if (!next.outputPath && existing?.outputPath) {
      next.outputPath = existing.outputPath;
    }

    index.set(event.taskId, next);
  }

  return [...index.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function trimRewindCheckpoints(checkpoints: SessionHistoryRewindCheckpoint[]) {
  if (checkpoints.length <= MAX_REWIND_COMPAT_CHECKPOINTS) {
    return;
  }

  checkpoints.splice(0, checkpoints.length - MAX_REWIND_COMPAT_CHECKPOINTS);
}

function pruneRewindCheckpointsAfter(
  checkpoints: SessionHistoryRewindCheckpoint[],
  checkpoint: SessionHistoryRewindCheckpoint
) {
  const index = checkpoints.indexOf(checkpoint);
  if (index >= 0 && index + 1 < checkpoints.length) {
    checkpoints.splice(index + 1);
  }
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
      typeof record.createdAt === "string"
  );
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}




function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
