import OpenAI from "openai";
import type {
  UiMessageBlock,
  UiMessageBlockStyle,
  UiMessageBlockTone,
  UiMessageKind,
  UiToolData,
  UiToolEditResult,
  UiToolMessagePhase,
  UiToolResultKind,
  UiToolShellResult,
  UiToolWriteResult
} from "./uiMessageTypes.js";

export const SESSION_HISTORY_SCHEMA_VERSION = 1;

export type SessionId = string;
export type SessionHistoryApiMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type SessionHistoryRewindMode = "conversation" | "code-and-conversation";

export type SessionHistoryUiMessageKind = UiMessageKind;
export type SessionHistoryUiMessageBlockTone = UiMessageBlockTone;
export type SessionHistoryUiMessageBlockStyle = UiMessageBlockStyle;
export type SessionHistoryUiMessageBlock = UiMessageBlock;
export type SessionHistoryUiToolMessagePhase = UiToolMessagePhase;
export type SessionHistoryUiToolResultKind = UiToolResultKind;
export type SessionHistoryUiToolShellResult = UiToolShellResult;
export type SessionHistoryUiToolWriteResult = UiToolWriteResult;
export type SessionHistoryUiToolEditResult = UiToolEditResult;
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
      type: "session-rewind";
      sessionId: SessionId;
      sequence: number;
      timestamp: string;
      apiMessageCount: number;
      uiMessageCount: number;
      restoredInput?: string;
      restoreMode?: SessionHistoryRewindMode;
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
}
