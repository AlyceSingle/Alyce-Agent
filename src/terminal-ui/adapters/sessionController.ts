import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runAgentTurn } from "../../agent.js";
import { createBackgroundDiagnosticsMessage } from "../../core/api/generatedMessages.js";
import { isTurnInterruptedError, throwIfAborted, TurnInterruptedError } from "../../core/abort.js";
import { formatDoctorReport, runDoctorDiagnostics } from "../../core/doctor/doctor.js";
import {
  formatDiffDetails,
  formatDiffOverview,
  formatPostEditSummary,
  type DiffFileReport,
  type TurnDiffReport
} from "../../core/diff/diffService.js";
import type { FileHistoryRestoreResult } from "../../core/file-history/fileHistoryManager.js";
import { createPlanModeOverlayRules } from "../../core/planMode/planMode.js";
import {
  createDefaultPermissionRuleSet,
  createPermissionRuleSet,
  evaluatePermission,
  getPermissionCategoriesForLegacyKind,
  getPermissionCategoriesForToolKind,
  normalizePermissionPattern,
  type PermissionCategory,
  type PermissionEvaluation,
  type PermissionRuleInput
} from "../../core/permissions/permissionRules.js";
import { parseReplCommand } from "../../cli/commandRouter.js";
import {
  formatCurrentModelDisplay,
  formatModelStatusReport,
  resolveModelSwitch
} from "../../cli/modelCommand.js";
import {
  formatBackgroundProcessList,
  formatBackgroundProcessStopResult
} from "../../cli/processCommand.js";
import {
  formatTaskCompletionNotification,
  formatTaskDetails,
  formatTaskList,
  formatTaskStopResult,
  isTerminalTaskStatus
} from "../../cli/taskCommand.js";
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
  SubagentTaskInfo,
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
  setBackgroundProcessCount,
  setBackgroundTasks,
  setLoading,
  setPlanModeEnabled,
  setSessionAllowedKinds,
  setSessionApprovalMode,
  setSessionFullApprovalEnabled,
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
  TerminalUiRewindPoint,
  TerminalUiTaskSummary
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
  "apply_patch",
  "Bash",
  "PowerShell"
]);
const BACKGROUND_PROCESS_TOOL_NAMES = new Set([
  "ProcessStart",
  "ProcessList",
  "ProcessRead",
  "ProcessStop"
]);
const MAX_REWIND_POINTS = 100;
const PAGED_HISTORY_INITIAL_WINDOW = 240;
const PAGED_HISTORY_CHUNK_SIZE = 120;
const TASK_SYNC_INTERVAL_MS = 1000;
const REVERT_FILES_ONLY_LABEL = "Files only";
const REVERT_FILES_AND_CONVERSATION_LABEL = "Files and conversation";
const REVERT_CONVERSATION_ONLY_LABEL = "Conversation only";
const REVERT_CANCEL_LABEL = "Cancel";

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

function formatTurnInterruptedMessage(error: unknown, checkpoint: TurnCheckpoint): string {
  const lines = [
    checkpoint.userCancelled || isUserCancelInterrupt(error)
      ? "Request interrupted by user."
      : getErrorMessage(error),
    checkpoint.hasNonRestorableToolActivity
      ? "Some non-rewindable tool side effects may remain on disk."
      : null
  ];

  return lines.filter((line): line is string => line !== null).join("\n");
}

