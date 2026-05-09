import type OpenAI from "openai";
import type { SubagentProgressEvent, SubagentTaskStatus } from "../../tools/types.js";
import type { SessionId } from "../session-history/types.js";

export const SUBAGENT_METADATA_VERSION = 1;
export const LEGACY_SUBAGENT_TASK_FILE_VERSION = 1;

export type SubagentId = string;
export type SubagentHistoryMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface SubagentStorageIdentity {
  parentSessionId: SessionId;
  transcriptPath: string;
  metadataPath: string;
  outputPath: string;
}

export interface SubagentTaskStoragePaths extends SubagentStorageIdentity {
  sessionId: SessionId;
  sessionDirectory: string;
  subagentsDirectory: string;
  taskOutputsDirectory: string;
}

export interface SubagentTaskIndexItem {
  taskId: SubagentId;
  parentSessionId: SessionId;
  agentType: string;
  description: string;
  model: string;
  maxSteps: number;
  status: SubagentTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  worktreePath?: string;
  diffSummary?: string;
  hasChanges?: boolean;
}

export interface SubagentMetadataV1 {
  version: typeof SUBAGENT_METADATA_VERSION;
  agentId: SubagentId;
  parentSessionId: SessionId;
  agentType: string;
  description: string;
  model: string;
  maxSteps: number;
  createdAt: string;
  worktreePath?: string;
  baseWorkspaceRoot?: string;
}

export interface SubagentTranscriptToolEvent {
  phase: "start" | "result";
  toolName: string;
  rawArguments?: string;
  result?: string;
}

export type SubagentTranscriptEntry =
  | {
      type: "subagent-meta";
      timestamp: string;
      agentId: SubagentId;
      parentSessionId: SessionId;
      metadata: SubagentMetadataV1;
    }
  | {
      type: "api-message";
      timestamp: string;
      agentId: SubagentId;
      parentSessionId: SessionId;
      message: SubagentHistoryMessage;
    }
  | {
      type: "tool-event";
      timestamp: string;
      agentId: SubagentId;
      parentSessionId: SessionId;
      event: SubagentTranscriptToolEvent;
    }
  | {
      type: "status";
      timestamp: string;
      agentId: SubagentId;
      parentSessionId: SessionId;
      status: SubagentTaskStatus;
      message?: string;
      error?: string;
      output?: string;
      startedAt?: string;
      completedAt?: string;
    };

export interface LegacyPersistedSubagentTaskFile {
  version: typeof LEGACY_SUBAGENT_TASK_FILE_VERSION;
  tasks: LegacyPersistedSubagentTask[];
}

export interface LegacyPersistedSubagentTask {
  taskId: SubagentId;
  agentType: string;
  description: string;
  model: string;
  maxSteps: number;
  createdAt: string;
  updatedAt: string;
  status: SubagentTaskStatus;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  progress?: SubagentProgressEvent[];
  worktreePath?: string;
  diffSummary?: string;
  hasChanges?: boolean;
  isolateWorktree?: boolean;
  baseWorkspaceRoot?: string;
  messages: SubagentHistoryMessage[];
  parentSessionId?: SessionId;
  transcriptPath?: string;
  metadataPath?: string;
  outputPath?: string;
}
