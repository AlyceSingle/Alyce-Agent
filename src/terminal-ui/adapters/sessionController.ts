import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { runAgentTurn } from "../../agent.js";
import { createBackgroundDiagnosticsMessage } from "../../core/api/generatedMessages.js";
import { getFunctionToolNames } from "../../core/api/openaiFunctionTools.js";
import { isTurnInterruptedError, throwIfAborted, TurnInterruptedError } from "../../core/abort.js";
import { formatDoctorReport, runDoctorDiagnostics } from "../../core/doctor/doctor.js";
import {
  formatDiffDetails,
  formatDiffOverview,
  formatPostEditSummary,
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
  resolveModelSwitch
} from "../../cli/modelCommand.js";
import {
  normalizeLogoutProvider,
  resolveConnectProvider
} from "../../cli/connectCommand.js";
import {
  formatBackgroundProcessList,
  formatBackgroundProcessStopResult
} from "../../cli/processCommand.js";
import {
  formatSkillDetails,
  formatSkillList
} from "../../cli/skillsCommand.js";
import {
  formatMcpLoginResult,
  formatMcpPrompt,
  formatMcpPrompts,
  formatMcpMutation,
  formatMcpResourceTemplates,
  formatMcpResources,
  formatMcpServerList,
  formatMcpStatus,
  formatMcpTools
} from "../../cli/mcpCommand.js";
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
  ApprovalMode,
  RuntimeBootstrapReport,
  RuntimePaths,
  SessionSettings
} from "../../config/runtime.js";
import type {
  McpElicitationRequest,
  McpElicitationResponse
} from "../../mcp/types.js";
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
  openConnectProviderDialog,
  openMcpElicitationDialog,
  openModelPickerDialog,
  openPermissionDialog,
  openPermissionsDialog,
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
  setSessionSettingsState,
  setStatusText,
  setTodos,
  setTranscriptSticky,
  updateModelPickerDialogState
} from "../state/actions.js";
import type { TerminalUiStore } from "../state/store.js";
import type {
  PermissionDecision,
  RewindRestoreMode,
  TerminalUiMessage,
  ModelPickerDialogState,
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
const AUTO_REVIEW_CONFIDENCE_THRESHOLD = 0.72;

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

type ParsedReplCommand = ReturnType<typeof parseReplCommand>;
type SkillsParsedCommand = Extract<
  ParsedReplCommand,
  {
    type: "skills-list" | "skills-view" | "skills-set-enabled" | "skills-refresh";
  }
>;
type McpParsedCommand = Extract<
  ParsedReplCommand,
  {
    type:
      | "mcp-list"
      | "mcp-status"
      | "mcp-tools"
      | "mcp-resources"
      | "mcp-prompts"
      | "mcp-prompt"
      | "mcp-templates"
      | "mcp-add"
      | "mcp-remove"
      | "mcp-set-enabled"
      | "mcp-login";
  }
>;
type TrustParsedCommand = Extract<
  ParsedReplCommand,
  {
    type: "trust-status" | "project-trust-set";
  }
>;

function isSkillsParsedCommand(command: ParsedReplCommand): command is SkillsParsedCommand {
  return command.type.startsWith("skills-");
}

function isMcpParsedCommand(command: ParsedReplCommand): command is McpParsedCommand {
  return command.type.startsWith("mcp-");
}

function isTrustParsedCommand(command: ParsedReplCommand): command is TrustParsedCommand {
  return command.type === "trust-status" || command.type === "project-trust-set";
}

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
  let pendingMcpElicitationResolver: ((response: McpElicitationResponse) => void) | null = null;
  let sessionApprovalMode = runtime.getSettings().approvalMode;
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
    description: task.description
  });

  const updateTaskState = (tasks: SubagentTaskInfo[]) => {
    const summaries = tasks.filter(isVisibleBackgroundTask).map(toTerminalTaskSummary);
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
      const notifiableTask = isNotifiableBackgroundTask(task);

      if (notifiableTask && shouldNotify && becameTerminal) {
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
      processCount = runtime.listBackgroundProcesses().filter(isVisibleBackgroundProcess).length;
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
        setSessionApprovalMode(
          setSessionSettingsState(state, runtime.getSettingsState()),
          sessionApprovalMode
        ),
        [...sessionAllowedKinds]
      )
    );
  };

  const upsertPermissionRule = (
    rules: PermissionRuleInput[],
    nextRule: PermissionRuleInput
  ) => {
    const nextPattern = normalizePermissionPattern(nextRule.pattern);
    return [
      ...rules.filter((rule) =>
        rule.permission !== nextRule.permission ||
        normalizePermissionPattern(rule.pattern) !== nextPattern
      ),
      {
        ...nextRule,
        pattern: nextPattern
      }
    ];
  };

  const allowRequestPermissionForSession = async (request: ToolApprovalRequest) => {
    const permission = getPermissionCategoryForRequest(request);
    if (!permission) {
      throw new Error("This request does not map to a permission category.");
    }

    sessionPermissionRules = upsertPermissionRule(sessionPermissionRules, {
      permission,
      pattern: getPermissionPatternForRequest(request),
      action: "allow",
      scope: "session",
      reason: `User allowed ${request.summary} for this session.`
    });
  };

  const persistRequestPermissionRule = async (
    request: ToolApprovalRequest,
    action: "allow" | "ask" | "deny"
  ) => {
    const permission = getPermissionCategoryForRequest(request);
    if (!permission) {
      throw new Error("This request does not map to a permission category.");
    }

    const currentUserRules = runtime.getSettingsState().user.permissionRules ?? [];
    const nextRules = upsertPermissionRule([...currentUserRules], {
      permission,
      pattern: getPermissionPatternForRequest(request),
      action,
      scope: "persistent",
      reason: `User set ${action} for ${request.summary}.`
    });
    await runtime.updateSettings({
      permissionRules: nextRules
    });
    sessionApprovalMode = runtime.getSettings().approvalMode;
  };

  const setApprovalModeFromUi = async (
    mode: ApprovalMode,
    sourceLabel: string,
    options: { closeActiveDialog?: boolean } = {}
  ) => {
    await runtime.updateSettings({ approvalMode: mode });
    sessionApprovalMode = runtime.getSettings().approvalMode;
    sessionAllowedKinds.clear();
    sessionPermissionRules = [];
    store.updateState((state) =>
      setStatusText(
        setSessionAllowedKinds(
          setSessionApprovalMode(
            setSessionSettingsState(
              options.closeActiveDialog === false ? state : closeDialog(state),
              runtime.getSettingsState()
            ),
            sessionApprovalMode
          ),
          []
        ),
        `Permissions: ${sessionApprovalMode}`
      )
    );
    appendUiMessage(
      createSystemMessage(
        `Approval mode set to ${sessionApprovalMode} by ${sourceLabel}.`,
        "Permissions"
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

    rules.push(...buildApprovalModePermissionRules(sessionApprovalMode));

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
    isFileRestoreAvailable({
      hasTrackedChanges: runtime.hasTrackedFileChanges(point.turnId),
      canRestore: runtime.canRestoreFilesForTurn(point.turnId),
      alreadyRestored: runtime.isFilesAlreadyRestoredForTurn(point.turnId)
    });

  const toTerminalRewindPoint = (point: RewindPoint): TerminalUiRewindPoint => {
    const affected = getAffectedRewindPoints(point);
    const hasCodeChanges = affected.some((candidate) => candidate.hasFileChanges);
    const canRestoreFilesOnly =
      hasCodeChanges &&
      affected.every((candidate) => !candidate.hasFileChanges || hasRestorableFileSnapshot(candidate));
    const hasUnsafeToolActivity = affected.some((candidate) => candidate.hasNonRestorableToolActivity);
    const canRestoreCode = canRestoreFilesOnly && !hasUnsafeToolActivity;

    return {
      id: point.id,
      input: point.input,
      createdAt: point.createdAt,
      hasCodeChanges,
      canRestoreFilesOnly,
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
      appendUiMessage(createSystemMessage("Nothing to revert yet.", "Revert"));
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

  const restoreFilesForAffectedPoints = async (
    affected: RewindPoint[]
  ): Promise<Array<{ turnId: string; result: FileHistoryRestoreResult }>> => {
    const newestFirst = [...affected].sort((a, b) => b.uiMessageCount - a.uiMessageCount);
    const fileRestoreResults: Array<{ turnId: string; result: FileHistoryRestoreResult }> = [];

    for (const point of newestFirst) {
      if (!point.hasFileChanges || point.isRestoredFromHistory) {
        continue;
      }

      const result = await runtime.restoreFilesForTurn(point.turnId);
      if (result.missingSnapshot) {
        throw new Error(`File snapshots for turn ${point.turnId} are no longer available.`);
      }
      fileRestoreResults.push({ turnId: point.turnId, result });
    }

    return fileRestoreResults;
  };

  const restoreRewindPointById = async (pointId: string, mode: RewindRestoreMode) => {
    const target = rewindPoints.find((point) => point.id === pointId);
    if (!target) {
      appendUiMessage(createErrorMessage("That rewind point is no longer available."));
      setDialogClosed();
      return;
    }

    const view = toTerminalRewindPoint(target);
    if (mode === "files-only" && !view.canRestoreFilesOnly) {
      appendUiMessage(createErrorMessage("Tracked file restore is not available for that point."));
      setDialogClosed();
      return;
    }

    if (mode === "code-and-conversation" && !view.canRestoreCode) {
      appendUiMessage(createErrorMessage("Full revert is not available for that point."));
      setDialogClosed();
      return;
    }

    const affected = getAffectedRewindPoints(target);

    try {
      const fileRestoreResults =
        mode === "files-only" || mode === "code-and-conversation"
          ? await restoreFilesForAffectedPoints(affected)
          : [];

      if (mode === "files-only") {
        store.updateState((state) => setStatusText(closeDialog(state), "Reverted"));
        await runtime.recordSessionRewind({
          apiMessageCount: Math.max(0, runtime.messages.length - 1),
          uiMessageCount: store.getState().messages.length,
          sessionMemory: runtime.memoryService.getSessionMemory(),
          restoreMode: mode
        });
      } else {
        await runtime.restoreVolatileConversationSnapshot(target.volatileSnapshot);
        const baseMessages = store.getState().messages.slice(0, target.uiMessageCount);
        store.updateState((state) =>
          setDraftInput(
            setTranscriptSticky(
              setContextBudget(
                replaceMessages(setStatusText(closeDialog(state), "Reverted"), baseMessages),
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
      }

      appendUiMessage(
        createSystemMessage(
          formatConversationRestoreResult({
            target,
            mode,
            affectedTurnCount: affected.length,
            fileRestoreResults
          }),
          "Revert"
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendUiMessage(createErrorMessage(`Failed to revert: ${message}`));
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
        conflicts: totals.conflicts + entry.result.conflicts.length,
        alreadyRestored: totals.alreadyRestored + (entry.result.alreadyRestored ? 1 : 0)
      }),
      { restored: 0, removed: 0, conflicts: 0, alreadyRestored: 0 }
    );
    const conflictLines = options.fileRestoreResults.flatMap((entry) =>
      formatRestoreConflictLines(entry.result.conflicts, undefined, 5)
        .map((line) => `${line} (turn ${entry.turnId})`)
    );

    const lines = [
      options.mode === "code-and-conversation"
        ? fileTotals.conflicts > 0
          ? "Reverted safe tracked files and conversation history. Conflicting files were skipped."
          : "Reverted tracked files and conversation history."
        : options.mode === "files-only"
          ? fileTotals.conflicts > 0
            ? "Reverted safe tracked files only. Conversation was left unchanged. Conflicting files were skipped."
            : "Reverted tracked files only. Conversation was left unchanged."
          : "Reverted conversation history only. Files on disk were left unchanged.",
      `Turn: ${options.target.turnId}`,
      options.mode === "files-only"
        ? "Conversation: unchanged."
        : `Conversation turns removed: ${options.affectedTurnCount}`,
      options.mode === "code-and-conversation" || options.mode === "files-only"
        ? `Files restored: ${fileTotals.restored}; created files removed: ${fileTotals.removed}; conflicts skipped: ${fileTotals.conflicts}; already restored: ${fileTotals.alreadyRestored}`
        : "Files restored: 0; created files removed: 0"
    ];

    if (conflictLines.length > 0) {
      lines.push("", "Conflicts skipped:", ...conflictLines);
    }

    if (fileTotals.alreadyRestored > 0) {
      lines.push(
        "",
        `${fileTotals.alreadyRestored} affected turn(s) were already restored earlier and were skipped safely.`
      );
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

    if (shouldSkipApprovalDialog(permissionEvaluation, request, sessionApprovalMode)) {
      return true;
    }

    const autoReviewDecision = await maybeResolveApprovalWithAutoReviewer(
      request,
      permissionEvaluation,
      options
    );
    if (autoReviewDecision !== null) {
      return autoReviewDecision;
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
          } else if (decision === "allow-tool-session") {
            approved = true;
            await allowRequestPermissionForSession(request);
          } else if (decision === "allow-tool-persistent") {
            approved = true;
            await persistRequestPermissionRule(request, "allow");
          } else if (decision === "ask-tool-persistent") {
            approved = true;
            await persistRequestPermissionRule(request, "ask");
          } else if (decision === "deny-tool-persistent") {
            approved = false;
            await persistRequestPermissionRule(request, "deny");
          } else if (decision === "allow-scope-session") {
            approved = true;
            await allowRequestScopeForSession(request);
          } else if (decision === "full-access-session") {
            approved = true;
            await setApprovalModeFromUi("full-access", "Approval dialog", {
              closeActiveDialog: false
            });
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

  const maybeResolveApprovalWithAutoReviewer = async (
    request: ToolApprovalRequest,
    permissionEvaluation: PermissionEvaluation | null,
    options: { signal?: AbortSignal }
  ): Promise<boolean | null> => {
    if (
      sessionApprovalMode !== "auto-review" ||
      request.forceAsk ||
      permissionEvaluation?.action !== "ask" ||
      !activeTurn
    ) {
      return null;
    }

    throwIfAborted(options.signal);
    store.updateState((state) => setStatusText(state, "Auto-reviewing permission request..."));
    try {
      const result = await runtime.runSubagent({
        agentType: "auto-reviewer",
        description: `Review permission request for ${request.toolName}`,
        prompt: buildAutoReviewPrompt({
          request,
          permissionEvaluation,
          userRequest: activeTurn.input,
          approvalMode: sessionApprovalMode
        }),
        maxSteps: 2,
        isolateWorktree: false
      }, {
        turnId: activeTurn.turnId,
        abortSignal: options.signal ?? activeTurn.controller.signal,
        requestApproval,
        askUserQuestions: async () => {
          throw new Error("The auto-reviewer cannot ask the user questions.");
        },
        getTodos,
        setTodos: setTodoItems
      });
      const decision = parseAutoReviewDecision(result.output);
      if (!decision || decision.confidence < AUTO_REVIEW_CONFIDENCE_THRESHOLD) {
        appendUiMessage(
          createSystemMessage(
            [
              "Auto-review could not decide this permission request.",
              `${request.title}: ${request.summary}`,
              decision
                ? `Decision: ${decision.decision}; confidence: ${decision.confidence}`
                : "Decision: unavailable",
              "Falling back to manual approval."
            ].join("\n"),
            "Permissions"
          )
        );
        return null;
      }

      const approved = decision.decision === "approve";
      appendUiMessage(
        createSystemMessage(
          [
            `Auto-review ${approved ? "approved" : "rejected"} permission request.`,
            `${request.title}: ${request.summary}`,
            `Confidence: ${decision.confidence}`,
            `Reason: ${decision.reason}`
          ].join("\n"),
          "Permissions"
        )
      );
      return approved;
    } catch (error) {
      if (isTurnInterruptedError(error, options.signal ?? activeTurn?.controller.signal)) {
        throw error;
      }

      appendUiMessage(
        createSystemMessage(
          [
            "Auto-review failed for this permission request.",
            `${request.title}: ${request.summary}`,
            `Error: ${getErrorMessage(error)}`,
            "Falling back to manual approval."
          ].join("\n"),
          "Permissions"
        )
      );
      return null;
    }
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

    if (decision === "allow-tool-session") {
      return `allow ${getPermissionPatternForRequest(request)} for session`;
    }

    if (decision === "allow-tool-persistent") {
      return `always allow ${getPermissionPatternForRequest(request)}`;
    }

    if (decision === "ask-tool-persistent") {
      return `always ask for ${getPermissionPatternForRequest(request)}`;
    }

    if (decision === "deny-tool-persistent") {
      return `disable ${getPermissionPatternForRequest(request)}`;
    }

    if (decision === "allow-scope-session") {
      if (request.scope?.type === "external-directory") {
        return `allow external directory for session (${request.scope.directory})`;
      }

      return `allow ${request.kind} scope for session`;
    }

    if (decision === "full-access-session") {
      return "switch to Full Access";
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
    if (pendingApprovalResolver || pendingQuestionResolver || pendingMcpElicitationResolver) {
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

  const requestMcpElicitation = async (
    request: McpElicitationRequest,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ) => {
    if (pendingApprovalResolver || pendingQuestionResolver || pendingMcpElicitationResolver) {
      throw new Error("Another interactive dialog is already pending.");
    }

    store.updateState((state) => openMcpElicitationDialog(state, request));

    return new Promise<McpElicitationResponse>((resolve, reject) => {
      let timeout: NodeJS.Timeout | null = null;
      const cleanup = () => {
        options.signal?.removeEventListener("abort", handleAbort);
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      const settle = (response: McpElicitationResponse) => {
        pendingMcpElicitationResolver = null;
        cleanup();
        setDialogClosed();
        resolve(response);
      };

      const handleAbort = () => {
        if (!pendingMcpElicitationResolver) {
          cleanup();
          return;
        }

        pendingMcpElicitationResolver = null;
        cleanup();
        setDialogClosed();
        reject(new TurnInterruptedError("user-cancel", "Request interrupted by user"));
      };

      if (options.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          if (!pendingMcpElicitationResolver) {
            return;
          }

          pendingMcpElicitationResolver = null;
          cleanup();
          setDialogClosed();
          resolve({ action: "cancel" });
        }, options.timeoutMs);
      }

      if (options.signal?.aborted) {
        handleAbort();
        return;
      }

      pendingMcpElicitationResolver = settle;
      options.signal?.addEventListener("abort", handleAbort, { once: true });
    });
  };

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

  const applyConnectProvider = async (
    provider: string | undefined,
    args: string[],
    options: {
      closeActiveDialog: boolean;
      appendErrorMessage: boolean;
    }
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    const result = resolveConnectProvider(provider, args, {
      connectionState: runtime.getConnectionConfigState()
    });
    if (!result.ok) {
      const message = [result.message, ...result.suggestions].filter(Boolean).join("\n");
      if (options.appendErrorMessage) {
        appendUiMessage(createErrorMessage(message));
      }
      return { ok: false, message };
    }

    try {
      await runtime.applyProviderConnection(result.plan);
      store.updateState((state) => {
        const nextState = setConnectionConfigState(
          setStatusText(state, "Idle"),
          runtime.getConnectionConfigState()
        );
        return options.closeActiveDialog ? closeDialog(nextState) : nextState;
      });
      appendUiMessage(
        createSystemMessage(
          [
            result.plan.summary,
            ...result.plan.details,
            `Auth file: ${runtime.getAuthStorePath()}`
          ].join("\n"),
          "Connect"
        )
      );
      return { ok: true };
    } catch (error) {
      const message = `Connect failed: ${getErrorMessage(error)}`;
      if (options.appendErrorMessage) {
        appendUiMessage(createErrorMessage(message));
      }
      store.updateState((state) => setStatusText(state, "Error"));
      return { ok: false, message };
    }
  };

  const finishProviderAuthDialogConnection = (
    providerId: string,
    model: string,
    closeActiveDialog: boolean
  ) => {
    store.updateState((state) => {
      const nextState = setConnectionConfigState(
        setStatusText(state, "Idle"),
        runtime.getConnectionConfigState()
      );
      return closeActiveDialog ? closeDialog(nextState) : nextState;
    });
    appendUiMessage(
      createSystemMessage(
        [
          `Connected ${providerId}.`,
          `Current model: ${model}`,
          `Auth file: ${runtime.getAuthStorePath()}`
        ].join("\n"),
        "Connect"
      )
    );
  };

  const authorizeProviderAuthFromDialog = async (
    provider: string,
    methodIndex: number,
    inputs: Record<string, string>
  ): Promise<
    | { ok: true; type: "stored" }
    | { ok: true; type: "flow"; method: "auto" | "code"; url: string; instructions: string }
    | { ok: false; message: string }
  > => {
    try {
      const result = await runtime.authorizeProviderAuth(provider, methodIndex, inputs);
      if (result.type === "flow") {
        store.updateState((state) => setStatusText(state, "Waiting for provider authorization"));
        return {
          ok: true,
          type: "flow",
          method: result.flow.method,
          url: result.flow.url,
          instructions: result.flow.instructions
        };
      }

      finishProviderAuthDialogConnection(result.providerId, result.model, true);
      return { ok: true, type: "stored" };
    } catch (error) {
      const message = `Connect failed: ${getErrorMessage(error)}`;
      store.updateState((state) => setStatusText(state, "Error"));
      return { ok: false, message };
    }
  };

  const completeProviderAuthFromDialog = async (
    provider: string,
    methodIndex: number,
    code?: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      const result = await runtime.completeProviderAuth(provider, methodIndex, code, options);
      finishProviderAuthDialogConnection(result.providerId, result.model, true);
      return { ok: true };
    } catch (error) {
      const message = `Connect failed: ${getErrorMessage(error)}`;
      store.updateState((state) => setStatusText(state, "Error"));
      return { ok: false, message };
    }
  };

  const cancelProviderAuthFromDialog = (provider: string, _methodIndex: number) => {
    runtime.clearProviderAuthFlow(provider);
    store.updateState((state) => setStatusText(state, "Idle"));
  };

  const switchCurrentModel = async (
    model: string,
    options: {
      closeActiveDialog: boolean;
      appendErrorMessage: boolean;
    }
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    const result = resolveModelSwitch(model, {
      currentModel: runtime.getCurrentModel(),
      providers: runtime.getConnectionConfigState().providerProfiles,
      settings: runtime.getSettings(),
      env: process.env
    });
    if (!result.ok) {
      const message = [result.message, ...result.suggestions].filter(Boolean).join("\n");
      if (options.appendErrorMessage) {
        appendUiMessage(createErrorMessage(message));
      }
      return { ok: false, message };
    }

    try {
      await runtime.setCurrentModel(result.persistModel);
      store.updateState((state) => {
        const nextState = setConnectionConfigState(
          setStatusText(state, "Idle"),
          runtime.getConnectionConfigState()
        );
        return options.closeActiveDialog ? closeDialog(nextState) : nextState;
      });
      appendUiMessage(
        createSystemMessage(
          [
            `Switched model to: ${result.displayModel}`,
            ...result.warnings
          ].join("\n"),
          "Model"
        )
      );
      return { ok: true };
    } catch (error) {
      const message = `Model switch failed: ${getErrorMessage(error)}`;
      if (options.appendErrorMessage) {
        appendUiMessage(createErrorMessage(message));
      }
      store.updateState((state) => setStatusText(state, "Error"));
      return { ok: false, message };
    }
  };

  const createModelPickerLoadingState = (): ModelPickerDialogState => {
    try {
      const resolved = runtime.getResolvedModelProfile();
      return {
        status: "loading",
        providerId: resolved.providerId,
        providerLabel: resolved.provider.label
      };
    } catch {
      const currentModel = runtime.getCurrentModel();
      const providerId = currentModel.includes("/")
        ? currentModel.slice(0, currentModel.indexOf("/")).trim() || "openai"
        : "openai";
      return {
        status: "loading",
        providerId,
        providerLabel: providerId
      };
    }
  };

  const openModelPicker = async () => {
    const loadingState = createModelPickerLoadingState();
    store.updateState((state) =>
      openModelPickerDialog(setStatusText(state, "Refreshing models..."), loadingState)
    );

    const result = await runtime.refreshCurrentProviderModels()
      .catch((error: unknown) => ({
        providerId: loadingState.providerId,
        providerLabel: loadingState.providerLabel,
        models: {},
        source: "fallback" as const,
        error: getErrorMessage(error)
      }));
    store.updateState((state) =>
      updateModelPickerDialogState(
        setConnectionConfigState(setStatusText(state, "Idle"), runtime.getConnectionConfigState()),
        {
          status: "ready",
          providerId: result.providerId,
          providerLabel: result.providerLabel,
          source: result.source,
          ...(result.error ? { error: result.error } : {})
        }
      )
    );
  };

  const appendSystemText = (content: string, title: string) => {
    appendUiMessage(createSystemMessage(content, title));
  };

  const withOptionalServerName = (serverName?: string) =>
    serverName ? { serverName } : {};

  const doesPathExist = async (targetPath: string) => {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  };

  const isDirectoryReady = async (targetPath: string) => {
    try {
      const stat = await fs.stat(targetPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  };

  const getSkillCommandContext = async () => {
    const projectRoot = runtime.config.paths.projectSkillsDirectory;
    const userRoot = runtime.config.paths.userSkillsDirectory;
    const [projectRootReady, userRootReady] = await Promise.all([
      isDirectoryReady(projectRoot),
      isDirectoryReady(userRoot)
    ]);
    return {
      projectRoot,
      userRoot,
      projectRootReady,
      userRootReady
    };
  };

  const getMcpCommandContext = async () => {
    const projectConfigPath = path.join(runtime.config.paths.projectAlyceDirectory, "mcp.json");
    const localConfigPath = path.join(runtime.config.paths.projectAlyceDirectory, "mcp.local.json");
    const userConfigPath = path.join(runtime.config.paths.userAlyceDirectory, "mcp.json");
    const [projectConfigExists, localConfigExists, userConfigExists] = await Promise.all([
      doesPathExist(projectConfigPath),
      doesPathExist(localConfigPath),
      doesPathExist(userConfigPath)
    ]);
    return {
      projectConfigPath,
      projectConfigExists,
      localConfigPath,
      localConfigExists,
      userConfigPath,
      userConfigExists
    };
  };

  const formatProjectTrustStatus = () => {
    const state = runtime.getProjectTrustState();
    return [
      "Project trust",
      `Workspace: ${state.workspaceRoot}`,
      `Status: ${state.trusted ? "trusted" : "untrusted"}`,
      `Trust store: ${state.storePath}`,
      state.updatedAt ? `Updated: ${state.updatedAt}` : undefined,
      "",
      state.trusted
        ? "Project-local .alyce config, skills, MCP servers, agents, and connector plugins may load."
        : "Project-local .alyce config, skills, MCP servers, agents, and connector plugins are disabled."
    ].filter((line): line is string => line !== undefined).join("\n");
  };

  const findCatalogSkill = (
    catalog: Awaited<ReturnType<SessionRuntime["listSkills"]>>,
    requestedName: string
  ) => [...catalog.skills, ...catalog.disabledSkills].find((entry) =>
    entry.normalizedName === requestedName.trim().toLowerCase()
  );

  const handleSkillsCommand = async (parsedCommand: SkillsParsedCommand) => {
    switch (parsedCommand.type) {
      case "skills-list": {
        const catalog = await runtime.listSkills();
        appendSystemText(formatSkillList(catalog, await getSkillCommandContext()), "Skills");
        return;
      }
      case "skills-view": {
        const catalog = await runtime.listSkills();
        const skill = findCatalogSkill(catalog, parsedCommand.name);
        const details = formatSkillDetails(
          skill,
          parsedCommand.name,
          catalog,
          await getSkillCommandContext()
        );
        appendUiMessage(
          skill
            ? createSystemMessage(details, "Skills")
            : createErrorMessage(details)
        );
        return;
      }
      case "skills-set-enabled": {
        const result = parsedCommand.reference.kind === "bundled"
          ? await runtime.setBundledSkillsEnabled(parsedCommand.enabled, parsedCommand.target)
          : await runtime.setSkillEnabled(
              parsedCommand.reference,
              parsedCommand.enabled,
              parsedCommand.target
            );
        appendSystemText(result.message, "Skills");
        return;
      }
      case "skills-refresh": {
        const catalog = await runtime.refreshSkills();
        appendSystemText(
          [
            "Skill catalog refreshed.",
            `Active: ${catalog.skills.length}`,
            `Disabled: ${catalog.disabledSkills.length}`
          ].join("\n"),
          "Skills"
        );
        return;
      }
    }
  };

  const appendMcpAuthorizationUrl = (details: {
    server: string;
    authorizationUrl: string;
    redirectUrl: string;
  }) => {
    appendSystemText(
      [
        `Open this URL to authorize MCP server '${details.server}':`,
        details.authorizationUrl,
        `Redirect URL: ${details.redirectUrl}`
      ].join("\n"),
      "MCP"
    );
  };

  const handleMcpCommand = async (parsedCommand: McpParsedCommand) => {
    switch (parsedCommand.type) {
      case "mcp-list": {
        const status = await runtime.getMcpStatus({ initialize: false });
        appendSystemText(formatMcpServerList(status, await getMcpCommandContext()), "MCP");
        return;
      }
      case "mcp-status": {
        const status = await runtime.getMcpStatus({ initialize: true });
        appendSystemText(formatMcpStatus(status, await getMcpCommandContext()), "MCP");
        return;
      }
      case "mcp-tools": {
        const result = await runtime.listMcpTools(withOptionalServerName(parsedCommand.serverName));
        appendSystemText(formatMcpTools(result, await getMcpCommandContext()), "MCP");
        return;
      }
      case "mcp-resources": {
        const result = await runtime.listMcpResources(withOptionalServerName(parsedCommand.serverName));
        appendSystemText(formatMcpResources(result, await getMcpCommandContext()), "MCP");
        return;
      }
      case "mcp-prompts": {
        const result = await runtime.listMcpPrompts(withOptionalServerName(parsedCommand.serverName));
        appendSystemText(formatMcpPrompts(result, await getMcpCommandContext()), "MCP");
        return;
      }
      case "mcp-prompt": {
        const result = await runtime.getMcpPrompt(
          parsedCommand.serverName,
          parsedCommand.promptName,
          parsedCommand.args
        );
        appendSystemText(formatMcpPrompt(result), "MCP");
        return;
      }
      case "mcp-templates": {
        const result = await runtime.listMcpResourceTemplates(withOptionalServerName(parsedCommand.serverName));
        appendSystemText(
          formatMcpResourceTemplates(result, await getMcpCommandContext()),
          "MCP"
        );
        return;
      }
      case "mcp-add": {
        const result = await runtime.addMcpServer(
          parsedCommand.name,
          parsedCommand.config,
          parsedCommand.scope
        );
        appendSystemText(formatMcpMutation("add", result), "MCP");
        return;
      }
      case "mcp-remove": {
        const result = await runtime.removeMcpServer(parsedCommand.name, parsedCommand.scope);
        appendSystemText(formatMcpMutation("remove", result), "MCP");
        return;
      }
      case "mcp-set-enabled": {
        const result = await runtime.setMcpServerEnabled(
          parsedCommand.name,
          parsedCommand.enabled,
          parsedCommand.scope
        );
        appendSystemText(
          formatMcpMutation(parsedCommand.enabled ? "enable" : "disable", result),
          "MCP"
        );
        return;
      }
      case "mcp-login": {
        const result = await runtime.loginMcpServer(parsedCommand.serverName, {
          onAuthorizationUrl: appendMcpAuthorizationUrl
        });
        appendSystemText(formatMcpLoginResult(result), "MCP");
        return;
      }
    }
  };

  const handleTrustCommand = async (parsedCommand: TrustParsedCommand) => {
    if (parsedCommand.type === "trust-status") {
      appendSystemText(formatProjectTrustStatus(), "Trust");
      return;
    }

    const next = await runtime.setProjectTrusted(parsedCommand.trusted);
    await runtime.refreshSkills();
    await runtime.getMcpStatus({ initialize: false });
    appendSystemText(
      [
        parsedCommand.trusted
          ? "Workspace trusted."
          : "Workspace trust revoked.",
        `Workspace: ${next.workspaceRoot}`,
        `Trust store: ${next.storePath}`,
        parsedCommand.trusted
          ? "Project-local Alyce assets will be considered on subsequent loads."
          : "Project-local Alyce assets are disabled for this session."
      ].join("\n"),
      "Trust"
    );
  };

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
          setConnectionConfigState(setStatusText(state, "Idle"), runtime.getConnectionConfigState())
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
        store.updateState((state) => setStatusText(state, "Error"));
      }
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
        providerPluginDiagnostics: runtime.config.providerPluginDiagnostics,
        projectTrust: runtime.getProjectTrustState(),
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

    if (parsedCommand.type === "revert") {
      openRewindSelector();
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
            "Approval: " + sessionApprovalMode,
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
        store.updateState((state) => setStatusText(state, "Error"));
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
      const promptSkillContext = await runtime.preparePromptSkillContext(normalized);
      const userMessage = {
        role: "user",
        content: normalized
      } as const;
      runtime.messages.push(...promptSkillContext.generatedMessages, userMessage);
      appendUiMessage(createUserMessage(normalized));
      const promptSkillSummary = formatPromptSkillSummary(promptSkillContext);
      if (promptSkillSummary) {
        appendUiMessage(createSystemMessage(promptSkillSummary, "Skills"));
      }
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
          availableTools: getFunctionToolNames(tools),
          nextUserInput: normalized
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
              availableTools: getFunctionToolNames(refreshedTools)
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
    respondToMcpElicitation: (response) => {
      pendingMcpElicitationResolver?.(response);
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
      syncDiagnosticsRegistrySettings();
      if (!runtime.getSettings().historyPagingEnabled) {
        resetSessionHistoryPaging();
      }

      sessionApprovalMode = runtime.getSettings().approvalMode;
      sessionAllowedKinds.clear();
      sessionPermissionRules = [];

      store.updateState((state) =>
        setStatusText(
          setSessionAllowedKinds(
            setSessionApprovalMode(
              setSessionSettingsState(closeDialog(state), runtime.getSettingsState()),
              sessionApprovalMode
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
    }
  };
}

interface AutoReviewDecision {
  decision: "approve" | "reject";
  confidence: number;
  reason: string;
}

function buildAutoReviewPrompt(options: {
  request: ToolApprovalRequest;
  permissionEvaluation: PermissionEvaluation;
  userRequest: string;
  approvalMode: ApprovalMode;
}): string {
  return [
    "Review this pending Alyce permission request.",
    "Return only strict JSON with keys decision, confidence, and reason.",
    "",
    JSON.stringify({
      currentApprovalMode: options.approvalMode,
      userRequest: options.userRequest,
      request: {
        kind: options.request.kind,
        toolName: options.request.toolName,
        title: options.request.title,
        summary: options.request.summary,
        details: options.request.details,
        scope: options.request.scope,
        permission: options.request.permission,
        forceAsk: options.request.forceAsk === true
      },
      permissionEvaluation: {
        action: options.permissionEvaluation.action,
        permission: options.permissionEvaluation.permission,
        pattern: options.permissionEvaluation.pattern,
        reason: options.permissionEvaluation.reason
      },
      policy:
        "Approve only if the request is necessary for the user request, low risk, and scoped. Reject destructive, secret-bearing, unrelated, broad, or ambiguous requests."
    }, null, 2)
  ].join("\n");
}

function parseAutoReviewDecision(output: string): AutoReviewDecision | null {
  const normalized = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const jsonCandidate = normalized.startsWith("{")
    ? normalized
    : normalized.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonCandidate) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const decision = record.decision;
  const confidence = record.confidence;
  const reason = record.reason;
  if (decision !== "approve" && decision !== "reject") {
    return null;
  }

  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return null;
  }

  return {
    decision,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: typeof reason === "string" && reason.trim().length > 0
      ? reason.trim()
      : "No reason provided."
  };
}

function buildApprovalModePermissionRules(mode: ApprovalMode): PermissionRuleInput[] {
  if (mode === "default" || mode === "auto-review") {
    return [
      {
        permission: "file.write",
        pattern: "workspace:*",
        action: "allow",
        scope: "session",
        reason: `${mode} mode allows workspace file writes.`
      },
      {
        permission: "file.edit",
        pattern: "workspace:*",
        action: "allow",
        scope: "session",
        reason: `${mode} mode allows workspace file edits.`
      },
      {
        permission: "file.patch",
        pattern: "workspace:*",
        action: "allow",
        scope: "session",
        reason: `${mode} mode allows workspace patches.`
      },
      {
        permission: "shell",
        pattern: "*",
        action: "allow",
        scope: "session",
        reason: `${mode} mode allows command execution.`
      },
      {
        permission: "powershell",
        pattern: "*",
        action: "allow",
        scope: "session",
        reason: `${mode} mode allows command execution.`
      }
    ];
  }

  if (mode === "full-access") {
    return [
      {
        permission: "*",
        pattern: "*",
        action: "allow",
        scope: "session",
        reason: "Full Access mode allows all permission requests."
      }
    ];
  }

  return [];
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

function formatPromptSkillSummary(
  context: Awaited<ReturnType<SessionRuntime["preparePromptSkillContext"]>>
): string | null {
  const lines: string[] = [];

  if (context.loadedSkillNames.length > 0) {
    lines.push(`Loaded skill context from prompt mentions: ${context.loadedSkillNames.join(", ")}`);
  }

  const unresolvedMentions = context.unresolvedMentions.filter(shouldWarnForUnknownSkillMention);
  if (unresolvedMentions.length > 0) {
    lines.push(
      `Unknown skill mention(s) ignored: ${unresolvedMentions.map((name) => `$${name}`).join(", ")}`
    );
  }

  if (context.disabledMentions.length > 0) {
    lines.push(
      `Disabled skill mention(s) ignored: ${context.disabledMentions.map((name) => `$${name}`).join(", ")}`
    );
  }

  if (context.dependencyWarnings.length > 0) {
    lines.push(...context.dependencyWarnings.slice(0, 5));
  }

  if (context.loadedSkillNames.length > 0 && context.duplicateWarnings.length > 0) {
    lines.push(...context.duplicateWarnings.slice(0, 3));
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function shouldWarnForUnknownSkillMention(name: string) {
  return /-/.test(name) || /[a-z]/.test(name);
}

function formatRuntimeBootstrapSummary(
  report: RuntimeBootstrapReport,
  paths: RuntimePaths
): string | null {
  if (report.createdPaths.length === 0 && report.failedPaths.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (report.createdPaths.length > 0) {
    parts.push(
      `Runtime storage ready: ${report.createdPaths.length} path(s) initialized`,
      `state: ${paths.workspaceRuntimeDirectory}`,
      `user skills: ${paths.userSkillsDirectory}`,
      `project assets load after /trust`
    );
  }

  if (report.failedPaths.length > 0) {
    parts.push(
      `failed: ${report.failedPaths.length}`,
      `details: ${report.failedPaths
        .slice(0, 5)
        .map((failure) => `- ${failure.path}: ${failure.error}`)
        .join("; ")}`
    );
  }

  return parts.join("; ");
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
  sessionApprovalMode: ApprovalMode
): boolean {
  if (permissionEvaluation?.action === "deny") {
    return false;
  }

  if (sessionApprovalMode === "full-access") {
    return true;
  }

  return permissionEvaluation?.action === "allow" && !request.forceAsk;
}

function isBackgroundProcessToolName(toolName: string): boolean {
  return BACKGROUND_PROCESS_TOOL_NAMES.has(toolName);
}

function isNotifiableBackgroundTask(task: Pick<SubagentTaskInfo, "agentType">): boolean {
  return task.agentType !== "auto-reviewer";
}

function isVisibleBackgroundTask(task: Pick<SubagentTaskInfo, "agentType" | "status">): boolean {
  return isNotifiableBackgroundTask(task) && task.status === "running";
}

function isVisibleBackgroundProcess(process: { status: string }): boolean {
  return process.status === "running";
}

async function waitForUiPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function isFileRestoreAvailable(options: {
  hasTrackedChanges: boolean;
  canRestore: boolean;
  alreadyRestored: boolean;
}) {
  return options.hasTrackedChanges && (options.canRestore || options.alreadyRestored);
}

export const __SESSION_CONTROLLER_TESTING__ = {
  mergeThinkingContent,
  extractThinkingDelta,
  formatPromptSkillSummary,
  shouldSkipApprovalDialog,
  parseAutoReviewDecision,
  buildAutoReviewPrompt,
  buildApprovalModePermissionRules,
  isFileRestoreAvailable,
  isBackgroundProcessToolName,
  isVisibleBackgroundProcess,
  isVisibleBackgroundTask,
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
