import type {
  ApprovalMode,
  ConnectionConfig,
  ConnectionConfigState,
  SessionSettings,
  SessionSettingsState
} from "../../config/runtime.js";
import type { ToolApprovalRequest, ToolPermissionKind } from "../../tools/types.js";

export type TerminalUiMessageKind =
  | "system"
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "error";

export interface TerminalUiMessage {
  id: string;
  kind: TerminalUiMessageKind;
  title: string;
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
  | { type: "permission"; request: ToolApprovalRequest }
  | { type: "settings"; section: SettingsSection; reason?: string };

export type TerminalUiOverlayId = ActiveDialog["type"];

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
  dialog: ActiveDialog | null;
  readerMessageId: string | null;
  activeOverlays: TerminalUiOverlayId[];
  messages: TerminalUiMessage[];
  selectedMessageId: string | null;
  sessionApprovalMode: ApprovalMode;
  sessionAllowedKinds: ToolPermissionKind[];
}
