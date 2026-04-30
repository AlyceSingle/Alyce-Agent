import type {
  ApprovalMode,
  ConnectionConfigState,
  SessionSettingsState
} from "../../config/runtime.js";
import type {
  AskUserQuestionRequest,
  TodoItem,
  ToolApprovalRequest,
  ToolPermissionKind
} from "../../tools/types.js";
import type {
  ActiveDialog,
  TerminalUiRewindPoint,
  SettingsSection,
  TerminalUiMessage,
  TerminalUiOverlayId,
  TerminalUiState
} from "./types.js";
import type { SessionHistoryListItem } from "../../core/session-history/types.js";

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
    dialogQueue: [],
    activeOverlays: [],
    messages: [],
    todos: [],
    selectedMessageId: null,
    transcriptSticky: true,
    unseenDividerMessageId: null,
    unseenMessageCount: 0,
    sessionApprovalMode: options.settingsState.effective.approvalMode,
    sessionAllowedKinds: []
  };
}

export function appendMessage(state: TerminalUiState, message: TerminalUiMessage): TerminalUiState {
  const nextMessages = [...state.messages, message];

  if (state.transcriptSticky) {
    return {
      ...state,
      messages: nextMessages,
      selectedMessageId: message.id,
      unseenDividerMessageId: null,
      unseenMessageCount: 0
    };
  }

  return {
    ...state,
    messages: nextMessages,
    unseenDividerMessageId: state.unseenDividerMessageId ?? message.id,
    unseenMessageCount: state.unseenMessageCount + 1
  };
}

export function replaceMessages(
  state: TerminalUiState,
  messages: TerminalUiMessage[]
): TerminalUiState {
  return {
    ...state,
    messages,
    selectedMessageId: messages.at(-1)?.id ?? null,
    transcriptSticky: true,
    unseenDividerMessageId: null,
    unseenMessageCount: 0
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

export function setTodos(state: TerminalUiState, todos: TodoItem[]): TerminalUiState {
  if (state.todos === todos) {
    return state;
  }

  return {
    ...state,
    todos
  };
}

export function getActiveDialog(state: TerminalUiState): ActiveDialog | null {
  return state.dialogQueue[0] ?? null;
}

function pushDialog(state: TerminalUiState, dialog: ActiveDialog): TerminalUiState {
  const firstModalIndex =
    dialog.layer === "overlay"
      ? state.dialogQueue.findIndex((currentDialog) => currentDialog.layer === "modal")
      : -1;

  return {
    ...state,
    dialogQueue:
      firstModalIndex === -1
        ? [...state.dialogQueue, dialog]
        : [
            ...state.dialogQueue.slice(0, firstModalIndex),
            dialog,
            ...state.dialogQueue.slice(firstModalIndex)
          ]
  };
}

export function openPermissionDialog(
  state: TerminalUiState,
  request: ToolApprovalRequest
): TerminalUiState {
  return pushDialog(state, {
    type: "permission",
    layer: "overlay",
    request
  });
}

export function openQuestionDialog(
  state: TerminalUiState,
  request: AskUserQuestionRequest
): TerminalUiState {
  return pushDialog(state, {
    type: "question",
    layer: "overlay",
    request
  });
}

export function openSettingsDialog(
  state: TerminalUiState,
  section: SettingsSection,
  reason?: string
): TerminalUiState {
  return pushDialog(state, {
    type: "settings",
    layer: "overlay",
    section,
    reason
  });
}

export function openSessionPickerDialog(
  state: TerminalUiState,
  sessions: SessionHistoryListItem[]
): TerminalUiState {
  return pushDialog(state, {
    type: "session-picker",
    layer: "modal",
    sessions
  });
}

export function openRewindPickerDialog(
  state: TerminalUiState,
  points: TerminalUiRewindPoint[]
): TerminalUiState {
  return pushDialog(state, {
    type: "rewind-picker",
    layer: "overlay",
    points
  });
}

export function closeDialog(state: TerminalUiState): TerminalUiState {
  if (state.dialogQueue.length === 0) {
    return state;
  }

  return {
    ...state,
    dialogQueue: state.dialogQueue.slice(1),
    activeOverlays: []
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
  if (state.selectedMessageId === selectedMessageId) {
    return state;
  }

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

export function setTranscriptSticky(state: TerminalUiState, transcriptSticky: boolean): TerminalUiState {
  if (state.transcriptSticky === transcriptSticky) {
    return state;
  }

  if (!transcriptSticky) {
    return {
      ...state,
      transcriptSticky: false
    };
  }

  return {
    ...state,
    transcriptSticky: true,
    unseenDividerMessageId: null,
    unseenMessageCount: 0,
    selectedMessageId: state.messages.at(-1)?.id ?? state.selectedMessageId
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
