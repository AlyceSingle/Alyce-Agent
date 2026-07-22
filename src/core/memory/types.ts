export type MemorySource = "user" | "assistant" | "system";

// 单条记忆的标准结构，便于后续做检索、压缩和展示。
export interface MemoryEntry {
  id: string;
  content: string;
  createdAt: string;
  source: MemorySource;
}

// 注入到 system prompt 的记忆视图，只保留摘要文本避免提示词膨胀。
export interface MemoryPromptContext {
  sessionSummary?: string;
  summaryUpdatedAt?: string;
  sessionMemoryPath?: string;
  sessionNotes: string[];
  persistentNotes: string[];
}

// 会话摘要状态（历史命名含 File，实际只存内存/会话历史，不再落 SESSION_MEMORY.md）。
export interface SessionMemoryFileState {
  markdown: string;
  updatedAt?: string;
}

export interface MemoryVolatileSnapshot {
  session: MemoryEntry[];
  sessionMemory: SessionMemoryFileState | null;
}

// 用于命令行展示的完整记忆快照。
export interface MemorySnapshot {
  session: MemoryEntry[];
  persistent: MemoryEntry[];
  sessionMemory: SessionMemoryFileState | null;
  sessionMemoryPath: string;
  sessionMemoryEnabled: boolean;
}

export interface SessionMemoryRuntimeConfig {
  enabled: boolean;
  initialTokens: number;
  updateTokens: number;
  toolCallsBetweenUpdates: number;
  timeoutMs: number;
  maxFailures: number;
  staleMs: number;
  maxMessagesForExtraction: number;
  maxCharsPerMessage: number;
}

// Memory 层运行配置，统一由 runtime 配置模块提供。
export interface MemoryServiceConfig {
  workspaceRoot: string;
  directory: string;
  fileName: string;
  maxSessionEntries: number;
  maxPersistentEntries: number;
  maxPromptEntries: number;
  sessionMemory: SessionMemoryRuntimeConfig;
}
