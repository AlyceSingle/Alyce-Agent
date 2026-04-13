import type { ApprovalMode, ConnectionConfig, SessionSettings } from "../../config/runtime.js";
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
  | { type: "settings"; section: SettingsSection; reason?: string }
  | { type: "message-detail"; messageId: string };

export interface TerminalUiState {
  workspaceRoot: string;
  connection: ConnectionConfig;
  settings: SessionSettings;
  requestPatchCount: number;
  isLoading: boolean;
  statusText: string;
  dialog: ActiveDialog | null;
  messages: TerminalUiMessage[];
  selectedMessageId: string | null;
  sessionApprovalMode: ApprovalMode;
  sessionAllowedKinds: ToolPermissionKind[];
}