function isUserCancelInterrupt(error: unknown): boolean {
  return error instanceof TurnInterruptedError &&
    (error.reason === "user-cancel" || error.reason === "user-exit");
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
  togglePlanMode: () => Promise<void>;
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
  let pendingApprovalResolver: ((decision: PermissionDecision) => void) | null = null;
  let pendingQuestionResolver: ((response: AskUserQuestionResponse | null) => void) | null = null;
  let sessionApprovalMode = runtime.getSettings().approvalMode;
  let sessionFullApprovalEnabled = false;
  const sessionAllowedKinds = new Set<ToolPermissionKind>();
  let sessionPermissionRules: PermissionRuleInput[] = [];
  let activeTurn: TurnCheckpoint | null = null;
  let rewindPoints: RewindPoint[] = [];
  let sessionHistoryPaging: SessionHistoryPagingState | null = null;
  const turnEphemeralMessageIds = new Map<"thinking" | "progress", string>();
  let disposeDiagnosticsSubscription: (() => void) | null = null;
  const pendingDiagnosticContextMessages: Array<ReturnType<typeof createBackgroundDiagnosticsMessage>> = [];
  let taskSyncTimer: NodeJS.Timeout | null = null;
  let taskSyncInitialized = false;
  let lastTaskSnapshotJson = "";
  let lastBackgroundProcessCount = -1;
  let exitFinalizing = false;
  const knownTaskStatuses = new Map<string, SubagentTaskInfo["status"]>();
  const unreadTaskIds = new Set<string>();
  const notifiedTerminalTaskIds = new Set<string>();

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

  const toTerminalTaskSummary = (task: SubagentTaskInfo): TerminalUiTaskSummary => ({
    taskId: task.taskId,
    agentType: task.agentType,
    description: task.description,
    status: task.status,
    updatedAt: task.updatedAt,
    unread: unreadTaskIds.has(task.taskId),
    ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
    ...(task.hasChanges !== undefined ? { hasChanges: task.hasChanges } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.progress.at(-1)?.message ? { latestProgress: task.progress.at(-1)?.message } : {})
  });

  const updateTaskState = (tasks: SubagentTaskInfo[]) => {
    const summaries = tasks.map(toTerminalTaskSummary);
    const snapshotJson = JSON.stringify(summaries);
    if (snapshotJson === lastTaskSnapshotJson) {
      return;
    }

    lastTaskSnapshotJson = snapshotJson;
    store.updateState((state) => setBackgroundTasks(state, summaries));
  };

  const resetTaskTracking = () => {
    taskSyncInitialized = false;
    lastTaskSnapshotJson = "";
    knownTaskStatuses.clear();
    unreadTaskIds.clear();
    notifiedTerminalTaskIds.clear();
    store.updateState((state) => setBackgroundTasks(state, []));
  };

  const syncBackgroundTasks = (options: { notify?: boolean } = {}) => {
    let tasks: SubagentTaskInfo[];
    try {
      tasks = runtime.listSubagentTasks();
    } catch {
      return;
    }

    const shouldNotify = options.notify !== false && taskSyncInitialized;
    for (const task of tasks) {
      const previousStatus = knownTaskStatuses.get(task.taskId);
      const becameTerminal =
        (previousStatus === "running" || previousStatus === undefined) &&
        isTerminalTaskStatus(task.status) &&
        !notifiedTerminalTaskIds.has(task.taskId);

      if (shouldNotify && becameTerminal) {
        if (task.status === "completed") {
          unreadTaskIds.add(task.taskId);
        }
        notifiedTerminalTaskIds.add(task.taskId);
        appendUiMessage(createSystemMessage(formatTaskCompletionNotification(task), "Task"));
      }

      knownTaskStatuses.set(task.taskId, task.status);
    }

    updateTaskState(tasks);
    taskSyncInitialized = true;
  };

  const syncBackgroundProcesses = () => {
    let processCount: number;
    try {
      processCount = runtime.listBackgroundProcesses().length;
    } catch {
      return;
    }

    if (processCount === lastBackgroundProcessCount) {
      return;
    }

    lastBackgroundProcessCount = processCount;
    store.updateState((state) => setBackgroundProcessCount(state, processCount));
  };

  const startTaskSync = () => {
    if (taskSyncTimer) {
      return;
    }

    syncBackgroundTasks({ notify: false });
    syncBackgroundProcesses();
    taskSyncTimer = setInterval(() => {
      syncBackgroundTasks();
      syncBackgroundProcesses();
    }, TASK_SYNC_INTERVAL_MS);
    taskSyncTimer.unref?.();
  };

  const stopTaskSync = () => {
    if (!taskSyncTimer) {
      return;
    }

    clearInterval(taskSyncTimer);
    taskSyncTimer = null;
  };

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
      store.updateState((state) => setStatusText(state, "Stopping background terminal sessions..."));
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
        setSessionFullApprovalEnabled(
          setSessionApprovalMode(state, sessionApprovalMode),
          sessionFullApprovalEnabled
        ),
        [...sessionAllowedKinds]
      )
    );
  };

  const buildSessionPermissionRules = (): PermissionRuleInput[] => {
    const rules: PermissionRuleInput[] = [...sessionPermissionRules];

    for (const kind of sessionAllowedKinds) {
      for (const permission of getPermissionCategoriesForLegacyKind(kind)) {
        rules.push({
          permission,
          pattern: "*",
          action: "allow",
          scope: "session",
          reason: `User allowed ${kind} requests for this session.`
        });
      }
    }

    if (sessionFullApprovalEnabled) {
      rules.push({
        permission: "*",
        pattern: "*",
        action: "allow",
        scope: "session",
        reason: "User fully approved all permission prompts for this session."
      });
    } else if (sessionApprovalMode === "auto") {
      rules.push({
        permission: "*",
        pattern: "*",
        action: "allow",
        scope: "session",
        reason: "User enabled auto approval for this session."
      });
    }

    return rules;
  };

  const buildPermissionRuleSets = () => {
    const settingsState = runtime.getSettingsState();
    return [
      createDefaultPermissionRuleSet(),
      createPermissionRuleSet("project-settings", settingsState.project.permissionRules),
      createPermissionRuleSet("user-settings", settingsState.user.permissionRules),
      createPermissionRuleSet("session-approval", buildSessionPermissionRules()),
      createPermissionRuleSet(
        "plan-mode-overlay",
        createPlanModeOverlayRules(runtime.getPlanModeState().enabled)
      )
    ];
  };

  const getPermissionCategoryForRequest = (
    request: ToolApprovalRequest
  ): PermissionCategory | null => {
    if (request.permission) {
      return request.permission.permission;
    }

    return getPermissionCategoriesForToolKind(request.kind, request.toolName)[0] ?? null;
  };

  const getPermissionPatternForRequest = (request: ToolApprovalRequest): string => {
    if (request.permission?.pattern) {
      return normalizePermissionPattern(request.permission.pattern);
    }

    if (request.scope?.type === "external-directory") {
      return normalizePermissionPattern(request.scope.directory);
    }

    return normalizePermissionPattern(request.summary || request.toolName);
  };

  const evaluateApprovalRequest = (
    request: ToolApprovalRequest
  ): PermissionEvaluation | null => {
    const permission = getPermissionCategoryForRequest(request);
    if (!permission) {
      return null;
    }

    return evaluatePermission({
      permission,
      pattern: getPermissionPatternForRequest(request),
      rulesets: buildPermissionRuleSets()
    });
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
    runtime.hasTrackedFileChanges(point.turnId) &&
    runtime.canRestoreFilesForTurn(point.turnId);

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

    if (!hasFileChanges) {
      runtime.discardTurn(checkpoint.turnId);
    }

    trimRewindPoints();
  };

  const finalizeTurnFileChangesForRewind = async (
    checkpoint: TurnCheckpoint,
    postResponseFailures?: string[]
  ): Promise<TurnDiffReport | null> => {
    try {
      await runtime.finalizeTurnFileChanges(checkpoint.turnId);
      if (!runtime.hasTrackedFileChanges(checkpoint.turnId)) {
        return null;
      }

      return await runtime.getTurnDiff(checkpoint.turnId);
    } catch (error) {
      const message = formatPostResponseFailure("File diff snapshot failed", error);
      if (postResponseFailures) {
        postResponseFailures.push(message);
      } else {
        appendUiMessage(createErrorMessage(message));
      }
      return null;
    }
  };

  const appendPostEditSummary = (report: TurnDiffReport | null | undefined) => {
    if (!report) {
      return false;
    }

    const summary = formatPostEditSummary(report);
    if (!summary) {
      return false;
    }

    appendUiMessage(createSystemMessage(summary, "Diff"));
    return true;
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
    const fileRestoreResults: Array<{ turnId: string; result: FileHistoryRestoreResult }> = [];

    try {
      if (mode === "code-and-conversation") {
        const newestFirst = [...affected].sort((a, b) => b.uiMessageCount - a.uiMessageCount);
        for (const point of newestFirst) {
          if (!point.hasFileChanges || point.isRestoredFromHistory) {
            continue;
          }

          const result = await runtime.restoreFilesForTurn(point.turnId);
          if (result.missingSnapshot) {
            throw new Error(`File snapshots for turn ${point.turnId} are no longer available.`);
          }
          if (result.alreadyRestored) {
            throw new Error(`File snapshots for turn ${point.turnId} were already restored.`);
          }
          fileRestoreResults.push({ turnId: point.turnId, result });
        }
      }

      await runtime.restoreVolatileConversationSnapshot(target.volatileSnapshot);
      const baseMessages = store.getState().messages.slice(0, target.uiMessageCount);
      store.updateState((state) =>
        setDraftInput(
          setTranscriptSticky(
            setContextBudget(
              replaceMessages(setStatusText(closeDialog(state), "Rewound"), baseMessages),
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
      appendUiMessage(
        createSystemMessage(
          formatConversationRestoreResult({
            target,
            mode,
            affectedTurnCount: affected.length,
            fileRestoreResults
          }),
          mode === "conversation" ? "Rewind" : "Revert"
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendUiMessage(createErrorMessage(`Failed to rewind: ${message}`));
      store.updateState((state) => setStatusText(state, "Error"));
    }
  };

  const formatConversationRestoreResult = (options: {
    target: RewindPoint;
    mode: RewindRestoreMode;
    affectedTurnCount: number;
    fileRestoreResults: Array<{ turnId: string; result: FileHistoryRestoreResult }>;
  }) => {
    const fileTotals = options.fileRestoreResults.reduce(
      (totals, entry) => ({
        restored: totals.restored + entry.result.restored.length,
        removed: totals.removed + entry.result.removed.length,
        conflicts: totals.conflicts + entry.result.conflicts.length
      }),
      { restored: 0, removed: 0, conflicts: 0 }
    );
    const conflictLines = options.fileRestoreResults.flatMap((entry) =>
      formatRestoreConflictLines(entry.result.conflicts, undefined, 5)
        .map((line) => `${line} (turn ${entry.turnId})`)
    );

    const lines = [
      options.mode === "code-and-conversation"
        ? fileTotals.conflicts > 0
          ? "Reverted safe tracked files and rewound the conversation. Conflicting files were skipped."
          : "Reverted tracked files and rewound the conversation."
        : "Rewound the conversation only. Files on disk were left unchanged.",
      `Turn: ${options.target.turnId}`,
      `Conversation turns removed: ${options.affectedTurnCount}`,
      options.mode === "code-and-conversation"
        ? `Files restored: ${fileTotals.restored}; created files removed: ${fileTotals.removed}; conflicts skipped: ${fileTotals.conflicts}`
        : "Files restored: 0; created files removed: 0"
    ];

    if (conflictLines.length > 0) {
      lines.push("", "Conflicts skipped:", ...conflictLines);
    }

    return lines.join("\n");
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

    if (request.scope?.type === "external-directory" && isDirectoryAlreadyAllowed(request.scope.directory)) {
      return true;
    }

    const permissionEvaluation = evaluateApprovalRequest(request);
    if (permissionEvaluation?.action === "deny") {
      appendUiMessage(
        createSystemMessage(
          [
            "Denied permission request by rule.",
            `${request.title}: ${request.summary}`,
            `Permission: ${permissionEvaluation.permission}`,
            `Pattern: ${permissionEvaluation.pattern}`,
            `Reason: ${permissionEvaluation.reason}`
          ].join("\n"),
          "Permissions"
        )
      );
      return false;
    }

    if (shouldSkipApprovalDialog(permissionEvaluation, request, sessionFullApprovalEnabled)) {
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
          } else if (decision === "full-approve-session") {
            approved = true;
            sessionApprovalMode = "auto";
            sessionFullApprovalEnabled = true;
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
        reject(new TurnInterruptedError("user-cancel", "Request interrupted by user"));
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

    sessionPermissionRules = [
      ...sessionPermissionRules,
      {
        permission: "directory.external",
        pattern: normalizePermissionPattern(absolutePath),
        action: "allow",
        scope: "session",
        reason: "User allowed this external directory for the session."
      }
    ];

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

    if (decision === "full-approve-session") {
      return "full approve session";
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
    sessionPermissionRules = [];
    sessionApprovalMode = runtime.getSettings().approvalMode;
    sessionFullApprovalEnabled = false;

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
          setSessionFullApprovalEnabled(
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
            sessionFullApprovalEnabled
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
          if (activeTurn && !activeTurn.controller.signal.aborted) {
            activeTurn.userCancelled = true;
            activeTurn.controller.abort("user-cancel");
          }
          reject(new TurnInterruptedError("user-cancel", "Request interrupted by user"));
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
        reject(new TurnInterruptedError("user-cancel", "Request interrupted by user"));
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
        setStatusText(uiState, state.enabled ? "Plan Mode" : "Idle"),
        state.enabled
      )
    );
  };

  const isDirectoryAlreadyAllowed = (directory: string) => {
    const targetKey = normalizePathForComparison(directory);
    return runtime
      .getAllowedRoots()
      .some((allowedRoot) => normalizePathForComparison(allowedRoot) === targetKey);
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

  const getLatestRevertTarget = async () => {
    const report = await runtime.getLastAlyceTurnDiff();
    if (!report) {
      return null;
    }

    const point = rewindPoints.find((candidate) => candidate.turnId === report.turnId);
    return {
      report,
      point,
      view: point ? toTerminalRewindPoint(point) : null
    };
  };

  const recordFilesOnlyRevertEvent = async () => {
    await runtime.recordSessionRewind({
      apiMessageCount: Math.max(0, runtime.messages.length - 1),
      uiMessageCount: store.getState().messages.length,
      sessionMemory: runtime.memoryService.getSessionMemory(),
      restoreMode: "files-only"
    });
  };

  const restoreLatestTurnFilesOnly = async (
    target?: Awaited<ReturnType<typeof getLatestRevertTarget>>
  ) => {
    const resolvedTarget = target ?? (await getLatestRevertTarget());
    if (!resolvedTarget) {
      appendUiMessage(createSystemMessage("No Alyce turn file changes tracked yet.", "Revert"));
      return;
    }

    if (resolvedTarget.report.summary.filesChanged === 0) {
      appendUiMessage(
        createSystemMessage(
          [
            `Turn ${resolvedTarget.report.turnId} has no tracked file changes to revert.`
          ].join("\n"),
          "Revert"
        )
      );
      return;
    }

    const result = await runtime.restoreFilesForTurn(resolvedTarget.report.turnId);
    if (!result.missingSnapshot && !result.alreadyRestored) {
      await recordFilesOnlyRevertEvent();
    }

    appendUiMessage(
      createSystemMessage(
        formatFilesOnlyRevertResult(resolvedTarget.report, result),
        "Revert"
      )
    );
  };

  const restoreLatestTurnConversationOnly = async (
    target?: Awaited<ReturnType<typeof getLatestRevertTarget>>
  ) => {
    const resolvedTarget = target ?? (await getLatestRevertTarget());
    if (!resolvedTarget) {
      appendUiMessage(createSystemMessage("No Alyce turn file changes tracked yet.", "Revert"));
      return;
    }

    if (!resolvedTarget.point) {
      appendUiMessage(
        createSystemMessage(
          [
            `Conversation rewind is unavailable for turn ${resolvedTarget.report.turnId}.`,
            "This can happen after session resume, clear, or when the in-memory rewind point was pruned.",
            "Tracked files can still be reverted with /revert --files-only if their file snapshots remain."
          ].join("\n"),
          "Revert"
        )
      );
      return;
    }

    await restoreRewindPointById(resolvedTarget.point.id, "conversation");
  };

  const confirmAndRestoreLatestTurn = async () => {
    const target = await getLatestRevertTarget();
    if (!target) {
      appendUiMessage(createSystemMessage("No Alyce turn file changes tracked yet.", "Revert"));
      return;
    }

    if (target.report.summary.filesChanged === 0) {
      appendUiMessage(
        createSystemMessage(
          [
            `Turn ${target.report.turnId} has no tracked file changes to revert.`
          ].join("\n"),
          "Revert"
        )
      );
      return;
    }

    if (!runtime.canRestoreFilesForTurn(target.report.turnId)) {
      await restoreLatestTurnFilesOnly(target);
      return;
    }

    const options = [
      {
        label: REVERT_FILES_ONLY_LABEL,
        description: "Restore tracked files; keep the conversation unchanged.",
        preview: formatRevertPreview(target.report, "files")
      },
      ...(target.point && target.view?.canRestoreCode
        ? [{
            label: REVERT_FILES_AND_CONVERSATION_LABEL,
            description: "Restore tracked files and remove conversation turns from this point onward.",
            preview: formatRevertPreview(target.report, "files-and-conversation")
          }]
        : []),
      ...(target.point
        ? [{
            label: REVERT_CONVERSATION_ONLY_LABEL,
            description: "Remove conversation turns from this point onward; keep files on disk unchanged.",
            preview: formatRevertPreview(target.report, "conversation")
          }]
        : []),
      {
        label: REVERT_CANCEL_LABEL,
        description: "Leave files and conversation unchanged."
      }
    ];

    try {
      const response = await askUserQuestions({
        toolName: "Revert",
        title: "Confirm revert",
        metadata: { source: "user" },
        questions: [
          {
            header: "Revert",
            question: [
              "How should Alyce revert the latest turn?",
              "",
              "Alyce can revert the latest tracked file changes.",
              `Turn: ${target.report.turnId}`,
              "",
              "Files:",
              ...formatRevertFileLines(target.report.files),
              "",
              "Choose whether to restore files only or also rewind the conversation."
            ].join("\n"),
            options
          }
        ]
      });
      const answer = Object.values(response.answers)[0] ?? "";

      if (answer === REVERT_FILES_ONLY_LABEL) {
        await restoreLatestTurnFilesOnly(target);
        return;
      }

      if (answer === REVERT_FILES_AND_CONVERSATION_LABEL && target.point) {
        await restoreRewindPointById(target.point.id, "code-and-conversation");
        return;
      }

      if (answer === REVERT_CONVERSATION_ONLY_LABEL) {
        await restoreLatestTurnConversationOnly(target);
        return;
      }

      appendUiMessage(createSystemMessage("Revert cancelled.", "Revert"));
    } catch (error) {
      appendUiMessage(createSystemMessage(`Revert cancelled: ${getErrorMessage(error)}`, "Revert"));
    }
  };

  const handleRevertCommand = async (
    mode: Extract<ReturnType<typeof parseReplCommand>, { type: "revert" }>["mode"]
  ) => {
    if (mode === "files-only") {
      await restoreLatestTurnFilesOnly();
      return;
    }

    if (mode === "conversation-only") {
      await restoreLatestTurnConversationOnly();
      return;
    }

    await confirmAndRestoreLatestTurn();
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
      appendUiMessage(createSystemMessage(getHelpText(formatCurrentModelDisplay(runtime.getCurrentModel())), "Help"));
      return true;
    }

    if (parsedCommand.type === "doctor") {
      store.updateState((state) => setStatusText(state, "Running doctor..."));
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
        snapshotDiagnostics
      }, {
        env: process.env,
        stdinIsTTY: process.stdin.isTTY === true,
        stdoutIsTTY: process.stdout.isTTY === true
      });
      appendUiMessage(createSystemMessage(formatDoctorReport(report), "Doctor"));
      store.updateState((state) => setStatusText(state, "Idle"));
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

    if (parsedCommand.type === "rewind") {
      openRewindSelector();
      return true;
    }

    if (parsedCommand.type === "revert") {
      try {
        await handleRevertCommand(parsedCommand.mode);
      } catch (error) {
        appendUiMessage(createErrorMessage(`Revert failed: ${getErrorMessage(error)}`));
        store.updateState((state) => setStatusText(state, "Error"));
      }
      return true;
    }

    if (parsedCommand.type === "diff-view") {
      store.updateState((state) => setStatusText(state, "Loading diff..."));
      try {
        appendUiMessage(createSystemMessage(await formatDiffView(parsedCommand.target), "Diff"));
      } catch (error) {
        appendUiMessage(createErrorMessage(`Diff failed: ${getErrorMessage(error)}`));
      } finally {
        store.updateState((state) => setStatusText(state, "Idle"));
      }
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
      resetTaskTracking();
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

    if (parsedCommand.type === "model-view") {
      appendUiMessage(
        createSystemMessage(
          formatModelStatusReport({
            connectionState: runtime.getConnectionConfigState(),
            settings: runtime.getSettings(),
            currentModel: runtime.getCurrentModel(),
            env: process.env
          }),
          "Model"
        )
      );
      return true;
    }

    if (parsedCommand.type === "switch-model") {
      const result = resolveModelSwitch(parsedCommand.model, {
        currentModel: runtime.getCurrentModel(),
        providers: runtime.getConnectionConfigState().providerProfiles,
        settings: runtime.getSettings(),
        env: process.env
      });
      if (!result.ok) {
        appendUiMessage(
          createErrorMessage(
            [result.message, ...result.suggestions].filter(Boolean).join("\n")
          )
        );
        return true;
      }

      await runtime.setCurrentModel(result.persistModel);
      store.updateState((state) => setConnectionConfigState(state, runtime.getConnectionConfigState()));
      appendUiMessage(
        createSystemMessage(
          [
            `Switched model to: ${result.displayModel}`,
            ...result.warnings
          ].join("\n"),
          "Model"
        )
      );
      return true;
    }

    return true;
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
            "Approval: " + sessionApprovalMode,
            runtime.hasConnectionConfig()
              ? "Connection: ready"
              : "Connection: provider/model unavailable, open /settings or /setup"
          ].join("\n"),
          "Startup"
        )
      );
      if (options.startupContextSummary) {
        appendUiMessage(createSystemMessage(options.startupContextSummary, "Startup Context"));
      }

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
          createErrorMessage("Connection is incomplete. Open settings and fill provider/model details.")
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

      await runtime.beginTurn(turnId);
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
      let thinkingSnapshot = "";
      let thinkingSegmentContent = "";
      let postEditSummaryAppended = false;
      const appendPostEditSummaryOnce = (report: TurnDiffReport | null | undefined) => {
        if (postEditSummaryAppended) {
          return;
        }

        postEditSummaryAppended = appendPostEditSummary(report);
      };

      try {
        // 每轮都绑定独立的 abort controller 和 tool context，确保取消只影响当前轮次。
        const client = runtime.requireChatCompletionAdapter();
        const currentModel = runtime.getCurrentModel();
        const resolvedModel = runtime.getResolvedModelProfile();
        const gcliGeminiCompat = shouldUseGcliGeminiCompat(
          resolvedModel.baseURL,
          resolvedModel.modelId
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
          resolvedModel,
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
          resolvedModel,
          maxSteps: runtime.getSettings().maxSteps,
          querySource: "main",
          gcliGeminiCompat,
          messageTimestampsEnabled: runtime.getSettings().messageTimestampsEnabled,
          abortSignal: controller.signal,
          usageSource: "main",
          usageTurnId: turnId,
          onUsage: (event) => {
            runtime.recordUsage(event);
          },
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
              resolvedModel,
              force: true,
              querySource,
              usageTurnId: turnId,
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

            const nextThinkingSnapshot = mergeThinkingContent(thinkingSnapshot, chunk);
            if (nextThinkingSnapshot === thinkingSnapshot) {
              return;
            }

            const thinkingDelta = extractThinkingDelta(thinkingSnapshot, nextThinkingSnapshot);
            thinkingSnapshot = nextThinkingSnapshot;
            if (!thinkingDelta.trim()) {
              return;
            }

            const nextThinkingSegmentContent = mergeThinkingContent(thinkingSegmentContent, thinkingDelta);
            if (nextThinkingSegmentContent === thinkingSegmentContent) {
              return;
            }

            thinkingSegmentContent = nextThinkingSegmentContent;
            upsertTurnEphemeralMessage("thinking", createThinkingMessage(thinkingSegmentContent));
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
            if (thinkingSegmentContent.trim().length > 0) {
              turnEphemeralMessageIds.delete("thinking");
              thinkingSegmentContent = "";
            }
            store.updateState((state) => setStatusText(state, `Running ${toolName}...`));
          },
          onToolCallResult: (toolName, result, rawArguments) => {
            appendUiMessage(createToolResultMessage(toolName, result, rawArguments));
            if (isBackgroundProcessToolName(toolName)) {
              syncBackgroundProcesses();
            }
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
        const turnDiffReport = await finalizeTurnFileChangesForRewind(
          checkpoint,
          postResponseFailures
        );
        appendPostEditSummaryOnce(turnDiffReport);

        try {
          if (!completedTurnHistoryPlan) {
            throw new Error("Completed turn history was not prepared.");
          }

          await recordCompletedTurnHistory(runtime, store, completedTurnHistoryPlan);
          turnRecorded = true;
          runtime.scheduleSessionMemoryExtraction({
            client,
            model: currentModel,
            resolvedModel,
            querySource: "main",
            usageTurnId: turnId,
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
          const turnDiffReport = await finalizeTurnFileChangesForRewind(checkpoint);
          appendPostEditSummaryOnce(turnDiffReport);

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

          const turnDiffReport = await finalizeTurnFileChangesForRewind(checkpoint);
          appendPostEditSummaryOnce(turnDiffReport);
          rememberRewindPoint(checkpoint);
          appendUiMessage(
            createSystemMessage(
              formatTurnInterruptedMessage(error, checkpoint),
              "Session"
            )
          );
          store.updateState((state) => setStatusText(state, "Interrupted"));
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
      sessionFullApprovalEnabled = false;
      sessionAllowedKinds.clear();
      sessionPermissionRules = [];

      store.updateState((state) =>
        setStatusText(
          setSessionAllowedKinds(
            setSessionFullApprovalEnabled(
              setSessionApprovalMode(
                setSessionSettingsState(
                  setConnectionConfigState(closeDialog(state), runtime.getConnectionConfigState()),
                  runtime.getSettingsState()
                ),
                sessionApprovalMode
              ),
              sessionFullApprovalEnabled
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

function formatRevertFileLines(files: DiffFileReport[], limit = 20): string[] {
  if (files.length === 0) {
    return ["- (no tracked file changes)"];
  }

  const visibleFiles = files.slice(0, limit);
  const lines = visibleFiles.map((file) =>
    `- ${file.path}: ${file.status}, +${file.additions} -${file.deletions}`
  );
  const hiddenCount = files.length - visibleFiles.length;
  if (hiddenCount > 0) {
    lines.push(`- ... ${hiddenCount} more file(s)`);
  }

  return lines;
}

function formatRevertPreview(
  report: TurnDiffReport,
  mode: "files" | "files-and-conversation" | "conversation"
): string {
  const modeLine =
    mode === "files"
      ? "Files will be restored. Conversation stays as-is."
      : mode === "files-and-conversation"
        ? "Files will be restored and conversation turns from this point onward will be removed."
        : "Conversation turns from this point onward will be removed. Files stay as-is.";

  return [
    modeLine,
    `Turn: ${report.turnId}`,
    "Files:",
    ...formatRevertFileLines(report.files)
  ].join("\n");
}

function formatFilesOnlyRevertResult(
  report: TurnDiffReport,
  result: FileHistoryRestoreResult
): string {
  if (result.missingSnapshot) {
    return [
      `File revert is unavailable for turn ${report.turnId}.`,
      "The file snapshots are missing or were pruned.",
      "No file changes were applied."
    ].join("\n");
  }

  if (result.alreadyRestored) {
    return [
      `Turn ${report.turnId} was already restored${result.restoredAt ? ` at ${result.restoredAt}` : ""}.`,
      "No file changes were applied.",
      "Use /rewind or /revert --conversation-only if you only need to move the conversation."
    ].join("\n");
  }

  return [
    `Reverted tracked file changes for turn ${report.turnId}.`,
    "Conversation: unchanged.",
    `Restored existing files: ${result.restored.length}`,
    `Removed files created by the turn: ${result.removed.length}`,
    `Conflicts skipped: ${result.conflicts.length}`,
    ...(result.conflicts.length > 0
      ? [
          "",
          "Conflicts skipped:",
          ...formatRestoreConflictLines(result.conflicts, report)
        ]
      : []),
    "",
    "Files:",
    ...formatRevertFileLines(report.files)
  ].join("\n");
}

function formatRestoreConflictLines(
  conflicts: FileHistoryRestoreResult["conflicts"],
  report?: TurnDiffReport,
  limit = 20
): string[] {
  const visibleConflicts = conflicts.slice(0, limit);
  const lines = visibleConflicts.map((conflict) =>
    `- ${formatRestoreConflictPath(conflict.absolutePath, report)}: ${formatRestoreConflictReason(conflict.reason)}`
  );
  const hiddenCount = conflicts.length - visibleConflicts.length;
  if (hiddenCount > 0) {
    lines.push(`- ... ${hiddenCount} more conflict(s)`);
  }

  return lines;
}

function formatRestoreConflictPath(absolutePath: string, report?: TurnDiffReport) {
  const normalized = normalizeRestorePath(absolutePath);
  const file = report?.files.find((entry) =>
    entry.absolutePath && normalizeRestorePath(entry.absolutePath) === normalized
  );
  if (file) {
    return file.path;
  }

  const relative = path.relative(process.cwd(), absolutePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, "/")
    : absolutePath;
}

function formatRestoreConflictReason(reason: FileHistoryRestoreResult["conflicts"][number]["reason"]) {
  switch (reason) {
    case "current-file-missing":
      return "current file is missing";
    case "current-file-recreated":
      return "path was recreated after the turn";
    case "current-content-changed":
      return "current content changed after the turn";
  }
}

function normalizeRestorePath(absolutePath: string) {
  const resolved = path.resolve(absolutePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

function extractThinkingDelta(previous: string, next: string): string {
  if (!previous) {
    return next;
  }

  if (next === previous) {
    return "";
  }

  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }

  const maxOverlap = Math.min(previous.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (previous.endsWith(next.slice(0, overlap))) {
      return next.slice(overlap);
    }
  }

  return next;
}

function shouldSkipApprovalDialog(
  permissionEvaluation: Pick<PermissionEvaluation, "action"> | null | undefined,
  request: Pick<ToolApprovalRequest, "forceAsk">,
  sessionFullApprovalEnabled: boolean
): boolean {
  if (permissionEvaluation?.action === "deny") {
    return false;
  }

  if (sessionFullApprovalEnabled) {
    return true;
  }

  return permissionEvaluation?.action === "allow" && !request.forceAsk;
}

function isBackgroundProcessToolName(toolName: string): boolean {
  return BACKGROUND_PROCESS_TOOL_NAMES.has(toolName);
}

async function waitForUiPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export const __SESSION_CONTROLLER_TESTING__ = {
  mergeThinkingContent,
  extractThinkingDelta,
  shouldSkipApprovalDialog,
  isBackgroundProcessToolName,
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
