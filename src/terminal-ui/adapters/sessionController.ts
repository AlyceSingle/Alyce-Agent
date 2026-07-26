import process from "node:process";
import { createBackgroundDiagnosticsMessage } from "../../core/api/generatedMessages.js";
import {
  runAgentUserTurn,
  type TurnCheckpoint
} from "./agentTurnRunner.js";
import { getErrorMessage } from "../../core/util/error.js";
import { setLocale, t } from "../../i18n/index.js";
import { parseReplCommand } from "../../cli/commandRouter.js";
import { formatCurrentModelDisplay } from "../../cli/modelCommand.js";
import { formatQueuedInputPreview } from "../components/QueuedInputPanel.js";
import { getLspDiagnosticRegistry } from "../../services/lsp/LspDiagnosticRegistry.js";
import { type SessionRuntime } from "../../cli/sessionRuntime.js";
import type {
  ApprovalMode,
  SessionSettings
} from "../../config/runtime.js";
import type { McpElicitationResponse } from "../../mcp/types.js";
import type {
  AskUserQuestionResponse,
  TodoItem
} from "../../tools/types.js";
import {
  appendMessage,
  clearQueuedInputs,
  closeDialog,
  dequeueInput,
  enqueueInput,
  getActiveDialog,
  openConnectProviderDialog,
  openSessionPickerDialog,
  openSettingsDialog,
  prependMessages,
  replaceMessageById,
  replaceMessages,
  setContextBudget,
  setDraftInput,
  setPlanModeEnabled,
  setSessionAllowedKinds,
  setSessionApprovalMode,
  setSessionSettingsState,
  setStatusText,
  setTodos
} from "../state/actions.js";
import type { TerminalUiStore } from "../state/store.js";
import type {
  PermissionDecision,
  RewindRestoreMode,
  TerminalUiMessage
} from "../state/types.js";
import {
  createDiagnosticsFollowUpMessage,
  createErrorMessage,
  formatDiagnosticsFollowUpForModel,
  createSystemMessage,
  isEphemeralProgressMessage,
  shouldKeepUiMessage
} from "./messageMapper.js";
import {
  buildApprovalModePermissionRules,
  buildAutoReviewPrompt,
  parseAutoReviewDecision,
  shouldSkipApprovalDialog
} from "./sessionController/approvalPolicy.js";
import { createApprovalFlowController } from "./sessionController/approvalFlow.js";
import { createBackgroundActivitySync } from "./sessionController/backgroundActivity.js";
import { createCommandDispatcher } from "./sessionController/commandDispatch.js";
import { createDirectoryAccessHelpers } from "./sessionController/directoryAccess.js";
import { createInteractiveDialogController } from "./sessionController/interactiveDialogs.js";
import { createProviderConnectionController } from "./sessionController/providerConnection.js";
import { createRewindController } from "./sessionController/rewindController.js";
import {
  createWorkspaceCommandHandlers,
  type ParsedReplCommand
} from "./sessionController/workspaceCommands.js";
import {
  formatRuntimeBootstrapSummary,
  formatSessionTime,
  isFileRestoreAvailable,
  isVisibleBackgroundProcess,
  isVisibleBackgroundTask,
  waitForUiPaint
} from "./sessionController/helpers.js";

// SessionController 负责把 REPL/UI 事件翻译成会话运行时调用，并维护中断恢复状态。
const PAGED_HISTORY_INITIAL_WINDOW = 240;
const PAGED_HISTORY_CHUNK_SIZE = 120;

// TurnCheckpoint 定义见 agentTurnRunner，避免 sessionController 与 turn 执行器类型漂移。

interface SessionHistoryPagingState {
  allMessages: TerminalUiMessage[];
  indexById: Map<string, number>;
  loadedStartIndex: number;
  chunkSize: number;
  loading: boolean;
}

type SettingsSection = "connection" | "session";

