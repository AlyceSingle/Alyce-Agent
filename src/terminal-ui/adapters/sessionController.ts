import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgentTurn } from "../../agent.js";
import { createBackgroundDiagnosticsMessage } from "../../core/api/generatedMessages.js";
import { isTurnInterruptedError, throwIfAborted } from "../../core/abort.js";
import { parseReplCommand } from "../../cli/commandRouter.js";
import { getLspDiagnosticRegistry } from "../../services/lsp/LspDiagnosticRegistry.js";
import {
  ContextOverflowError,
  isContextOverflowError,
  toContextOverflowError,
  type ContextBudgetSnapshot
} from "../../core/context/contextBudget.js";
import {
  formatMemorySnapshot,
  getHelpText,
  type SessionRuntime,
  type VolatileConversationSnapshot
} from "../../cli/sessionRuntime.js";
import type {
  ConnectionConfig,
  ConnectionConfigSaveTarget,
  SessionSettings
} from "../../config/runtime.js";
import type {
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  TodoItem,
  ToolApprovalRequest,
  ToolPermissionKind
} from "../../tools/types.js";
import {
  appendMessage,
  closeDialog,
  getActiveDialog,
  openPermissionDialog,
  openQuestionDialog,
  openRewindPickerDialog,
  openSessionPickerDialog,
  openSettingsDialog,
  prependMessages,
  replaceMessageById,
  replaceMessages,
  setConnectionConfigState,
  setContextBudget,
  setDraftInput,
  setLoading,
  setSessionAllowedKinds,
  setSessionApprovalMode,
  setSessionSettingsState,
  setStatusText,
  setTodos,
  setTranscriptSticky
} from "../state/actions.js";
import type { TerminalUiStore } from "../state/store.js";
import type {
  PermissionDecision,
  RewindRestoreMode,
  SettingsSection,
  TerminalUiMessage,
  TerminalUiRewindPoint
} from "../state/types.js";
import {
  createAssistantMessage,
  createDiagnosticsFollowUpMessage,
  createErrorMessage,
  formatDiagnosticsFollowUpForModel,
  createSystemMessage,
  createThinkingMessage,
  createToolResultMessage,
  createUserMessage,
  isEphemeralProgressMessage,
  shouldKeepUiMessage,
  shouldSkipThinkingContent
} from "./messageMapper.js";

// SessionController 负责把 REPL/UI 事件翻译成会话运行时调用，并维护中断恢复状态。
const RESTORABLE_TOOL_NAMES = new Set([
  "TaskList",
  "TaskGet",
  "Edit",
  "MultiEdit",
  "Write",
  "apply_patch"
]);
const MAX_REWIND_POINTS = 100;
const PAGED_HISTORY_INITIAL_WINDOW = 240;
const PAGED_HISTORY_CHUNK_SIZE = 120;

// 每轮请求在执行前都会记录一个 checkpoint，便于中断时回滚消息和文件改动。
interface TurnCheckpoint {
  turnId: string;
  input: string;
  createdAt: string;
  uiMessageCount: number;
  volatileSnapshot: VolatileConversationSnapshot;
  controller: AbortController;
  hasAssistantOutput: boolean;
  hasNonRestorableToolActivity: boolean;
  userCancelled: boolean;
}

interface RewindPoint {
  id: string;
  turnId: string;
  input: string;
  createdAt: string;
  uiMessageCount: number;
  volatileSnapshot: VolatileConversationSnapshot;
  hasFileChanges: boolean;
  hasNonRestorableToolActivity: boolean;
  isRestoredFromHistory: boolean;
}

