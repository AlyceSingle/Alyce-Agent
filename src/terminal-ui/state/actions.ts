import type {
  ApprovalMode,
  ConnectionConfigState,
  SessionSettingsState
} from "../../config/runtime.js";
import type { ToolApprovalRequest, ToolPermissionKind } from "../../tools/types.js";
import type {
  ActiveDialog,
  SettingsSection,
  TerminalUiMessage,
  TerminalUiOverlayId,
  TerminalUiState
} from "./types.js";

// 这里保持纯函数式状态变换，便于 UI 层按需组合更新而不引入副作用。
export function createInitialTerminalUiState(options: {
  connectionState: ConnectionConfigState;
  settingsState: SessionSettingsState;
  workspaceRoot: string;
  requestPatchCount: number;
}): TerminalUiState {
  return {
    workspaceRoot: options.workspaceRoot,
    connection: options.connectionState.effective,
    connectionState: options.connectionState,
    settings: options.settingsState.effective,
    settingsState: options.settingsState,
    requestPatchCount: options.requestPatchCount,
    draftInput: "",
    isLoading: false,
    statusText: options.connectionState.effective.apiKey ? "Idle" : "Setup required",
    dialog: null,
    readerMessageId: null,
    activeOverlays: [],
    messages: [],
    selectedMessageId: null,
    sessionApprovalMode: options.settingsState.effective.approvalMode,
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
  if (state.isLoading === isLoading) {
    return state;
  }

  return {
    ...state,
    isLoading
  };
}

export function setDraftInput(state: TerminalUiState, draftInput: string): TerminalUiState {
  if (state.draftInput === draftInput) {
    return state;
  }

  return {
    ...state,
    draftInput
  };
}

export function setStatusText(state: TerminalUiState, statusText: string): TerminalUiState {
  if (state.statusText === statusText) {
    return state;
  }

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

export function openMessageReader(
  state: TerminalUiState,
  messageId: string
): TerminalUiState {
  return {
    ...state,
    readerMessageId: messageId
  };
}

export function closeMessageReader(state: TerminalUiState): TerminalUiState {
  if (!state.readerMessageId) {
    return state;
  }

  return {
    ...state,
    readerMessageId: null
  };
}

export function closeDialog(state: TerminalUiState): TerminalUiState {
  return {
    ...state,
    dialog: null,
    activeOverlays: []
  };
}

export function setDialog(state: TerminalUiState, dialog: ActiveDialog | null): TerminalUiState {
  return {
    ...state,
    dialog,
    activeOverlays: dialog ? state.activeOverlays : []
  };
}

export function setConnectionConfigState(
  state: TerminalUiState,
  connectionState: ConnectionConfigState
): TerminalUiState {
  return {
    ...state,
    connection: connectionState.effective,
    connectionState
  };
}

export function setSessionSettingsState(
  state: TerminalUiState,
  settingsState: SessionSettingsState
): TerminalUiState {
  return {
    ...state,
    settings: settingsState.effective,
    settingsState
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

  // 找不到当前选中项时回退到首条消息，避免新增消息后出现“空选中”状态。
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
  sessionApprovalMode: ApprovalMode
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

export function setOverlayActive(
  state: TerminalUiState,
  overlayId: TerminalUiOverlayId,
  active: boolean
): TerminalUiState {
  if (active) {
    if (state.activeOverlays.includes(overlayId)) {
      return state;
    }

    return {
      ...state,
      activeOverlays: [...state.activeOverlays, overlayId]
    };
  }

  if (!state.activeOverlays.includes(overlayId)) {
    return state;
  }

  return {
    ...state,
    activeOverlays: state.activeOverlays.filter((currentId) => currentId !== overlayId)
  };
}
