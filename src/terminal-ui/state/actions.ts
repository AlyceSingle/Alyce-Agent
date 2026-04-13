import type { ConnectionConfig, SessionSettings } from "../../config/runtime.js";
import type { ToolApprovalRequest, ToolPermissionKind } from "../../tools/types.js";
import type {
  ActiveDialog,
  SettingsSection,
  TerminalUiMessage,
  TerminalUiState
} from "./types.js";

export function createInitialTerminalUiState(options: {
  connection: ConnectionConfig;
  settings: SessionSettings;
  workspaceRoot: string;
  requestPatchCount: number;
}): TerminalUiState {
  return {
    workspaceRoot: options.workspaceRoot,
    connection: options.connection,
    settings: options.settings,
    requestPatchCount: options.requestPatchCount,
    isLoading: false,
    statusText: options.connection.apiKey ? "Idle" : "Setup required",
    dialog: null,
    messages: [],
    selectedMessageId: null,
    sessionApprovalMode: options.settings.approvalMode,
    sessionAllowedKinds: []
  };
}

export function appendMessage(state: TerminalUiState, message: TerminalUiMessage): TerminalUiState {
  return {
    ...state,
    messages: [...state.messages, message],
    selectedMessageId: message.id
  };
}

export function replaceMessages(
  state: TerminalUiState,
  messages: TerminalUiMessage[]
): TerminalUiState {
  return {
    ...state,
    messages,
    selectedMessageId: messages.at(-1)?.id ?? null
  };
}

export function setLoading(state: TerminalUiState, isLoading: boolean): TerminalUiState {
  return {
    ...state,
    isLoading
  };
}

export function setStatusText(state: TerminalUiState, statusText: string): TerminalUiState {
  return {
    ...state,
    statusText
  };
}

export function openPermissionDialog(
  state: TerminalUiState,
  request: ToolApprovalRequest
): TerminalUiState {
  return {
    ...state,
    dialog: {
      type: "permission",
      request
    }
  };
}

export function openSettingsDialog(
  state: TerminalUiState,
  section: SettingsSection,
  reason?: string
): TerminalUiState {
  return {
    ...state,
    dialog: {
      type: "settings",
      section,
      reason
    }
  };
}

export function openMessageDetailDialog(
  state: TerminalUiState,
  messageId: string
): TerminalUiState {
  return {
    ...state,
    dialog: {
      type: "message-detail",
      messageId
    }
  };
}

export function closeDialog(state: TerminalUiState): TerminalUiState {
  return {
    ...state,
    dialog: null
  };
}

export function setDialog(state: TerminalUiState, dialog: ActiveDialog | null): TerminalUiState {
  return {
    ...state,
    dialog
  };
}

export function setConnectionConfig(
  state: TerminalUiState,
  connection: ConnectionConfig
): TerminalUiState {
  return {
    ...state,
    connection
  };
}

export function setSessionSettings(
  state: TerminalUiState,
  settings: SessionSettings
): TerminalUiState {
  return {
    ...state,
    settings
  };
}

export function setSelectedMessageId(
  state: TerminalUiState,
  selectedMessageId: string | null
): TerminalUiState {
  return {
    ...state,
    selectedMessageId
  };
}

export function selectRelativeMessage(state: TerminalUiState, delta: number): TerminalUiState {
  if (state.messages.length === 0) {
    return state;
  }

  const currentIndex = Math.max(
    0,
    state.messages.findIndex((message) => message.id === state.selectedMessageId)
  );
  const nextIndex = Math.min(state.messages.length - 1, Math.max(0, currentIndex + delta));

  return {
    ...state,
    selectedMessageId: state.messages[nextIndex]?.id ?? state.selectedMessageId
  };
}

export function setSessionApprovalMode(
  state: TerminalUiState,
  sessionApprovalMode: SessionSettings["approvalMode"]
): TerminalUiState {
  return {
    ...state,
    sessionApprovalMode
  };
}

export function setSessionAllowedKinds(
  state: TerminalUiState,
  sessionAllowedKinds: ToolPermissionKind[]
): TerminalUiState {
  return {
    ...state,
    sessionAllowedKinds
  };
}

export function allowSessionKind(
  state: TerminalUiState,
  kind: ToolPermissionKind
): TerminalUiState {
  if (state.sessionAllowedKinds.includes(kind)) {
    return state;
  }

  return {
    ...state,
    sessionAllowedKinds: [...state.sessionAllowedKinds, kind]
  };
}
