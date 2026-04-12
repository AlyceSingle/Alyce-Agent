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
  sessionNotes: string[];
  persistentNotes: string[];
}

// 用于命令行展示的完整记忆快照。
export interface MemorySnapshot {
  session: MemoryEntry[];
  persistent: MemoryEntry[];
}

// Memory 层运行配置，统一由 runtime 配置模块提供。
export interface MemoryServiceConfig {
  workspaceRoot: string;
  directory: string;
  fileName: string;
  maxSessionEntries: number;
  maxPersistentEntries: number;
  maxPromptEntries: number;
}
