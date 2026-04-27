import type {
  ApprovalMode,
  ConnectionConfig,
  ConnectionConfigState,
  SessionSettings,
  SessionSettingsState
} from "../../config/runtime.js";
import type {
  AskUserQuestionRequest,
  TodoItem,
  ToolApprovalRequest,
  ToolPermissionKind
} from "../../tools/types.js";
import type { SessionHistoryListItem } from "../../core/session-history/types.js";

export type TerminalUiMessageKind =
  | "system"
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "error";

export type TerminalUiMessageBlockTone =
  | "default"
  | "muted"
  | "info"
  | "success"
  | "warning"
  | "danger";

export type TerminalUiMessageBlockStyle = "plain" | "code";

export interface TerminalUiMessageBlock {
  label?: string;
  content: string;
  tone?: TerminalUiMessageBlockTone;
  style?: TerminalUiMessageBlockStyle;
}

export interface TerminalUiMessage {
  id: string;
  kind: TerminalUiMessageKind;
  title: string;
  blocks: TerminalUiMessageBlock[];
  content: string;
  preview: string;
  metadata: string[];
  createdAt: string;
  isTruncated: boolean;
}

export type SettingsSection = "connection" | "session";

export type PermissionDecision =
  | "allow-once"
  | "reject-once"
  | "allow-kind-session"
  | "auto-approve-session";

export type ActiveDialog =
  | { type: "permission"; layer: "overlay"; request: ToolApprovalRequest }
  | { type: "question"; layer: "overlay"; request: AskUserQuestionRequest }
  | { type: "settings"; layer: "overlay"; section: SettingsSection; reason?: string }
  | { type: "session-picker"; layer: "overlay"; sessions: SessionHistoryListItem[] }
  | { type: "reader"; layer: "modal"; messageId: string };

export type TerminalUiOverlayId = "permission" | "question" | "settings" | "session-picker";

export interface TerminalUiState {
  workspaceRoot: string;
  connection: ConnectionConfig;
  connectionState: ConnectionConfigState;
  settings: SessionSettings;
  settingsState: SessionSettingsState;
  requestPatchCount: number;
  draftInput: string;
  isLoading: boolean;
  statusText: string;
  dialogQueue: ActiveDialog[];
  activeOverlays: TerminalUiOverlayId[];
  messages: TerminalUiMessage[];
  todos: TodoItem[];
  selectedMessageId: string | null;
  transcriptSticky: boolean;
  unseenDividerMessageId: string | null;
  unseenMessageCount: number;
  sessionApprovalMode: ApprovalMode;
  sessionAllowedKinds: ToolPermissionKind[];
}