export interface SessionController {
  initialize: () => void;
  submit: (input: string) => Promise<void>;
  setDraftInput: (value: string) => void;
  togglePlanMode: () => Promise<void>;
  loadOlderSessionMessages: (visibleMessageId: string | null) => void;
  interrupt: () => void;
  /** 撤回队尾一条排队输入并填回草稿；队列为空时是空操作。 */
  withdrawQueuedInput: () => void;
  openRewindSelector: () => void;
  restoreRewindPoint: (pointId: string, mode: RewindRestoreMode) => Promise<void>;
  respondToApproval: (decision: PermissionDecision) => void;
  respondToQuestion: (response: AskUserQuestionResponse | null) => void;
  respondToMcpElicitation: (response: McpElicitationResponse) => void;
  openSettings: (section?: SettingsSection, reason?: string) => void;
  setApprovalMode: (mode: ApprovalMode) => Promise<void>;
  closeDialog: () => void;
  connectProviderFromDialog: (provider: string, args: string[]) => Promise<{ ok: true } | { ok: false; message: string }>;
  switchModelFromDialog: (model: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  authorizeProviderAuthFromDialog: (
    provider: string,
    methodIndex: number,
    inputs: Record<string, string>
  ) => Promise<
    | { ok: true; type: "stored" }
    | { ok: true; type: "flow"; method: "auto" | "code"; url: string; instructions: string }
    | { ok: false; message: string }
  >;
  completeProviderAuthFromDialog: (
    provider: string,
    methodIndex: number,
    code?: string,
    options?: { signal?: AbortSignal }
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  cancelProviderAuthFromDialog: (provider: string, methodIndex: number) => void;
  resumeSession: (sessionId: string) => Promise<void>;
  saveConfig: (settingsPatch: Partial<SessionSettings>) => Promise<void>;
  requestExit: () => void;
  setExitHandler: (handler: (() => void) | null) => void;
  dispose: () => void;
}

export interface SessionControllerOptions {
  startupContextSummary?: string;
}

export function createSessionController(
  runtime: SessionRuntime,
  store: TerminalUiStore,
  options: SessionControllerOptions = {}
): SessionController {
  let exitHandler: (() => void) | null = null;
  let exitRequestedAfterTurn = false;
  let activeTurn: TurnCheckpoint | null = null;
  let sessionHistoryPaging: SessionHistoryPagingState | null = null;
  const turnEphemeralMessageIds = new Map<"thinking" | "progress", string>();
  let disposeDiagnosticsSubscription: (() => void) | null = null;
  const pendingDiagnosticContextMessages: Array<ReturnType<typeof createBackgroundDiagnosticsMessage>> = [];
  let exitFinalizing = false;

  const resetSessionHistoryPaging = () => {
    sessionHistoryPaging = null;
  };

  const upsertPagedMessageCache = (message: TerminalUiMessage) => {
    if (!sessionHistoryPaging) {
      return;
    }

    const currentIndex = sessionHistoryPaging.indexById.get(message.id);
    if (currentIndex !== undefined) {
      sessionHistoryPaging.allMessages[currentIndex] = message;
      return;
    }

    sessionHistoryPaging.allMessages.push(message);
    sessionHistoryPaging.indexById.set(
      message.id,
      sessionHistoryPaging.allMessages.length - 1
    );
  };

  const resetTurnEphemeralMessages = () => {
    turnEphemeralMessageIds.clear();
  };

  const upsertTurnEphemeralMessage = (
    key: "thinking" | "progress",
    message: TerminalUiMessage
  ) => {
    if (!shouldKeepUiMessage(message)) {
      return;
    }

    store.updateState((state) => {
      const previousId = turnEphemeralMessageIds.get(key);
      if (!previousId) {
        turnEphemeralMessageIds.set(key, message.id);
        upsertPagedMessageCache(message);
        return appendMessage(state, message);
      }

      const previousMessage = state.messages.find((item) => item.id === previousId);
      if (!previousMessage) {
        turnEphemeralMessageIds.set(key, message.id);
        upsertPagedMessageCache(message);
        return appendMessage(state, message);
      }

      const replacement: TerminalUiMessage = {
        ...message,
        id: previousMessage.id,
        createdAt: previousMessage.createdAt
      };
      upsertPagedMessageCache(replacement);
      return replaceMessageById(state, previousMessage.id, replacement);
    });
  };

  const appendUiMessage = (message: TerminalUiMessage) => {
    if (!shouldKeepUiMessage(message)) {
      return;
    }

    if (isEphemeralProgressMessage(message)) {
      upsertTurnEphemeralMessage("progress", message);
      return;
    }

    upsertPagedMessageCache(message);
    store.updateState((state) => appendMessage(state, message));
  };

  const filterUiMessages = (messages: TerminalUiMessage[]) => messages.filter(shouldKeepUiMessage);

  const {
    syncBackgroundTasks,
    syncBackgroundProcesses,
    startTaskSync,
    stopTaskSync,
    resetTaskTracking,
    unreadTaskIds
  } = createBackgroundActivitySync({ runtime, store, appendUiMessage });

  const finishExit = () => {
    if (exitFinalizing) {
      return;
    }

    exitFinalizing = true;
    if (disposeDiagnosticsSubscription) {
      disposeDiagnosticsSubscription();
      disposeDiagnosticsSubscription = null;
    }
    stopTaskSync();
    let runningProcessCount = 0;
    let runningPtyCount = 0;
    try {
      runningProcessCount = runtime.listBackgroundProcesses().length;
    } catch {
      runningProcessCount = 0;
    }
    try {
      runningPtyCount = runtime.listPtySessions().length;
    } catch {
      runningPtyCount = 0;
    }
    if (runningProcessCount > 0 || runningPtyCount > 0) {
      store.updateState((state) => setStatusText(state, t("status.stopping")));
    }

    void (async () => {
      try {
        if (runningProcessCount > 0) {
          await runtime.stopAllBackgroundProcesses({ gracefulTimeoutMs: 3_000 });
        }
        if (runningPtyCount > 0) {
          runtime.closeAllPtySessions();
        }
      } catch {
        // Exit cleanup is best-effort; history still needs to flush.
      }
      await runtime.flushSessionHistory();
    })().finally(() => exitHandler?.());
  };

  const syncDiagnosticsRegistrySettings = () => {
    const settings = runtime.getSettings();
    getLspDiagnosticRegistry().configure({
      pendingTimeoutMs: settings.diagnosticsPendingTimeoutMs,
      circuitBreakerFailureThreshold: settings.diagnosticsFailureThreshold,
      circuitBreakerCooldownMs: settings.diagnosticsFailureCooldownMs
    });
  };

  const subscribeDiagnosticsFollowUps = () => {
    if (disposeDiagnosticsSubscription) {
      return;
    }

    disposeDiagnosticsSubscription = getLspDiagnosticRegistry().subscribeCompleted((event) => {
      const uiMessage = createDiagnosticsFollowUpMessage(event);
      appendUiMessage(uiMessage);

      const apiMessage = createBackgroundDiagnosticsMessage(formatDiagnosticsFollowUpForModel(event));
      if (activeTurn) {
        pendingDiagnosticContextMessages.push(apiMessage);
      } else {
        runtime.messages.push(apiMessage);
      }
      void runtime.recordSessionTurn({
        apiMessages: [],
        uiMessages: [uiMessage]
      }).catch(() => undefined);
    });
  };

  const flushPendingDiagnosticContextMessages = () => {
    if (activeTurn || pendingDiagnosticContextMessages.length === 0) {
      return;
    }

    runtime.messages.push(...pendingDiagnosticContextMessages.splice(0));
  };

  const requestExit = () => {
    if (activeTurn || store.getState().isLoading) {
      exitRequestedAfterTurn = true;

      if (activeTurn && !activeTurn.controller.signal.aborted) {
        activeTurn.userCancelled = true;
        activeTurn.controller.abort("user-exit");
      }

      // 运行中的 turn 必须先完成中断清理和历史落盘，再真正退出，不能直接收掉 UI。
      store.updateState((state) =>
        setStatusText(
          state,
          activeTurn ? t("status.interrupting") : t("status.waitingExit")
        )
      );
      return;
    }

    finishExit();
  };

  const setDraftInputValue = (value: string) => {
    store.updateState((state) => setDraftInput(state, value));
  };

  const getTodos = () => store.getState().todos;

  const setTodoItems = (todos: TodoItem[]) => {
    store.updateState((state) => setTodos(state, todos));
  };

  const setDialogClosed = () => {
    store.updateState((state) => closeDialog(state));
    // 弹窗期间被挡住的排队输入在这里继续。
    flushQueuedInput();
  };

  const {
    rollbackRuntimeConversationToCheckpoint,
    rememberRewindPoint,
    finalizeTurnFileChangesForRewind,
    appendPostEditSummary,
    openRewindSelector,
    restoreRewindPointById,
    rebuildRewindPointsFromCurrentConversation,
    clearRewindPoints
  } = createRewindController({
    runtime,
    store,
    appendUiMessage,
    setDialogClosed,
    resetSessionHistoryPaging
  });

  const {
    requestApproval,
    setApprovalModeFromUi,
    resetSessionPermissions,
    getSessionApprovalMode,
    hasPendingApproval,
    resolvePendingApproval
  } = createApprovalFlowController({
    runtime,
    store,
    appendUiMessage,
    setDialogClosed,
    getActiveTurn: () => activeTurn,
    isDirectoryAlreadyAllowed: (directory) => isDirectoryAlreadyAllowed(directory),
    resolveAdditionalDirectory: (directory) => resolveAdditionalDirectory(directory),
    dedupeDirectories: (directories) => dedupeDirectories(directories),
    getTodos,
    setTodoItems
  });

  const formatSessionList = (sessions: Awaited<ReturnType<SessionRuntime["listSessionHistory"]>>) => {
    if (sessions.length === 0) {
      return "No saved project sessions.";
    }

    return sessions
      .map((session, index) => {
        const marker = session.sessionId === runtime.getSessionId() ? "current" : session.sessionId.slice(0, 8);
        return [
          `${index + 1}. ${session.title || "(session)"}`,
          `   ${marker} | ${formatSessionTime(session.updatedAt)} | ${session.messageCount} messages`
        ].join("\n");
      })
      .join("\n");
  };

  const loadOlderSessionMessages = (visibleMessageId: string | null) => {
    const paging = sessionHistoryPaging;
    if (!paging || paging.loading || paging.loadedStartIndex === 0) {
      return;
    }

    const currentMessages = store.getState().messages;
    if (currentMessages.length === 0) {
      return;
    }

    if (visibleMessageId) {
      const visibleIndex = currentMessages.findIndex((message) => message.id === visibleMessageId);
      if (visibleIndex > 2) {
        return;
      }
    }

    paging.loading = true;
    try {
      const nextStart = Math.max(0, paging.loadedStartIndex - paging.chunkSize);
      const prepended = paging.allMessages.slice(nextStart, paging.loadedStartIndex);
      paging.loadedStartIndex = nextStart;
      if (prepended.length === 0) {
        return;
      }

      store.updateState((state) => prependMessages(state, prepended));
    } finally {
      paging.loading = false;
    }
  };

  const resumeSessionById = async (sessionId: string) => {
    const resumed = await runtime.resumeSessionHistory(sessionId);
    activeTurn = null;
    resetSessionPermissions();
    // 排队输入是针对上一个会话说的，不能带进新会话执行。
    cancelQueuedInputs();

    const allRestoredMessages = filterUiMessages(resumed.uiMessages as TerminalUiMessage[]);
    const historyPagingEnabled = runtime.getSettings().historyPagingEnabled;
    const initialStartIndex = historyPagingEnabled
      ? Math.max(0, allRestoredMessages.length - PAGED_HISTORY_INITIAL_WINDOW)
      : 0;
    const restoredMessages = allRestoredMessages.slice(initialStartIndex);
    if (historyPagingEnabled && initialStartIndex > 0) {
      const indexById = new Map<string, number>();
      for (let index = 0; index < allRestoredMessages.length; index += 1) {
        indexById.set(allRestoredMessages[index]!.id, index);
      }
      sessionHistoryPaging = {
        allMessages: allRestoredMessages,
        indexById,
        loadedStartIndex: initialStartIndex,
        chunkSize: PAGED_HISTORY_CHUNK_SIZE,
        loading: false
      };
    } else {
      resetSessionHistoryPaging();
    }
    rebuildRewindPointsFromCurrentConversation(restoredMessages);
    const systemMessage = createSystemMessage(
      [
        `Resumed session ${resumed.sessionId.slice(0, 8)}.`,
        `Title: ${resumed.title || "(session)"}`,
        `Messages restored: ${resumed.messageCount}`,
        sessionHistoryPaging
          ? `History paging active: loaded latest ${restoredMessages.length}, older messages load when scrolling near top.`
          : null
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
      "Session"
    );

    store.updateState((state) =>
      setStatusText(
        setSessionAllowedKinds(
          setSessionApprovalMode(
            setDraftInput(
              setContextBudget(
                setTodos(replaceMessages(closeDialog(state), [...restoredMessages, systemMessage]), []),
                null
              ),
              ""
            ),
            getSessionApprovalMode()
          ),
          []
        ),
        "Session resumed"
      )
    );
    resetTaskTracking();
    syncBackgroundTasks({ notify: false });
    syncBackgroundProcesses();
  };

  const resumeSessionByQuery = async (query: string) => {
    const matches = await runtime.findSessionHistory(query, { excludeCurrent: true });
    if (matches.length === 0) {
      appendUiMessage(createErrorMessage(`No saved session matched: ${query}`));
      return;
    }

    if (matches.length > 1) {
      appendUiMessage(
        createErrorMessage(
          [
            `Found ${matches.length} sessions matching: ${query}`,
            "Use /resume and pick one, or provide a longer session id.",
            "",
            formatSessionList(matches.slice(0, 8))
          ].join("\n")
        )
      );
      return;
    }

    await resumeSessionById(matches[0]!.sessionId);
  };

  const openSessionPicker = async () => {
    const sessions = await runtime.listSessionHistory({
      limit: 50,
      excludeCurrent: true
    });
    if (sessions.length === 0) {
      appendUiMessage(createSystemMessage("No saved project sessions found.", "Sessions"));
      return;
    }

    store.updateState((state) => openSessionPickerDialog(state, sessions));
  };

  const {
    askUserQuestions,
    requestMcpElicitation,
    respondToQuestion,
    respondToMcpElicitation
  } = createInteractiveDialogController({
    store,
    setDialogClosed,
    hasPendingApproval,
    getActiveTurn: () => activeTurn
  });

  runtime.setMcpInteractionHandlers({
    requestElicitation: requestMcpElicitation,
    onElicitationComplete: (event) => {
      appendUiMessage(
        createSystemMessage(
          `MCP browser interaction completed for ${event.serverName} (${event.elicitationId}).`,
          "MCP"
        )
      );
    }
  });

  const {
    resolveAdditionalDirectory,
    normalizePathForComparison,
    dedupeDirectories,
    buildAccessScopeSnapshot,
    isDirectoryAlreadyAllowed
  } = createDirectoryAccessHelpers({ runtime });

  const setPlanModeFromUi = async (enabled: boolean) => {
    const wasEnabled = runtime.getPlanModeState().enabled;
    const state = await runtime.setPlanModeEnabled(enabled);
    appendUiMessage(
      createSystemMessage(
        enabled
          ? wasEnabled
            ? "Plan Mode is already active. Write tools remain blocked."
              : "Model changed to Plan mode"
          : wasEnabled
              ? "Model changed to Build mode"
            : "Plan Mode is not active. Build permissions are already available.",
        "Plan Mode"
      )
    );
    store.updateState((uiState) =>
      setPlanModeEnabled(
        setStatusText(uiState, state.enabled ? "Plan Mode" : t("status.idle")),
        state.enabled
      )
    );
  };

  const {
    applyConnectProvider,
    authorizeProviderAuthFromDialog,
    completeProviderAuthFromDialog,
    cancelProviderAuthFromDialog,
    switchCurrentModel,
    openModelPicker
  } = createProviderConnectionController({ runtime, store, appendUiMessage });

  const {
    handleSkillsCommand,
    handleMcpCommand,
    handleTrustCommand
  } = createWorkspaceCommandHandlers({ runtime, appendUiMessage });

  const handleCommand = createCommandDispatcher({
    runtime,
    store,
    appendUiMessage,
    requestExit,
    applyConnectProvider,
    switchCurrentModel,
    openModelPicker,
    setPlanModeFromUi,
    openSessionPicker,
    resumeSessionByQuery,
    formatSessionList,
    openRewindSelector,
    clearRewindPoints,
    cancelQueuedInputs: () => cancelQueuedInputs(),
    resetSessionHistoryPaging,
    resetTaskTracking,
    syncBackgroundTasks,
    syncBackgroundProcesses,
    unreadTaskIds,
    syncDiagnosticsRegistrySettings,
    handleSkillsCommand,
    handleMcpCommand,
    handleTrustCommand,
    resolveAdditionalDirectory,
    normalizePathForComparison,
    dedupeDirectories,
    buildAccessScopeSnapshot,
    isDirectoryAlreadyAllowed
  });

  // submit 的主体：命令解析 + 连接检查 + Agent turn。
  // 抽成命名函数，让轮次结束后的队列 flush 能复用同一条路径。
  const runSubmittedInput = async (normalized: string) => {
    flushPendingDiagnosticContextMessages();
    setDraftInputValue("");

    const parsedCommand = parseReplCommand(normalized);
    try {
      if (await handleCommand(parsedCommand)) {
        return;
      }
    } catch (error) {
      appendUiMessage(createErrorMessage(`Command failed: ${getErrorMessage(error)}`));
      store.updateState((state) => setStatusText(state, t("status.error")));
      return;
    }

    if (!runtime.hasConnectionConfig()) {
      store.updateState((state) =>
        openConnectProviderDialog(state)
      );
      appendUiMessage(
        createErrorMessage("Connection is incomplete. Run /connect and fill provider/model details.")
      );
      return;
    }

    // 命令与连接检查已通过：进入解耦后的 Agent turn 主路径。
    await runAgentUserTurn(
      {
        store,
        runtime,
        appendUiMessage,
        upsertPagedMessageCache,
        upsertTurnEphemeralMessage,
        resetTurnEphemeralMessages,
        turnEphemeralMessageIds,
        requestApproval,
        askUserQuestions,
        getTodos,
        setTodoItems,
        flushPendingDiagnosticContextMessages,
        finalizeTurnFileChangesForRewind,
        appendPostEditSummary,
        rememberRewindPoint,
        rollbackRuntimeConversationToCheckpoint,
        syncBackgroundProcesses,
        setActiveTurn: (checkpoint) => {
          activeTurn = checkpoint;
        },
        getActiveTurn: () => activeTurn,
        isExitRequestedAfterTurn: () => exitRequestedAfterTurn,
        clearExitRequestedAfterTurn: () => {
          exitRequestedAfterTurn = false;
        },
        finishExit,
        flushQueuedInput,
        setDraftInputValue
      },
      normalized
    );
  };

  // 中断意味着“停下”，让队列继续发出会违背直觉。清空队列，但把被取消的内容
  // 回显到消息流，这样内容不会静默丢失、用户可以复制回来。
  const cancelQueuedInputs = () => {
    const queuedInputs = store.getState().queuedInputs;
    if (queuedInputs.length === 0) {
      return;
    }

    store.updateState((state) => clearQueuedInputs(state));
    appendUiMessage(
      createSystemMessage(
        [
          `Cancelled ${queuedInputs.length} queued input(s):`,
          ...queuedInputs.map((input, index) => `${index + 1}. ${formatQueuedInputPreview(input)}`)
        ].join("\n"),
        "Queue"
      )
    );
  };

  // 撤回队尾一条并填回草稿：改完可以再发，而不是直接丢掉。
  const withdrawLastQueuedInput = () => {
    const queuedInputs = store.getState().queuedInputs;
    const last = queuedInputs.at(-1);
    if (last === undefined) {
      return;
    }

    store.updateState((state) => clearQueuedInputs(state));
    for (const input of queuedInputs.slice(0, -1)) {
      store.updateState((state) => enqueueInput(state, input));
    }
    setDraftInputValue(last);
  };

  // 轮次结束后取出队首一条发出。只取一条：它会重新进入 isLoading，
  // 其余的由下一轮结束时继续 flush，避免递归加深与错序。
  const flushQueuedInput = () => {
    const state = store.getState();
    // 有对话框打开时绝不发出：输入框此时是禁用的，而 flush 会绕过那道门，
    // 在弹窗背后启动一整个 agent turn，且 Esc/Ctrl+C 都被弹窗接管、无法中断。
    // 队列留在原地，由 setDialogClosed 在弹窗关闭后接着发。
    if (state.isLoading || state.dialogQueue.length > 0) {
      return;
    }

    const next = state.queuedInputs[0];
    if (next === undefined) {
      return;
    }

    store.updateState((state) => dequeueInput(state));
    void runSubmittedInput(next).finally(() => {
      // 斜杠命令、命令报错、连接未配置这三条路径都不会进入 agent turn，
      // agentTurnRunner 的 finally 因此不会触发，队列会卡死在这里。
      // 只要发完仍未进入运行态，就继续发下一条。
      if (!store.getState().isLoading) {
        flushQueuedInput();
      }
    });
  };

  return {
    initialize: () => {
      syncDiagnosticsRegistrySettings();
      subscribeDiagnosticsFollowUps();
      startTaskSync();
      store.updateState((state) =>
        setPlanModeEnabled(state, runtime.getPlanModeState().enabled)
      );
      appendUiMessage(createSystemMessage("Alyce terminal UI started.", "Startup"));
      appendUiMessage(
        createSystemMessage(
          [
            ...buildAccessScopeSnapshot(),
            "Model: " + formatCurrentModelDisplay(runtime.getCurrentModel()),
            "Approval: " + getSessionApprovalMode(),
            runtime.hasConnectionConfig()
              ? "Connection: ready"
              : "Connection: provider/model unavailable, open /connect"
          ].join("\n"),
          "Startup"
        )
      );
      const runtimeBootstrapSummary = formatRuntimeBootstrapSummary(
        runtime.config.bootstrap,
        runtime.config.paths
      );
      if (runtimeBootstrapSummary) {
        appendUiMessage(createSystemMessage(runtimeBootstrapSummary, "Runtime"));
      }
      if (options.startupContextSummary) {
        appendUiMessage(createSystemMessage(options.startupContextSummary, "Startup Context"));
      }

      if (!runtime.hasConnectionConfig()) {
        store.updateState((state) =>
          openConnectProviderDialog(state)
        );
      }

    },
    submit: async (input) => {
      const normalized = input.trim();
      if (!normalized) {
        return;
      }

      // 轮次运行中不丢弃输入：排队，等本轮结束后由 flushQueuedInput 依次发出。
      if (store.getState().isLoading) {
        store.updateState((state) => enqueueInput(state, normalized));
        setDraftInputValue("");
        return;
      }

      await runSubmittedInput(normalized);
    },
    setDraftInput: (value) => {
      setDraftInputValue(value);
    },
    togglePlanMode: async () => {
      if (activeTurn || store.getState().isLoading) {
        appendUiMessage(createSystemMessage("Finish or interrupt the current turn before switching modes.", "Plan Mode"));
        return;
      }

      await setPlanModeFromUi(!runtime.getPlanModeState().enabled);
    },
    loadOlderSessionMessages: (visibleMessageId) => {
      loadOlderSessionMessages(visibleMessageId);
    },
    interrupt: () => {
      // 即使没有活跃轮次也要清队列：用户按 Esc 的意图就是“别再继续了”。
      cancelQueuedInputs();

      if (!activeTurn || activeTurn.controller.signal.aborted) {
        return;
      }

      activeTurn.userCancelled = true;
      activeTurn.controller.abort("user-cancel");
      store.updateState((state) => setStatusText(state, "Interrupting..."));
    },
    withdrawQueuedInput: () => {
      withdrawLastQueuedInput();
    },
    openRewindSelector: () => {
      openRewindSelector();
    },
    restoreRewindPoint: async (pointId, mode) => {
      await restoreRewindPointById(pointId, mode);
    },
    respondToApproval: (decision) => {
      resolvePendingApproval(decision);
    },
    respondToQuestion: (response) => {
      respondToQuestion(response);
    },
    respondToMcpElicitation: (response) => {
      respondToMcpElicitation(response);
    },
    openSettings: (section = "session", reason) => {
      if (section === "connection") {
        store.updateState((state) => openConnectProviderDialog(state));
        return;
      }

      store.updateState((state) => openSettingsDialog(state, reason));
    },
    setApprovalMode: async (mode) => {
      try {
        await setApprovalModeFromUi(mode, "/permissions");
      } catch (error) {
        appendUiMessage(
          createErrorMessage(`Failed to update permissions: ${getErrorMessage(error)}`)
        );
        store.updateState((state) => setStatusText(state, "Permissions update failed"));
      }
    },
    closeDialog: () => {
      const activeDialog = getActiveDialog(store.getState());
      if (
        activeDialog?.type === "permission" ||
        activeDialog?.type === "question" ||
        activeDialog?.type === "mcp-elicitation"
      ) {
        return;
      }

      setDialogClosed();
    },
    connectProviderFromDialog: async (provider, args) =>
      applyConnectProvider(provider, args, {
        closeActiveDialog: true,
        appendErrorMessage: false
      }),
    switchModelFromDialog: async (model) =>
      switchCurrentModel(model, {
        closeActiveDialog: true,
        appendErrorMessage: false
      }),
    authorizeProviderAuthFromDialog,
    completeProviderAuthFromDialog,
    cancelProviderAuthFromDialog,
    resumeSession: async (sessionId) => {
      await resumeSessionById(sessionId);
    },
    saveConfig: async (settingsPatch) => {
      if (Object.keys(settingsPatch).length === 0) {
        store.updateState((state) => setStatusText(closeDialog(state), "No settings changes"));
        appendUiMessage(createSystemMessage("No session settings changed.", "Settings"));
        return;
      }

      await runtime.updateSettings(settingsPatch);
      setLocale(runtime.getSettings().uiLanguage);
      syncDiagnosticsRegistrySettings();
      if (!runtime.getSettings().historyPagingEnabled) {
        resetSessionHistoryPaging();
      }

      resetSessionPermissions();

      store.updateState((state) =>
        setStatusText(
          setSessionAllowedKinds(
            setSessionApprovalMode(
              setSessionSettingsState(closeDialog(state), runtime.getSettingsState()),
              getSessionApprovalMode()
            ),
            []
          ),
          "Settings saved"
        )
      );

      const overriddenKeys = Object.entries(runtime.getSettingsState().sources)
        .filter(([, source]) => source === "env" || source === "cli")
        .map(([key]) => `settings.${key}`);
      appendUiMessage(
        createSystemMessage(
          overriddenKeys.length > 0
            ? `Settings saved. Active overrides: ${overriddenKeys.join(", ")}.`
            : "Session settings saved.",
          "Settings"
        )
      );
    },
    requestExit: () => {
      requestExit();
    },
    setExitHandler: (handler) => {
      exitHandler = handler;
    },
    dispose: () => {
      stopTaskSync();
      if (disposeDiagnosticsSubscription) {
        disposeDiagnosticsSubscription();
        disposeDiagnosticsSubscription = null;
      }
    }
  };
}

export const __SESSION_CONTROLLER_TESTING__ = {
  shouldSkipApprovalDialog,
  parseAutoReviewDecision,
  buildAutoReviewPrompt,
  buildApprovalModePermissionRules,
  isFileRestoreAvailable,
  isVisibleBackgroundProcess,
  isVisibleBackgroundTask,
  waitForUiPaint
} as const;

