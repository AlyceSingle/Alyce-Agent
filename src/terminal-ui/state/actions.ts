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
import type { McpElicitationRequest } from "../../mcp/types.js";
import type {
  ActiveDialog,
  ModelPickerDialogState,
  TerminalUiRewindPoint,
  TerminalUiMessage,
  TerminalUiOverlayId,
  TerminalUiTaskSummary,
  TerminalUiState
} from "./types.js";
import type { SessionHistoryListItem } from "../../core/session-history/types.js";
import type { ContextBudgetSnapshot } from "../../core/context/contextBudget.js";

export function createInitialTerminalUiState(options: {
  connectionState: ConnectionConfigState;
  settingsState: SessionSettingsState;
  workspaceRoot: string;
  requestPatchCount: number;
  planModeEnabled?: boolean;
  connectionReady?: boolean;
}): TerminalUiState {
  const connectionReady =
    options.connectionReady ?? options.connectionState.effective.apiKey.trim().length > 0;

  return {
    workspaceRoot: options.workspaceRoot,
    connection: options.connectionState.effective,
    connectionState: options.connectionState,
    settings: options.settingsState.effective,
    settingsState: options.settingsState,
    requestPatchCount: options.requestPatchCount,
    draftInput: "",
    queuedInputs: [],
    isLoading: false,
    statusText: connectionReady ? "Idle" : "Setup required",
    planModeEnabled: options.planModeEnabled ?? false,
    contextBudget: null,
    dialogQueue: [],
    activeOverlays: [],
    messages: [],
    todos: [],
    backgroundTasks: [],
    backgroundProcessCount: 0,
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

export function replaceMessageById(
  state: TerminalUiState,
  messageId: string,
  message: TerminalUiMessage
): TerminalUiState {
  const index = state.messages.findIndex((item) => item.id === messageId);
  if (index < 0) {
    return state;
  }

  const nextMessages = [...state.messages];
  nextMessages[index] = message;

  return {
    ...state,
    messages: nextMessages,
    selectedMessageId:
      state.selectedMessageId === messageId && message.id !== messageId
        ? message.id
        : state.selectedMessageId,
    unseenDividerMessageId:
      state.unseenDividerMessageId === messageId && message.id !== messageId
        ? message.id
        : state.unseenDividerMessageId
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

export function enqueueInput(state: TerminalUiState, input: string): TerminalUiState {
  return {
    ...state,
    queuedInputs: [...state.queuedInputs, input]
  };
}

export function dequeueInput(state: TerminalUiState): TerminalUiState {
  if (state.queuedInputs.length === 0) {
    return state;
  }

  return {
    ...state,
    queuedInputs: state.queuedInputs.slice(1)
  };
}

export function clearQueuedInputs(state: TerminalUiState): TerminalUiState {
  if (state.queuedInputs.length === 0) {
    return state;
  }

  return {
    ...state,
    queuedInputs: []
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

export function setPlanModeEnabled(
  state: TerminalUiState,
  planModeEnabled: boolean
): TerminalUiState {
  if (state.planModeEnabled === planModeEnabled) {
    return state;
  }

  return {
    ...state,
    planModeEnabled
  };
}

export function setContextBudget(
  state: TerminalUiState,
  contextBudget: ContextBudgetSnapshot | null
): TerminalUiState {
  if (state.contextBudget === contextBudget) {
    return state;
  }

  // 多次 publish 可能算出相同占用；跳过无意义的状态扩散，减轻 StatusBar 抖动。
  const previous = state.contextBudget;
  if (
    previous &&
    contextBudget &&
    previous.usedPercent === contextBudget.usedPercent &&
    previous.estimatedInputTokens === contextBudget.estimatedInputTokens &&
    previous.contextWindow === contextBudget.contextWindow &&
    previous.state === contextBudget.state &&
    previous.model === contextBudget.model
  ) {
    return state;
  }

  return {
    ...state,
    contextBudget
  };
}

export function prependMessages(
  state: TerminalUiState,
  messages: TerminalUiMessage[]
): TerminalUiState {
  if (messages.length === 0) {
    return state;
  }

  const existingIds = new Set(state.messages.map((message) => message.id));
  const uniquePrepended = messages.filter((message) => !existingIds.has(message.id));
  if (uniquePrepended.length === 0) {
    return state;
  }

  const nextMessages = [...uniquePrepended, ...state.messages];
  return {
    ...state,
    messages: nextMessages,
    selectedMessageId: state.selectedMessageId ?? nextMessages.at(-1)?.id ?? null
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

export function setBackgroundTasks(
  state: TerminalUiState,
  backgroundTasks: TerminalUiTaskSummary[]
): TerminalUiState {
  return {
    ...state,
    backgroundTasks
  };
}

export function setBackgroundProcessCount(
  state: TerminalUiState,
  backgroundProcessCount: number
): TerminalUiState {
  if (state.backgroundProcessCount === backgroundProcessCount) {
    return state;
  }

  return {
    ...state,
    backgroundProcessCount
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

export function openMcpElicitationDialog(
  state: TerminalUiState,
  request: McpElicitationRequest
): TerminalUiState {
  return pushDialog(state, {
    type: "mcp-elicitation",
    layer: "overlay",
    request
  });
}

export function openSettingsDialog(
  state: TerminalUiState,
  reason?: string
): TerminalUiState {
  return pushDialog(state, {
    type: "settings",
    layer: "overlay",
    reason
  });
}

export function openPermissionsDialog(state: TerminalUiState): TerminalUiState {
  return pushDialog(state, {
    type: "permissions",
    layer: "overlay"
  });
}

export function openConnectProviderDialog(state: TerminalUiState): TerminalUiState {
  return pushDialog(state, {
    type: "connect-provider",
    layer: "modal"
  });
}

export function openModelPickerDialog(
  state: TerminalUiState,
  dialogState: ModelPickerDialogState
): TerminalUiState {
  return pushDialog(state, {
    type: "model-picker",
    layer: "modal",
    state: dialogState
  });
}

export function updateModelPickerDialogState(
  state: TerminalUiState,
  dialogState: ModelPickerDialogState
): TerminalUiState {
  const dialogIndex = state.dialogQueue.findIndex((dialog) => dialog.type === "model-picker");
  if (dialogIndex < 0) {
    return state;
  }

  const dialog = state.dialogQueue[dialogIndex];
  if (dialog?.type !== "model-picker") {
    return state;
  }

  return {
    ...state,
    dialogQueue: [
      ...state.dialogQueue.slice(0, dialogIndex),
      {
        ...dialog,
        state: dialogState
      },
      ...state.dialogQueue.slice(dialogIndex + 1)
    ]
  };
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
    // overlay 的激活/释放由组件挂载生命周期自己维护；这里直接清空会让下一层遮罩短暂失联。
    dialogQueue: state.dialogQueue.slice(1)
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
