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
} from "../../core/session-history/uiMessageTypes.js";

<<<<<<< HEAD
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
=======
export type TerminalUiMessageKind = UiMessageKind;
export type TerminalUiMessageBlockTone = UiMessageBlockTone;
export type TerminalUiMessageBlockStyle = UiMessageBlockStyle;
export type TerminalUiMessageBlock = UiMessageBlock;
export type TerminalUiToolMessagePhase = UiToolMessagePhase;
export type TerminalUiToolResultKind = UiToolResultKind;
export type TerminalUiToolShellResult = UiToolShellResult;
export type TerminalUiToolWriteResult = UiToolWriteResult;
export type TerminalUiToolEditResult = UiToolEditResult;
export type TerminalUiToolData = UiToolData;
>>>>>>> 3154985 (Refine transcript diff rendering)

export interface TerminalUiMessage {
  id: string;
  kind: TerminalUiMessageKind;
  title: string;
  blocks: TerminalUiMessageBlock[];
  content: string;
  preview: string;
  metadata: string[];
  createdAt: string;
}

export type SettingsSection = "connection" | "session";

export type RewindRestoreMode = "conversation" | "code-and-conversation";

export interface TerminalUiRewindPoint {
  id: string;
  input: string;
  createdAt: string;
  hasCodeChanges: boolean;
  canRestoreCode: boolean;
  hasUnsafeToolActivity: boolean;
  turnsRemoved: number;
}

export type PermissionDecision =
  | "allow-once"
  | "reject-once"
  | "allow-kind-session"
  | "auto-approve-session";

export type ActiveDialog =
  | { type: "permission"; layer: "overlay"; request: ToolApprovalRequest }
  | { type: "question"; layer: "overlay"; request: AskUserQuestionRequest }
  | { type: "settings"; layer: "overlay"; section: SettingsSection; reason?: string }
  | { type: "session-picker"; layer: "modal"; sessions: SessionHistoryListItem[] }
  | { type: "rewind-picker"; layer: "overlay"; points: TerminalUiRewindPoint[] }
  | { type: "reader"; layer: "modal"; messageId: string };

export type TerminalUiOverlayId =
  | "permission"
  | "question"
  | "settings"
  | "rewind-picker";

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