interface SessionHistoryPagingState {
  allMessages: TerminalUiMessage[];
  indexById: Map<string, number>;
  loadedStartIndex: number;
  chunkSize: number;
  loading: boolean;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatPostResponseFailure(step: string, error: unknown): string {
  return `${step}: ${getErrorMessage(error)}`;
}

function formatContextCompactionMessage(options: {
  compacted: boolean;
  before: ContextBudgetSnapshot;
  after: ContextBudgetSnapshot;
  snippedMessages?: number;
  estimatedTokensSaved?: number;
}) {
  const onlySnipped = !options.compacted &&
    options.snippedMessages !== undefined &&
    options.snippedMessages > 0;
  const lines = [
    onlySnipped
      ? "Older oversized tool output was snipped before sending the model request."
      : options.compacted
        ? "Conversation was compacted before sending the model request."
        : "Alyce checked context before sending the model request, but conversation compaction did not change the prompt.",
    `Before: ${Math.round(options.before.usedPercent)}% used (${options.before.estimatedInputTokens} estimated input tokens).`,
    `After: ${Math.round(options.after.usedPercent)}% used (${options.after.estimatedInputTokens} estimated input tokens).`
  ];

  if (options.snippedMessages && options.snippedMessages > 0) {
    lines.push(
      `Snipped ${options.snippedMessages} oversized tool output message(s), saving about ${options.estimatedTokensSaved ?? 0} estimated tokens.`
    );
  }

  return lines.join("\n");
}

type CompletedTurnHistoryPlan = {
  mode: "delta" | "snapshot";
  apiMessages: SessionRuntime["messages"];
  uiBaseMessageCount: number;
};

function getApiMessagesSinceCheckpoint(checkpoint: TurnCheckpoint, runtime: SessionRuntime) {
  const baseLength = checkpoint.volatileSnapshot.messages.length;
  return runtime.messages.slice(Math.min(baseLength, runtime.messages.length));
}

async function recordCompletedTurnHistory(
  runtime: SessionRuntime,
  store: TerminalUiStore,
  plan: CompletedTurnHistoryPlan
) {
  const uiMessages = store.getState().messages.slice(plan.uiBaseMessageCount);
  if (plan.mode === "snapshot") {
    await runtime.recordSessionConversationSnapshot({
      apiMessages: plan.apiMessages,
      uiMessages,
      uiBaseMessageCount: plan.uiBaseMessageCount
    });
    return;
  }

  await runtime.recordSessionTurn({
    apiMessages: plan.apiMessages,
    uiMessages
  });
}

export interface SessionController {
  initialize: () => void;
  submit: (input: string) => Promise<void>;
  setDraftInput: (value: string) => void;
  loadOlderSessionMessages: (visibleMessageId: string | null) => void;
  interrupt: () => void;
  openRewindSelector: () => void;
  restoreRewindPoint: (pointId: string, mode: RewindRestoreMode) => Promise<void>;
  respondToApproval: (decision: PermissionDecision) => void;
  respondToQuestion: (response: AskUserQuestionResponse | null) => void;
  openSettings: (section?: SettingsSection, reason?: string) => void;
  closeDialog: () => void;
  resumeSession: (sessionId: string) => Promise<void>;
  saveConfig: (
    connectionPatch: Partial<ConnectionConfig>,
    settingsPatch: Partial<SessionSettings>,
    connectionTarget: ConnectionConfigSaveTarget
  ) => Promise<void>;
  requestExit: () => void;
  setExitHandler: (handler: (() => void) | null) => void;
}

export function createSessionController(
  runtime: SessionRuntime,
  store: TerminalUiStore
): SessionController {
  let exitHandler: (() => void) | null = null;
  let exitRequestedAfterTurn = false;
  let pendingApprovalResolver: ((decision: PermissionDecision) => void) | null = null;
  let pendingQuestionResolver: ((response: AskUserQuestionResponse | null) => void) | null = null;
  let sessionApprovalMode = runtime.getSettings().approvalMode;
  const sessionAllowedKinds = new Set<ToolPermissionKind>();
  let activeTurn: TurnCheckpoint | null = null;
  let rewindPoints: RewindPoint[] = [];
  let sessionHistoryPaging: SessionHistoryPagingState | null = null;
  const turnEphemeralMessageIds = new Map<"thinking" | "progress", string>();
  let disposeDiagnosticsSubscription: (() => void) | null = null;
  const pendingDiagnosticContextMessages: Array<ReturnType<typeof createBackgroundDiagnosticsMessage>> = [];

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

  const finishExit = () => {
    if (disposeDiagnosticsSubscription) {
      disposeDiagnosticsSubscription();
      disposeDiagnosticsSubscription = null;
    }
    void runtime.flushSessionHistory().finally(() => exitHandler?.());
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
          activeTurn ? "Interrupting and exiting..." : "Waiting for current turn to finish before exiting..."
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

  const syncApprovalState = () => {
    store.updateState((state) =>
      setSessionAllowedKinds(
        setSessionApprovalMode(state, sessionApprovalMode),
        [...sessionAllowedKinds]
      )
    );
  };

  const setDialogClosed = () => {
    store.updateState((state) => closeDialog(state));
  };

  const rollbackRuntimeConversationToCheckpoint = async (checkpoint: TurnCheckpoint) => {
    await runtime.restoreVolatileConversationSnapshot(checkpoint.volatileSnapshot);
  };

  const getAffectedRewindPoints = (target: RewindPoint) =>
    rewindPoints.filter((point) => point.uiMessageCount >= target.uiMessageCount);

  const hasRestorableFileSnapshot = (point: RewindPoint) =>
    point.hasFileChanges &&
    !point.isRestoredFromHistory &&
    runtime.hasTrackedFileChanges(point.turnId);

  const toTerminalRewindPoint = (point: RewindPoint): TerminalUiRewindPoint => {
    const affected = getAffectedRewindPoints(point);
    const hasCodeChanges = affected.some((candidate) => candidate.hasFileChanges);
    const hasUnsafeToolActivity = affected.some(
      (candidate) =>
        candidate.hasNonRestorableToolActivity ||
        (candidate.hasFileChanges && !hasRestorableFileSnapshot(candidate))
    );
    const canRestoreCode =
      hasCodeChanges &&
      !hasUnsafeToolActivity &&
      affected.every((candidate) => !candidate.hasFileChanges || hasRestorableFileSnapshot(candidate));

    return {
      id: point.id,
      input: point.input,
      createdAt: point.createdAt,
      hasCodeChanges,
      canRestoreCode,
      hasUnsafeToolActivity,
      turnsRemoved: affected.length
    };
  };

  const buildRewindDialogPoints = () => [...rewindPoints].reverse().map(toTerminalRewindPoint);

  const trimRewindPoints = () => {
    while (rewindPoints.length > MAX_REWIND_POINTS) {
      const removed = rewindPoints.shift();
      if (removed && !removed.isRestoredFromHistory) {
        runtime.discardTurn(removed.turnId);
      }
    }
  };

  const rememberRewindPoint = (checkpoint: TurnCheckpoint) => {
    const hasFileChanges = runtime.hasTrackedFileChanges(checkpoint.turnId);
    const point: RewindPoint = {
      id: checkpoint.turnId,
      turnId: checkpoint.turnId,
      input: checkpoint.input,
      createdAt: checkpoint.createdAt,
      uiMessageCount: checkpoint.uiMessageCount,
      volatileSnapshot: checkpoint.volatileSnapshot,
      hasFileChanges,
      hasNonRestorableToolActivity: checkpoint.hasNonRestorableToolActivity,
      isRestoredFromHistory: false
    };

    rewindPoints = [
      ...rewindPoints.filter((candidate) => candidate.id !== point.id),
      point
    ].sort((a, b) => a.uiMessageCount - b.uiMessageCount);

    if (!hasFileChanges || checkpoint.hasNonRestorableToolActivity) {
      runtime.discardTurn(checkpoint.turnId);
    }

    trimRewindPoints();
  };

  const openRewindSelector = () => {
    const points = buildRewindDialogPoints();
    if (points.length === 0) {
      appendUiMessage(createSystemMessage("Nothing to rewind to yet.", "Rewind"));
      return;
    }

    store.updateState((state) => openRewindPickerDialog(state, points));
  };

  const pruneRewindPointsFrom = (target: RewindPoint) => {
    const removed = getAffectedRewindPoints(target);
    for (const point of removed) {
      if (!point.isRestoredFromHistory) {
        runtime.discardTurn(point.turnId);
      }
    }
    rewindPoints = rewindPoints.filter((point) => point.uiMessageCount < target.uiMessageCount);
  };

  const restoreRewindPointById = async (pointId: string, mode: RewindRestoreMode) => {
    const target = rewindPoints.find((point) => point.id === pointId);
    if (!target) {
      appendUiMessage(createErrorMessage("That rewind point is no longer available."));
      setDialogClosed();
      return;
    }

    const view = toTerminalRewindPoint(target);
    if (mode === "code-and-conversation" && !view.canRestoreCode) {
      appendUiMessage(createErrorMessage("Code rewind is not available for that point."));
      setDialogClosed();
      return;
    }

    const affected = getAffectedRewindPoints(target);
    const restoredFiles: string[] = [];
    const removedFiles: string[] = [];

    try {
      if (mode === "code-and-conversation") {
        const newestFirst = [...affected].sort((a, b) => b.uiMessageCount - a.uiMessageCount);
        for (const point of newestFirst) {
          if (!point.hasFileChanges || point.isRestoredFromHistory) {
            continue;
          }

          const result = await runtime.restoreFilesForTurn(point.turnId);
          restoredFiles.push(...result.restored);
          removedFiles.push(...result.removed);
        }
      }

      await runtime.restoreVolatileConversationSnapshot(target.volatileSnapshot);
      const baseMessages = store.getState().messages.slice(0, target.uiMessageCount);
      const summary = [
        `Rewound to before: ${target.input}`,
        `Mode: ${mode === "code-and-conversation" ? "code and conversation" : "conversation"}`,
        `Removed turns: ${affected.length}`
      ];

      if (mode === "code-and-conversation") {
        summary.push(`Files restored: ${restoredFiles.length}`);
        summary.push(`Files removed: ${removedFiles.length}`);
      } else if (view.hasCodeChanges) {
        summary.push("File changes were left on disk.");
      }

      const systemMessage = createSystemMessage(summary.join("\n"), "Rewind");
      store.updateState((state) =>
        setDraftInput(
          setTranscriptSticky(
            setContextBudget(
              replaceMessages(setStatusText(closeDialog(state), "Rewound"), [
                ...baseMessages,
                systemMessage
              ]),
              null
            ),
            true
          ),
          target.input
        )
      );
      resetSessionHistoryPaging();

      await runtime.recordSessionRewind({
        apiMessageCount: Math.max(0, runtime.messages.length - 1),
        uiMessageCount: target.uiMessageCount,
        sessionMemory: target.volatileSnapshot.memory.sessionMemory,
        restoredInput: target.input,
        restoreMode: mode
      });

      pruneRewindPointsFrom(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendUiMessage(createErrorMessage(`Failed to rewind: ${message}`));
      store.updateState((state) => setStatusText(state, "Error"));
    }
  };

  const rebuildRewindPointsFromCurrentConversation = (uiMessages: TerminalUiMessage[]) => {
    const apiUserMessages: Array<{ input: string; runtimeMessageCount: number }> = [];
    const currentSnapshot = runtime.createVolatileConversationSnapshot();
    for (let index = 1; index < runtime.messages.length; index += 1) {
      const message = runtime.messages[index];
      if (message?.role !== "user") {
        continue;
      }

      const input = extractMessageText((message as { content?: unknown }).content);
      if (input) {
        apiUserMessages.push({
          input,
          runtimeMessageCount: index
        });
      }
    }

    const uiUserMessages = uiMessages
      .map((message, index) => ({ message, index }))
      .filter((entry) => entry.message.kind === "user");
    const count = Math.min(apiUserMessages.length, uiUserMessages.length);
    const rebuilt: RewindPoint[] = [];

    for (let index = 0; index < count; index += 1) {
      const apiUserMessage = apiUserMessages[index];
      const uiUserMessage = uiUserMessages[index];
      if (!apiUserMessage || !uiUserMessage) {
        continue;
      }

      rebuilt.push({
        id: `history-${uiUserMessage.message.id}`,
        turnId: `history-${uiUserMessage.message.id}`,
        input: apiUserMessage.input || uiUserMessage.message.content,
        createdAt: uiUserMessage.message.createdAt,
        uiMessageCount: uiUserMessage.index,
        volatileSnapshot: {
          ...currentSnapshot,
          messages: runtime.messages
            .slice(0, apiUserMessage.runtimeMessageCount)
            .map((message) => ({ ...message })),
          fileReadState: new Map(),
          memory: {
            ...currentSnapshot.memory,
            sessionMemory: null
          },
          compaction: null
        },
        hasFileChanges: false,
        hasNonRestorableToolActivity: false,
        isRestoredFromHistory: true
      });
    }

    rewindPoints = rebuilt;
    trimRewindPoints();
  };

  const requestApproval = async (
    request: ToolApprovalRequest,
    options: { signal?: AbortSignal } = {}
  ) => {
    throwIfAborted(options.signal);

    if (sessionApprovalMode === "auto") {
      return true;
    }

    if (request.scope?.type === "external-directory" && isDirectoryAlreadyAllowed(request.scope.directory)) {
      return true;
    }

    if (!request.scope && sessionAllowedKinds.has(request.kind)) {
      return true;
    }

    if (pendingApprovalResolver) {
      appendUiMessage(
        createErrorMessage("Another approval request is already pending. Denying the new request.")
      );
      return false;
    }

    store.updateState((state) => openPermissionDialog(state, request));

    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        options.signal?.removeEventListener("abort", handleAbort);
      };

      const settleDecision = async (decision: PermissionDecision) => {
        pendingApprovalResolver = null;
        cleanup();
        setDialogClosed();

        let approved = false;
        let permissionError: string | null = null;
        try {
          if (decision === "allow-once") {
            approved = true;
          } else if (decision === "allow-kind-session") {
            approved = true;
            sessionAllowedKinds.add(request.kind);
          } else if (decision === "allow-scope-session") {
            approved = true;
            await allowRequestScopeForSession(request);
          } else if (decision === "auto-approve-session") {
            approved = true;
            sessionApprovalMode = "auto";
          }
        } catch (error) {
          approved = false;
          permissionError = getErrorMessage(error);
        }

        syncApprovalState();
        appendUiMessage(
          createSystemMessage(
            [
              `${approved ? "Approved" : "Denied"} permission request.`,
              `${request.title}: ${request.summary}`,
              `Mode: ${formatPermissionDecision(decision, request)}`,
              permissionError ? `Error: ${permissionError}` : null
            ]
              .filter((line): line is string => line !== null)
              .join("\n"),
            "Permissions"
          )
        );
        await waitForUiPaint();
        resolve(approved);
      };

      // 审批结果既影响当前请求，也可能提升为“本会话允许该类操作”或“全会话自动批准”。
      const settle = (decision: PermissionDecision) => {
        void settleDecision(decision);
      };

      const handleAbort = () => {
        if (!pendingApprovalResolver) {
          cleanup();
          return;
        }

        pendingApprovalResolver = null;
        cleanup();
        setDialogClosed();
        reject(new Error("Request interrupted by user"));
      };

      if (options.signal?.aborted) {
        handleAbort();
        return;
      }

      pendingApprovalResolver = settle;
      options.signal?.addEventListener("abort", handleAbort, { once: true });
    });
  };

