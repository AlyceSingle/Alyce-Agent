import OpenAI from "openai";
import type { SessionMemoryFileState } from "../memory/types.js";
import type { SubagentTaskStatus } from "../../tools/types.js";
import type {
  UiMessageBlock,
  UiMessageBlockStyle,
  UiMessageBlockTone,
  UiMessageKind,
  UiToolData,
  UiToolEditResult,
  UiToolMessagePhase,
  UiToolPatchResult,
  UiToolResultKind,
  UiToolShellResult,
  UiToolWriteResult
} from "./uiMessageTypes.js";

export const SESSION_HISTORY_SCHEMA_VERSION = 1;

export type SessionId = string;
export type SessionHistoryApiMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type SessionHistoryRewindMode = "conversation" | "code-and-conversation" | "files-only";
export type SessionHistorySubagentEventType =
  | "subagent-started"
  | "subagent-notification"
  | "subagent-stopped"
  | "subagent-retrieved";

export type SessionHistoryUiMessageKind = UiMessageKind;
export type SessionHistoryUiMessageBlockTone = UiMessageBlockTone;
export type SessionHistoryUiMessageBlockStyle = UiMessageBlockStyle;
export type SessionHistoryUiMessageBlock = UiMessageBlock;
export type SessionHistoryUiToolMessagePhase = UiToolMessagePhase;
export type SessionHistoryUiToolResultKind = UiToolResultKind;
export type SessionHistoryUiToolShellResult = UiToolShellResult;
export type SessionHistoryUiToolWriteResult = UiToolWriteResult;
export type SessionHistoryUiToolEditResult = UiToolEditResult;
export type SessionHistoryUiToolPatchResult = UiToolPatchResult;
export type SessionHistoryUiToolData = UiToolData;

export interface SessionHistoryUiMessage {
  id: string;
  kind: SessionHistoryUiMessageKind;
  title: string;
  blocks: SessionHistoryUiMessageBlock[];
  content: string;
  preview: string;
  metadata: string[];
  createdAt: string;
  toolData?: SessionHistoryUiToolData;
}

export interface SessionHistorySubagentEvent {
  type: SessionHistorySubagentEventType;
  taskId: string;
  agentType: string;
  description: string;
  model: string;
  maxSteps: number;
  status: SubagentTaskStatus;
  message?: string;
  error?: string;
  outputPath?: string;
  startedAt?: string;
  completedAt?: string;
  apiMessageCount?: number;
  uiMessageCount?: number;
}

export interface SessionHistorySubagentTaskIndexItem {
  taskId: string;
  agentType: string;
  description: string;
  model: string;
  maxSteps: number;
  status: SubagentTaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  outputPath?: string;
}

export type SessionHistoryEntry =
  | {
      type: "session-meta";
      schemaVersion: number;
      sessionId: SessionId;
      workspaceRoot: string;
      createdAt: string;
    }
  | {
      type: "api-message";
      sessionId: SessionId;
      sequence: number;
      timestamp: string;
      message: SessionHistoryApiMessage;
    }
  | {
      type: "ui-message";
      sessionId: SessionId;
      sequence: number;
      timestamp: string;
      message: SessionHistoryUiMessage;
    }
  | {
      type: "session-title";
      sessionId: SessionId;
      sequence: number;
      timestamp: string;
      title: string;
    }
  | {
      type: "session-memory";
      sessionId: SessionId;
      sequence: number;
      timestamp: string;
      sessionMemory: SessionMemoryFileState | null;
    }
  | {
      type: "session-rewind";
      sessionId: SessionId;
      sequence: number;
      timestamp: string;
      apiMessageCount: number;
      uiMessageCount: number;
      restoredInput?: string;
      restoreMode?: SessionHistoryRewindMode;
      sessionMemory?: SessionMemoryFileState | null;
    }
  | {
      type: "subagent-started";
      sessionId: SessionId;
      sequence: number;
      timestamp: string;
      event: SessionHistorySubagentEvent;
    }
  | {
      type: "subagent-notification";
      sessionId: SessionId;
      sequence: number;
      timestamp: string;
      event: SessionHistorySubagentEvent;
    }
  | {
      type: "subagent-stopped";
      sessionId: SessionId;
      sequence: number;
      timestamp: string;
      event: SessionHistorySubagentEvent;
    }
  | {
      type: "subagent-retrieved";
      sessionId: SessionId;
      sequence: number;
      timestamp: string;
      event: SessionHistorySubagentEvent;
    };

export interface LoadedSessionHistory {
  sessionId: SessionId;
  filePath: string;
  workspaceRoot?: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  messageCount: number;
  lastSequence: number;
  apiMessages: SessionHistoryApiMessage[];
  uiMessages: SessionHistoryUiMessage[];
  sessionMemory: SessionMemoryFileState | null;
  subagentTaskIndex: SessionHistorySubagentTaskIndexItem[];
  subagentEvents: SessionHistorySubagentEvent[];
}

export interface SessionHistoryListItem {
  sessionId: SessionId;
  filePath: string;
  workspaceRoot?: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  messageCount: number;
}

export interface SessionResumePayload {
  sessionId: SessionId;
  title: string;
  apiMessages: SessionHistoryApiMessage[];
  uiMessages: SessionHistoryUiMessage[];
  messageCount: number;
  sessionMemory: SessionMemoryFileState | null;
  subagentTaskIndex: SessionHistorySubagentTaskIndexItem[];
}
