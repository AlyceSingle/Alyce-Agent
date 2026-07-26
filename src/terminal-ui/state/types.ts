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
import type { McpElicitationRequest } from "../../mcp/types.js";
import type { SessionHistoryListItem } from "../../core/session-history/types.js";
import type { ContextBudgetSnapshot } from "../../core/context/contextBudget.js";
import type {
  UiMessageBlock,
  UiMessageBlockStyle,
  UiMessageBlockTone,
  UiMessageKind,
  UiToolData,
  UiToolEditResult,
  UiToolMessagePhase,
  UiToolPatchResult,
  UiToolReadResult,
  UiToolResultKind,
  UiToolShellResult,
  UiToolWriteResult
} from "../../core/session-history/uiMessageTypes.js";

export type TerminalUiMessageKind = UiMessageKind;
export type TerminalUiMessageBlockTone = UiMessageBlockTone;
export type TerminalUiMessageBlockStyle = UiMessageBlockStyle;
export type TerminalUiMessageBlock = UiMessageBlock;
export type TerminalUiToolMessagePhase = UiToolMessagePhase;
export type TerminalUiToolResultKind = UiToolResultKind;
export type TerminalUiToolShellResult = UiToolShellResult;
export type TerminalUiToolWriteResult = UiToolWriteResult;
export type TerminalUiToolEditResult = UiToolEditResult;
export type TerminalUiToolPatchResult = UiToolPatchResult;
export type TerminalUiToolReadResult = UiToolReadResult;
export type TerminalUiToolData = UiToolData;

export interface TerminalUiMessage {
  id: string;
  kind: TerminalUiMessageKind;
  title: string;
  blocks: TerminalUiMessageBlock[];
  content: string;
  preview: string;
  metadata: string[];
  createdAt: string;
  toolData?: TerminalUiToolData;
}

export type RewindRestoreMode = "files-only" | "conversation" | "code-and-conversation";

export interface ModelPickerDialogState {
  status: "loading" | "ready";
  providerId: string;
  providerLabel: string;
  source?: "live" | "fallback";
  error?: string;
}

export interface TerminalUiRewindPoint {
  id: string;
  input: string;
  createdAt: string;
  hasCodeChanges: boolean;
  canRestoreFilesOnly: boolean;
  canRestoreCode: boolean;
  hasUnsafeToolActivity: boolean;
  turnsRemoved: number;
}

export interface TerminalUiTaskSummary {
  taskId: string;
  agentType: string;
  description: string;
}

export type PermissionDecision =
  | "allow-once"
  | "reject-once"
  | "allow-kind-session"
  | "allow-tool-session"
  | "allow-tool-persistent"
  | "ask-tool-persistent"
  | "deny-tool-persistent"
  | "allow-scope-session"
  | "full-access-session";

export type ActiveDialog =
  | { type: "permission"; layer: "overlay"; request: ToolApprovalRequest }
  | { type: "question"; layer: "overlay"; request: AskUserQuestionRequest }
  | { type: "mcp-elicitation"; layer: "overlay"; request: McpElicitationRequest }
  | { type: "settings"; layer: "overlay"; reason?: string }
  | { type: "permissions"; layer: "overlay" }
  | { type: "connect-provider"; layer: "modal" }
  | { type: "model-picker"; layer: "modal"; state: ModelPickerDialogState }
  | { type: "session-picker"; layer: "modal"; sessions: SessionHistoryListItem[] }
  | { type: "rewind-picker"; layer: "overlay"; points: TerminalUiRewindPoint[] };

export type TerminalUiOverlayId =
  | "permission"
  | "permissions"
  | "question"
  | "mcp-elicitation"
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
  /** 轮次运行期间提交的输入按顺序排队，在轮次结束后逐条发出。 */
  queuedInputs: string[];
  isLoading: boolean;
  statusText: string;
  planModeEnabled: boolean;
  contextBudget: ContextBudgetSnapshot | null;
  dialogQueue: ActiveDialog[];
  activeOverlays: TerminalUiOverlayId[];
  messages: TerminalUiMessage[];
  todos: TodoItem[];
  backgroundTasks: TerminalUiTaskSummary[];
  backgroundProcessCount: number;
  selectedMessageId: string | null;
  transcriptSticky: boolean;
  unseenDividerMessageId: string | null;
  unseenMessageCount: number;
  sessionApprovalMode: ApprovalMode;
  sessionAllowedKinds: ToolPermissionKind[];
}