  const allowRequestScopeForSession = async (request: ToolApprovalRequest) => {
    if (request.scope?.type !== "external-directory") {
      sessionAllowedKinds.add(request.kind);
      return;
    }

    const absolutePath = await resolveAdditionalDirectory(request.scope.directory);
    if (isDirectoryAlreadyAllowed(absolutePath)) {
      return;
    }

    await runtime.setSessionAdditionalDirectories(
      dedupeDirectories([...runtime.getSessionAdditionalDirectories(), absolutePath])
    );
  };

  const formatPermissionDecision = (
    decision: PermissionDecision,
    request: ToolApprovalRequest
  ) => {
    if (decision === "allow-kind-session") {
      return `allow ${request.kind} for session`;
    }

    if (decision === "allow-scope-session") {
      if (request.scope?.type === "external-directory") {
        return `allow external directory for session (${request.scope.directory})`;
      }

      return `allow ${request.kind} scope for session`;
    }

    if (decision === "auto-approve-session") {
      return "auto approve session";
    }

    return decision;
  };

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
    sessionAllowedKinds.clear();
    sessionApprovalMode = runtime.getSettings().approvalMode;

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
            sessionApprovalMode
          ),
          []
        ),
        "Session resumed"
      )
    );
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

  const askUserQuestions = async (
    request: AskUserQuestionRequest,
    options: { signal?: AbortSignal } = {}
  ) => {
    if (pendingApprovalResolver || pendingQuestionResolver) {
      throw new Error("Another interactive dialog is already pending.");
    }

    store.updateState((state) => openQuestionDialog(state, request));

    return new Promise<AskUserQuestionResponse>((resolve, reject) => {
      const cleanup = () => {
        options.signal?.removeEventListener("abort", handleAbort);
      };

      const settle = (response: AskUserQuestionResponse | null) => {
        pendingQuestionResolver = null;
        cleanup();
        setDialogClosed();

        if (!response) {
          reject(new Error("User declined to answer questions"));
          return;
        }

        resolve(response);
      };

      const handleAbort = () => {
        if (!pendingQuestionResolver) {
          cleanup();
          return;
        }

        pendingQuestionResolver = null;
        cleanup();
        setDialogClosed();
        reject(new Error("Request interrupted by user"));
      };

      if (options.signal?.aborted) {
        handleAbort();
        return;
      }

      pendingQuestionResolver = settle;
      options.signal?.addEventListener("abort", handleAbort, { once: true });
    });
  };

  const resolveAdditionalDirectory = async (directory: string): Promise<string> => {
    const normalized = directory.trim();
    if (!normalized) {
      throw new Error("Directory path is required.");
    }

    const absolutePath = resolveDirectoryInput(normalized, runtime.workspaceRoot);
    let stats;
    try {
      stats = await fs.stat(absolutePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Directory not found: ${absolutePath}. ${message}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${absolutePath}`);
    }

    return absolutePath;
  };

  const resolveDirectoryInput = (directory: string, workspaceRoot: string): string => {
    const normalized = directory.trim();
    if (normalized === "~") {
      return path.resolve(os.homedir());
    }

    if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
      return path.resolve(path.join(os.homedir(), normalized.slice(2)));
    }

    return path.resolve(workspaceRoot, normalized);
  };

  const normalizePathForComparison = (directory: string) => {
    const normalized = path.resolve(directory);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };

  const dedupeDirectories = (directories: string[]) => {
    const deduped = new Map<string, string>();
    for (const directory of directories) {
      const absolutePath = path.resolve(directory);
      const key = normalizePathForComparison(absolutePath);
      if (!deduped.has(key)) {
        deduped.set(key, absolutePath);
      }
    }

    return [...deduped.values()];
  };

  const buildAccessScopeSnapshot = () => {
    return [
      "Workspace: " + runtime.workspaceRoot
    ];
  };

  const isDirectoryAlreadyAllowed = (directory: string) => {
    const targetKey = normalizePathForComparison(directory);
    return runtime
      .getAllowedRoots()
      .some((allowedRoot) => normalizePathForComparison(allowedRoot) === targetKey);
  };

  const handleCommand = async (
    parsedCommand: ReturnType<typeof parseReplCommand>
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
      store.updateState((state) => openSettingsDialog(state, parsedCommand.section));
      return true;
    }

    if (parsedCommand.type === "help") {
      appendUiMessage(createSystemMessage(getHelpText(runtime.getCurrentModel()), "Help"));
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

    if (parsedCommand.type === "rewind") {
      openRewindSelector();
      return true;
    }

    if (parsedCommand.type === "clear") {
      for (const point of rewindPoints) {
        if (!point.isRestoredFromHistory) {
          runtime.discardTurn(point.turnId);
        }
      }
      rewindPoints = [];
      resetSessionHistoryPaging();
      await runtime.clearConversation();
      store.updateState((state) =>
        setDraftInput(
          setContextBudget(
            replaceMessages(
              setTodos(setStatusText(state, "Idle"), []),
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
          setSessionSettingsState(setStatusText(state, "Idle"), runtime.getSettingsState())
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

    if (parsedCommand.type === "switch-model") {
      await runtime.setCurrentModel(parsedCommand.model);
      store.updateState((state) => setConnectionConfigState(state, runtime.getConnectionConfigState()));
      appendUiMessage(createSystemMessage("Switched model to: " + runtime.getCurrentModel(), "Model"));
      return true;
    }

    return true;
  };

  return {
    initialize: () => {
      syncDiagnosticsRegistrySettings();
      subscribeDiagnosticsFollowUps();
      appendUiMessage(createSystemMessage("Alyce terminal UI started.", "Startup"));
      appendUiMessage(
        createSystemMessage(
          [
            ...buildAccessScopeSnapshot(),
            "Model: " + runtime.getCurrentModel(),
            "Approval: " + sessionApprovalMode,
            runtime.hasConnectionConfig()
              ? "Connection: ready"
              : "Connection: API key missing, open /settings or /setup"
          ].join("\n"),
          "Session"
        )
      );

      if (!runtime.hasConnectionConfig()) {
        store.updateState((state) =>
          openSettingsDialog(state, "connection", "Connection setup is required before the first model request.")
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
      if (await handleCommand(parsedCommand)) {
        return;
      }

      if (!runtime.hasConnectionConfig()) {
        store.updateState((state) =>
          openSettingsDialog(state, "connection", "Fill API key, URL, and model before sending a prompt.")
        );
        appendUiMessage(
          createErrorMessage("Connection is incomplete. Open settings and fill API key, URL, and model.")
        );
        return;
      }

      const turnId = randomUUID();
      const controller = new AbortController();
      const checkpoint: TurnCheckpoint = {
        turnId,
        input: normalized,
        createdAt: new Date().toISOString(),
        uiMessageCount: store.getState().messages.length,
        volatileSnapshot: runtime.createVolatileConversationSnapshot(),
        controller,
        hasAssistantOutput: false,
        hasNonRestorableToolActivity: false,
        userCancelled: false
      };

      runtime.beginTurn(turnId);
      activeTurn = checkpoint;
      resetTurnEphemeralMessages();

      store.updateState((state) => setTranscriptSticky(state, true));
      const userMessage = {
        role: "user",
        content: normalized
      } as const;
      runtime.messages.push(userMessage);
      appendUiMessage(createUserMessage(normalized));
      store.updateState((state) => setLoading(setStatusText(state, "Preparing..."), true));
      let completedTurnHistoryPlan: CompletedTurnHistoryPlan | null = null;
      let turnRecorded = false;
      let conversationWasCompacted = false;
      let thinkingContent = "";

      try {
        // 每轮都绑定独立的 abort controller 和 tool context，确保取消只影响当前轮次。
        const client = runtime.requireClient();
        const currentModel = runtime.getCurrentModel();
        const gcliGeminiCompat = shouldUseGcliGeminiCompat(
          runtime.getConnectionConfig().baseURL,
          currentModel
        );
        const tools = await runtime.getMainAgentToolSchemas({
          abortSignal: controller.signal
        });
        throwIfAborted(controller.signal);
        await runtime.resetSystemMessage({
          availableTools: tools.map((tool) => tool.function.name)
        });
        store.updateState((state) => setStatusText(state, "Estimating context..."));
        throwIfAborted(controller.signal);
        const initialBudget = runtime.estimateContextBudget({
          model: currentModel,
          messages: runtime.messages,
          tools,
          gcliGeminiCompat
        });
        store.updateState((state) =>
          setContextBudget(state, initialBudget)
        );
        store.updateState((state) => setStatusText(state, "Thinking..."));
        const reply = await runAgentTurn(client, runtime.messages, {
          model: currentModel,
          maxSteps: runtime.getSettings().maxSteps,
          querySource: "main",
          gcliGeminiCompat,
          messageTimestampsEnabled: runtime.getSettings().messageTimestampsEnabled,
          abortSignal: controller.signal,
          context: runtime.createToolContext({
            turnId,
            abortSignal: controller.signal,
            requestApproval,
            askUserQuestions,
            getTodos,
            setTodos: setTodoItems,
            recordToolActivity: (toolName) => {
              if (!RESTORABLE_TOOL_NAMES.has(toolName)) {
                checkpoint.hasNonRestorableToolActivity = true;
              }
            }
          }),
          tools,
          requestPatches: runtime.requestPatches,
          contextBudgetService: runtime.getContextBudgetService(),
          refreshTools: async ({ abortSignal }) => {
            const refreshedTools = await runtime.getMainAgentToolSchemas({
              abortSignal
            });
            await runtime.resetSystemMessage({
              availableTools: refreshedTools
                .map((tool) => tool.function.name)
                .sort((left, right) => left.localeCompare(right))
            });
            return refreshedTools;
          },
          preflightCompactConversation: ({ abortSignal, querySource }) =>
            runtime.maybeCompactConversation({
              client,
              model: currentModel,
              force: true,
              querySource,
              abortSignal
            }),
          onContextBudget: (snapshot) => {
            store.updateState((state) =>
              setContextBudget(state, snapshot)
            );
          },
          onContextCompactionStart: (snapshot) => {
            store.updateState((state) =>
              setContextBudget(setStatusText(state, "Compacting context..."), snapshot)
            );
          },
          onContextCompactionResult: (event) => {
            if (event.compacted || event.snipResult?.changed) {
              conversationWasCompacted = true;
            }

            store.updateState((state) =>
              setContextBudget(
                setStatusText(state, "Thinking..."),
                event.after
              )
            );
            appendUiMessage(
              createSystemMessage(
                formatContextCompactionMessage({
                  compacted: event.compacted,
                  before: event.before,
                  after: event.after,
                  snippedMessages: event.snipResult?.snippedMessages,
                  estimatedTokensSaved: event.snipResult?.estimatedTokensSaved
                }),
                "Context"
              )
            );
          },
          onThinking: (thinking) => {
            const chunk = thinking.trim();
            if (!chunk || shouldSkipThinkingContent(chunk)) {
              return;
            }

            const nextThinkingContent = mergeThinkingContent(thinkingContent, chunk);
            if (nextThinkingContent === thinkingContent) {
              return;
            }

            thinkingContent = nextThinkingContent;
            upsertTurnEphemeralMessage("thinking", createThinkingMessage(thinkingContent));
          },
          onReconnect: (event) => {
            if (event.type === "scheduled") {
              const statusLabel = event.statusCode ? `HTTP ${event.statusCode}` : event.errorMessage;
              store.updateState((state) =>
                setStatusText(
                  state,
                  `Reconnecting ${event.attempt}/${event.maxRetries} in ${Math.ceil(
                    event.retryDelayMs / 1000
                  )}s... ${statusLabel}`
                )
              );
              return;
            }

            store.updateState((state) => setStatusText(state, "Thinking..."));
          },
          onToolCallStart: (toolName) => {
            store.updateState((state) => setStatusText(state, `Running ${toolName}...`));
          },
          onToolCallResult: (toolName, result, rawArguments) => {
            appendUiMessage(createToolResultMessage(toolName, result, rawArguments));
          }
        });

        checkpoint.hasAssistantOutput = true;
        appendUiMessage(createAssistantMessage(reply));
        completedTurnHistoryPlan = {
          mode: conversationWasCompacted ? "snapshot" : "delta",
          apiMessages: conversationWasCompacted
            ? runtime.messages.slice(1)
            : getApiMessagesSinceCheckpoint(checkpoint, runtime),
          uiBaseMessageCount: checkpoint.uiMessageCount
        };
        throwIfAborted(controller.signal);
        const postResponseFailures: string[] = [];

        try {
          if (!completedTurnHistoryPlan) {
            throw new Error("Completed turn history was not prepared.");
          }

          await recordCompletedTurnHistory(runtime, store, completedTurnHistoryPlan);
          turnRecorded = true;
          runtime.scheduleSessionMemoryExtraction({
            client,
            model: currentModel,
            querySource: "main",
            abortSignal: controller.signal
          });
        } catch (error) {
          postResponseFailures.push(formatPostResponseFailure("Session history save failed", error));
        }

        rememberRewindPoint(checkpoint);
        activeTurn = null;
        if (postResponseFailures.length > 0) {
          appendUiMessage(createErrorMessage(postResponseFailures.join("\n")));
        }
        store.updateState((state) => setStatusText(state, "Idle"));
      } catch (error) {
        if (checkpoint.hasAssistantOutput) {
          activeTurn = null;

          if (!turnRecorded && completedTurnHistoryPlan) {
            try {
              await recordCompletedTurnHistory(runtime, store, completedTurnHistoryPlan);
              turnRecorded = true;
            } catch (historyError) {
              appendUiMessage(
                createErrorMessage(
                  `Completed turn was not fully saved: ${getErrorMessage(historyError)}`
                )
              );
            }
          }

          rememberRewindPoint(checkpoint);

          if (isTurnInterruptedError(error, controller.signal)) {
            appendUiMessage(
              createSystemMessage(
                "Post-response processing was interrupted. The assistant reply was kept.",
                "Session"
              )
            );
            store.updateState((state) => setStatusText(state, "Interrupted"));
          } else {
            appendUiMessage(
              createErrorMessage(`Post-response processing failed: ${getErrorMessage(error)}`)
            );
            store.updateState((state) => setStatusText(state, "Idle"));
          }
          return;
        }

        if (isTurnInterruptedError(error, controller.signal)) {
          activeTurn = null;

          if (checkpoint.userCancelled) {
            const interruptedUiMessages = store.getState().messages.slice(checkpoint.uiMessageCount);
            try {
              if (conversationWasCompacted) {
                await runtime.recordSessionConversationSnapshot({
                  apiMessages: runtime.messages.slice(1),
                  uiMessages: interruptedUiMessages,
                  uiBaseMessageCount: checkpoint.uiMessageCount
                });
              } else {
                await runtime.recordSessionTurn({
                  apiMessages: getApiMessagesSinceCheckpoint(checkpoint, runtime),
                  uiMessages: interruptedUiMessages
                });
              }
              turnRecorded = true;
            } catch (historyError) {
              const historyMessage = getErrorMessage(historyError);
              appendUiMessage(createErrorMessage(`Interrupted turn was not saved: ${historyMessage}`));
            }

            rememberRewindPoint(checkpoint);
            appendUiMessage(
              createSystemMessage(
                [
                  "Request interrupted by user.",
                  "You can continue typing to refine the request.",
                  "Press ESC twice from empty input to choose where to rewind.",
                  checkpoint.hasNonRestorableToolActivity
                    ? "Some non-rewindable tool side effects may remain on disk."
                    : null
                ]
                  .filter((line): line is string => line !== null)
                  .join("\n"),
                "Session"
              )
            );
            store.updateState((state) => setStatusText(state, "Interrupted"));
          } else {
            // 兜底处理中断但未进入“用户主动取消”路径的情况，避免半截 turn 残留在真实会话上下文里。
            await rollbackRuntimeConversationToCheckpoint(checkpoint);
            runtime.discardTurn(turnId);
            appendUiMessage(
              createSystemMessage(
                [
                  "Request was interrupted before the assistant finished.",
                  "Partial model/tool activity was discarded from the conversation state.",
                  checkpoint.hasNonRestorableToolActivity
                    ? "Some non-rewindable tool side effects may remain on disk."
                    : null
                ]
                  .filter((line): line is string => line !== null)
                  .join("\n"),
                "Session"
              )
            );
            store.updateState((state) => setStatusText(state, "Interrupted"));
          }
        } else {
          activeTurn = null;
          await rollbackRuntimeConversationToCheckpoint(checkpoint);
          runtime.discardTurn(turnId);
          const contextOverflow = isContextOverflowError(error)
            ? toContextOverflowError(error)
            : null;
          const message = contextOverflow
            ? [
                getErrorMessage(contextOverflow),
                "",
                "This was classified as context_overflow and was not sent through the normal reconnect retry loop.",
                "Use /context to inspect the budget, then compact context or remove large attachments/tool outputs before retrying."
              ].join("\n")
            : getErrorMessage(error);
          appendUiMessage(createErrorMessage(message));
          if (contextOverflow instanceof ContextOverflowError && contextOverflow.snapshot) {
            store.updateState((state) => setContextBudget(state, contextOverflow.snapshot ?? null));
          }
          store.updateState((state) =>
            setDraftInput(setTranscriptSticky(setStatusText(state, "Error"), true), checkpoint.input)
          );
        }
      } finally {
        flushPendingDiagnosticContextMessages();
        resetTurnEphemeralMessages();
        store.updateState((state) => setLoading(state, false));

        if (exitRequestedAfterTurn && activeTurn === null && !store.getState().isLoading) {
          exitRequestedAfterTurn = false;
          finishExit();
        }
      }
    },
    setDraftInput: (value) => {
      setDraftInputValue(value);
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
      pendingApprovalResolver?.(decision);
    },
    respondToQuestion: (response) => {
      pendingQuestionResolver?.(response);
    },
    openSettings: (section = "session", reason) => {
      store.updateState((state) => openSettingsDialog(state, section, reason));
    },
    closeDialog: () => {
      const activeDialog = getActiveDialog(store.getState());
      if (activeDialog?.type === "permission" || activeDialog?.type === "question") {
        return;
      }

      setDialogClosed();
    },
    resumeSession: async (sessionId) => {
      await resumeSessionById(sessionId);
    },
    saveConfig: async (connectionPatch, settingsPatch, connectionTarget) => {
      await runtime.updateConnectionConfig(connectionPatch, connectionTarget);
      await runtime.updateSettings(settingsPatch);
      syncDiagnosticsRegistrySettings();
      if (!runtime.getSettings().historyPagingEnabled) {
        resetSessionHistoryPaging();
      }

      sessionApprovalMode = runtime.getSettings().approvalMode;
      sessionAllowedKinds.clear();

      store.updateState((state) =>
        setStatusText(
          setSessionAllowedKinds(
            setSessionApprovalMode(
              setSessionSettingsState(
                setConnectionConfigState(closeDialog(state), runtime.getConnectionConfigState()),
                runtime.getSettingsState()
              ),
              sessionApprovalMode
            ),
            []
          ),
          "Settings saved"
        )
      );

      const overriddenKeys = [
        ...Object.entries(runtime.getConnectionConfigState().sources)
          .filter(([, source]) => source === "cli")
          .map(([key]) => `connection.${key}`),
        ...Object.entries(runtime.getSettingsState().sources)
        .filter(([, source]) => source === "env" || source === "cli")
        .map(([key]) => `settings.${key}`)
      ];
      appendUiMessage(
        createSystemMessage(
          overriddenKeys.length > 0
            ? `Settings saved. Active overrides: ${overriddenKeys.join(", ")}.`
            : "Connection and runtime settings saved.",
          "Settings"
        )
      );
    },
    requestExit: () => {
      requestExit();
    },
    setExitHandler: (handler) => {
      exitHandler = handler;
    }
  };
}

function formatSessionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function extractMessageText(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }

      const record = item as { text?: unknown; content?: unknown };
      return typeof record.text === "string"
        ? record.text
        : typeof record.content === "string"
          ? record.content
          : "";
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeThinkingContent(current: string, nextChunk: string): string {
  if (!nextChunk.trim()) {
    return current;
  }

  if (!current) {
    return nextChunk;
  }

  if (current === nextChunk) {
    return current;
  }

  if (nextChunk.startsWith(current)) {
    return nextChunk;
  }

  if (current.endsWith(nextChunk)) {
    return current;
  }

  const maxOverlap = Math.min(current.length, nextChunk.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (current.endsWith(nextChunk.slice(0, overlap))) {
      return `${current}${nextChunk.slice(overlap)}`;
    }
  }

  return `${current}${nextChunk}`;
}

async function waitForUiPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export const __SESSION_CONTROLLER_TESTING__ = {
  mergeThinkingContent,
  waitForUiPaint
} as const;

function shouldUseGcliGeminiCompat(baseURL: string | undefined, model: string): boolean {
  if (!baseURL) {
    return false;
  }

  if (!model.trim().toLowerCase().startsWith("gemini")) {
    return false;
  }

  try {
    return new URL(baseURL).hostname.toLowerCase() === "gcli.ggchan.dev";
  } catch {
    return false;
  }
}
