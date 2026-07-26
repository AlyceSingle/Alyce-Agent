import process from "node:process";
import { createBackgroundDiagnosticsMessage } from "../../core/api/generatedMessages.js";
import {
  runAgentUserTurn,
  type TurnCheckpoint
} from "./agentTurnRunner.js";
import { getErrorMessage } from "../../core/util/error.js";
import { formatDoctorReport, runDoctorDiagnostics } from "../../core/doctor/doctor.js";
import {
  formatDiffDetails,
  formatDiffOverview
} from "../../core/diff/diffService.js";
import { setLocale, t } from "../../i18n/index.js";
import { parseReplCommand } from "../../cli/commandRouter.js";
import { formatCurrentModelDisplay } from "../../cli/modelCommand.js";
import { normalizeLogoutProvider } from "../../cli/connectCommand.js";
import {
  formatBackgroundProcessList,
  formatBackgroundProcessStopResult
} from "../../cli/processCommand.js";
import {
  formatTaskDetails,
  formatTaskList,
  formatTaskStopResult
} from "../../cli/taskCommand.js";
import { getLspDiagnosticRegistry } from "../../services/lsp/LspDiagnosticRegistry.js";
import {
  formatMemorySnapshot,
  getHelpText,
  type SessionRuntime
} from "../../cli/sessionRuntime.js";
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
  closeDialog,
  getActiveDialog,
  openConnectProviderDialog,
  openPermissionsDialog,
  openSessionPickerDialog,
  openSettingsDialog,
  prependMessages,
  replaceMessageById,
  replaceMessages,
  setConnectionConfigState,
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
import { createDirectoryAccessHelpers } from "./sessionController/directoryAccess.js";
import { createInteractiveDialogController } from "./sessionController/interactiveDialogs.js";
import { createProviderConnectionController } from "./sessionController/providerConnection.js";
import { createRewindController } from "./sessionController/rewindController.js";
import {
  createWorkspaceCommandHandlers,
  isMcpParsedCommand,
  isSkillsParsedCommand,
  isTrustParsedCommand,
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

  const formatDiffView = async (
    target: Extract<ReturnType<typeof parseReplCommand>, { type: "diff-view" }>["target"]
  ) => {
    if (target === "overview") {
      const [lastTurn, workingTree] = await Promise.all([
        runtime.getLastAlyceTurnDiff(),
        runtime.getWorkingTreeDiff()
      ]);
      return formatDiffOverview({ lastTurn, workingTree });
    }

    if (target === "last") {
      const report = await runtime.getLastAlyceTurnDiff();
      return report ? formatDiffDetails(report) : "No Alyce turn file changes tracked yet.";
    }

    if (target === "current") {
      return formatDiffDetails(await runtime.getWorkingTreeDiff());
    }

    return formatDiffDetails(await runtime.getTurnDiff(target.turnId));
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

  const handleCommand = async (
    parsedCommand: ParsedReplCommand
  ): Promise<boolean> => {
    if (parsedCommand.type === "none") {
      return false;
    }

    if (parsedCommand.type === "command-error") {
      appendUiMessage(createErrorMessage(`${parsedCommand.message}\n${parsedCommand.input}`));
      return true;
    }

    if (parsedCommand.type === "exit") {
      requestExit();
      return true;
    }

    if (parsedCommand.type === "open-settings") {
      if (parsedCommand.section === "connection") {
        store.updateState((state) => openConnectProviderDialog(state));
        return true;
      }

      store.updateState((state) => openSettingsDialog(state));
      return true;
    }

    if (parsedCommand.type === "open-permissions") {
      store.updateState((state) => openPermissionsDialog(state));
      return true;
    }

    if (parsedCommand.type === "connect-provider") {
      if (!parsedCommand.provider && parsedCommand.args.length === 0) {
        store.updateState((state) => openConnectProviderDialog(state));
        return true;
      }

      await applyConnectProvider(parsedCommand.provider, parsedCommand.args, {
        closeActiveDialog: false,
        appendErrorMessage: true
      });
      return true;
    }

    if (parsedCommand.type === "logout-provider") {
      const providerId = normalizeLogoutProvider(parsedCommand.provider);
      if (!providerId) {
        appendUiMessage(createErrorMessage("Missing provider. Use /logout <provider>."));
        return true;
      }

      try {
        const removed = await runtime.removeProviderAuth(providerId);
        store.updateState((state) =>
          setConnectionConfigState(setStatusText(state, t("status.idle")), runtime.getConnectionConfigState())
        );
        appendUiMessage(
          createSystemMessage(
            [
              removed
                ? `Removed AuthStore credential for provider '${providerId}'.`
                : `No AuthStore credential was stored for provider '${providerId}'.`,
              "Provider profiles and selected model were not changed.",
              "If the provider still appears available, it may be using apiKey from config or apiKeyEnv from the environment."
            ].join("\n"),
            "Logout"
          )
        );
      } catch (error) {
        appendUiMessage(createErrorMessage(`Logout failed: ${getErrorMessage(error)}`));
        store.updateState((state) => setStatusText(state, t("status.error")));
      }
      return true;
    }

    if (parsedCommand.type === "help") {
      appendUiMessage(createSystemMessage(getHelpText(formatCurrentModelDisplay(runtime.getCurrentModel())), "Help"));
      return true;
    }

    if (parsedCommand.type === "doctor") {
      store.updateState((state) => setStatusText(state, t("status.runningDoctor")));
      const snapshotDiagnostics = await runtime.getSnapshotDiagnostics();
      const report = await runDoctorDiagnostics({
        workspaceRoot: runtime.workspaceRoot,
        paths: runtime.config.paths,
        connectionState: runtime.getConnectionConfigState(),
        settingsState: runtime.getSettingsState(),
        settings: runtime.getSettings(),
        currentModel: runtime.getCurrentModel(),
        hasConnectionConfig: runtime.hasConnectionConfig(),
        allowedRoots: runtime.getAllowedRoots(),
        requestPatchCount: runtime.requestPatches.length,
        providerPluginDiagnostics: runtime.config.providerPluginDiagnostics,
        projectTrust: runtime.getProjectTrustState(),
        snapshotDiagnostics
      }, {
        env: process.env,
        stdinIsTTY: process.stdin.isTTY === true,
        stdoutIsTTY: process.stdout.isTTY === true
      });
      appendUiMessage(createSystemMessage(formatDoctorReport(report), "Doctor"));
      store.updateState((state) => setStatusText(state, t("status.idle")));
      return true;
    }

    if (parsedCommand.type === "plan-enter") {
      await setPlanModeFromUi(true);
      return true;
    }

    if (parsedCommand.type === "plan-exit") {
      await setPlanModeFromUi(false);
      return true;
    }

    if (parsedCommand.type === "open-session-picker") {
      await openSessionPicker();
      return true;
    }

    if (parsedCommand.type === "resume-session") {
      await resumeSessionByQuery(parsedCommand.query);
      return true;
    }

    if (parsedCommand.type === "sessions-list") {
      const sessions = await runtime.listSessionHistory({ limit: 20 });
      appendUiMessage(createSystemMessage(formatSessionList(sessions), "Sessions"));
      return true;
    }

    if (parsedCommand.type === "revert") {
      openRewindSelector();
      return true;
    }

    if (parsedCommand.type === "diff-view") {
      store.updateState((state) => setStatusText(state, t("status.loadingDiff")));
      try {
        appendUiMessage(createSystemMessage(await formatDiffView(parsedCommand.target), "Diff"));
      } catch (error) {
        appendUiMessage(createErrorMessage(`Diff failed: ${getErrorMessage(error)}`));
      } finally {
        store.updateState((state) => setStatusText(state, t("status.idle")));
      }
      return true;
    }

    if (parsedCommand.type === "clear") {
      clearRewindPoints();
      resetSessionHistoryPaging();
      await runtime.clearConversation();
      resetTaskTracking();
      store.updateState((state) =>
        setDraftInput(
          setContextBudget(
            replaceMessages(
              setTodos(setStatusText(state, t("status.idle")), []),
              [createSystemMessage("History and session memory cleared.", "Session")]
            ),
            null
          ),
          ""
        )
      );
      return true;
    }

    if (parsedCommand.type === "remember") {
      await runtime.memoryService.remember(parsedCommand.note, {
        source: "user",
        persist: parsedCommand.persist
      });
      await runtime.resetSystemMessage();
      appendUiMessage(
        createSystemMessage(
          parsedCommand.persist
            ? "Saved to session and persistent memory."
            : "Saved to session notes only.",
          "Memory"
        )
      );
      return true;
    }

    if (parsedCommand.type === "memory-view") {
      const snapshot = await runtime.memoryService.getSnapshot();
      appendUiMessage(
        createSystemMessage(
          formatMemorySnapshot(snapshot, runtime.memoryService.getPersistentFilePath()),
          "Memory Snapshot"
        )
      );
      return true;
    }

    if (parsedCommand.type === "memory-clear") {
      await runtime.memoryService.clearSession();
      await runtime.recordSessionMemory(null);
      if (parsedCommand.clearPersistent) {
        await runtime.memoryService.clearPersistent();
      }

      await runtime.resetSystemMessage();
      appendUiMessage(
        createSystemMessage(
          parsedCommand.clearPersistent
            ? "Session and persistent memory cleared."
            : "Session memory and notes cleared.",
          "Memory"
        )
      );
      return true;
    }

    if (parsedCommand.type === "tasks-list") {
      syncBackgroundTasks();
      appendUiMessage(
        createSystemMessage(
          formatTaskList(runtime.listSubagentTasks(), unreadTaskIds),
          "Tasks"
        )
      );
      return true;
    }

    if (parsedCommand.type === "tasks-get") {
      const task = await runtime.getSubagentTask(parsedCommand.taskId);
      if (task) {
        unreadTaskIds.delete(task.taskId);
      }
      appendUiMessage(createSystemMessage(formatTaskDetails(task, parsedCommand.taskId), "Tasks"));
      syncBackgroundTasks();
      return true;
    }

    if (parsedCommand.type === "tasks-stop") {
      const result = await runtime.stopSubagentTask(parsedCommand.taskId);
      appendUiMessage(createSystemMessage(formatTaskStopResult(result), "Tasks"));
      syncBackgroundTasks();
      return true;
    }

    if (parsedCommand.type === "tasks-cleanup") {
      const report = await runtime.runSubagentStorageCleanup({
        apply: parsedCommand.apply
      });
      appendUiMessage(
        createSystemMessage(
          [
            parsedCommand.apply
              ? "Subagent storage cleanup finished."
              : "Subagent storage cleanup dry run finished.",
            `Mode: ${report.mode}`,
            `Scanned sessions: ${report.scannedSessionCount}`,
            `Orphan outputs: ${report.orphanOutputFilesFound} found, ${report.orphanOutputFilesRemoved} removed`,
            `Empty transcripts without metadata: ${report.emptyTranscriptsWithoutMetadataFound} found, ${report.emptyTranscriptsWithoutMetadataRemoved} removed`,
            `Legacy archive: ${report.migratedLegacyArchiveFound ? "found" : "not found"}, ${report.migratedLegacyArchiveRemoved ? "removed" : "kept"}`,
            `Migrated legacy fallback files: ${report.migratedLegacyFallbackFilesFound} found, ${report.migratedLegacyFallbackFilesRemoved} removed`
          ].join("\n"),
          "Subagent Cleanup"
        )
      );
      return true;
    }

    if (parsedCommand.type === "processes-list") {
      const processes = runtime.listBackgroundProcesses();
      appendUiMessage(
        createSystemMessage(
          formatBackgroundProcessList(processes),
          "Processes"
        )
      );
      syncBackgroundProcesses();
      return true;
    }

    if (parsedCommand.type === "process-stop") {
      const result = await runtime.stopBackgroundProcess(parsedCommand.processId);
      appendUiMessage(createSystemMessage(formatBackgroundProcessStopResult(result), "Processes"));
      syncBackgroundProcesses();
      return true;
    }

    if (parsedCommand.type === "usage-view") {
      appendUiMessage(createSystemMessage(runtime.formatUsageReport(), "Usage"));
      return true;
    }

    if (parsedCommand.type === "context-preview") {
      const controller = new AbortController();
      appendUiMessage(
        createSystemMessage(
          await runtime.buildContextPreview(parsedCommand.nextUserInput, {
            abortSignal: controller.signal
          }),
          "Context Preview"
        )
      );
      return true;
    }

    if (isSkillsParsedCommand(parsedCommand)) {
      await handleSkillsCommand(parsedCommand);
      return true;
    }

    if (isMcpParsedCommand(parsedCommand)) {
      await handleMcpCommand(parsedCommand);
      return true;
    }

    if (isTrustParsedCommand(parsedCommand)) {
      await handleTrustCommand(parsedCommand);
      return true;
    }

    if (parsedCommand.type === "add-directory") {
      const absolutePath = await resolveAdditionalDirectory(parsedCommand.directory);
      const alreadyAllowed = isDirectoryAlreadyAllowed(absolutePath);

      if (alreadyAllowed) {
        appendUiMessage(
          createSystemMessage(
            [`Directory is already allowed: ${absolutePath}`, ...buildAccessScopeSnapshot()].join(
              "\n"
            ),
            "Permissions"
          )
        );
        return true;
      }

      if (parsedCommand.persist) {
        const nextPersistentDirectories = dedupeDirectories([
          ...runtime.getSettings().additionalDirectories,
          absolutePath
        ]);
        await runtime.updateSettings({
          additionalDirectories: nextPersistentDirectories
        });
        syncDiagnosticsRegistrySettings();
        const normalizedTarget = normalizePathForComparison(absolutePath);
        const nextSessionDirectories = runtime
          .getSessionAdditionalDirectories()
          .filter((directory) => normalizePathForComparison(directory) !== normalizedTarget);
        await runtime.setSessionAdditionalDirectories(nextSessionDirectories);

        store.updateState((state) =>
          setSessionSettingsState(setStatusText(state, t("status.idle")), runtime.getSettingsState())
        );
        appendUiMessage(
          createSystemMessage(
            [`Allowed and saved directory: ${absolutePath}`, ...buildAccessScopeSnapshot()].join(
              "\n"
            ),
            "Permissions"
          )
        );
        return true;
      }

      const nextSessionDirectories = dedupeDirectories([
        ...runtime.getSessionAdditionalDirectories(),
        absolutePath
      ]);
      await runtime.setSessionAdditionalDirectories(nextSessionDirectories);
      appendUiMessage(
        createSystemMessage(
          [`Allowed directory for this session: ${absolutePath}`, ...buildAccessScopeSnapshot()].join(
            "\n"
          ),
          "Permissions"
        )
      );
      return true;
    }

    if (parsedCommand.type === "open-model-picker") {
      await openModelPicker();
      return true;
    }

    if (parsedCommand.type === "switch-model") {
      await switchCurrentModel(parsedCommand.model, {
        closeActiveDialog: false,
        appendErrorMessage: true
      });
      return true;
    }

    const unhandledCommand: never = parsedCommand;
    throw new Error(`Unhandled command type: ${(unhandledCommand as { type: string }).type}`);
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

      if (store.getState().isLoading) {
        appendUiMessage(createSystemMessage("A turn is already running.", "Busy"));
        return;
      }

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
          setDraftInputValue
        },
        normalized
      );
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
      if (!activeTurn || activeTurn.controller.signal.aborted) {
        return;
      }

      activeTurn.userCancelled = true;
      activeTurn.controller.abort("user-cancel");
      store.updateState((state) => setStatusText(state, "Interrupting..."));
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

