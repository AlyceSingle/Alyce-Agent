import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createBackgroundDiagnosticsMessage } from "../../core/api/generatedMessages.js";
import {
  runAgentUserTurn,
  type TurnCheckpoint
} from "./agentTurnRunner.js";
import { isTurnInterruptedError, throwIfAborted, TurnInterruptedError } from "../../core/abort.js";
import { getErrorMessage } from "../../core/util/error.js";
import { formatDoctorReport, runDoctorDiagnostics } from "../../core/doctor/doctor.js";
import {
  formatDiffDetails,
  formatDiffOverview
} from "../../core/diff/diffService.js";
import { setLocale, t } from "../../i18n/index.js";
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
import { formatCurrentModelDisplay } from "../../cli/modelCommand.js";
import { normalizeLogoutProvider } from "../../cli/connectCommand.js";
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
import type {
  McpElicitationRequest,
  McpElicitationResponse
} from "../../mcp/types.js";
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
  openConnectProviderDialog,
  openMcpElicitationDialog,
  openPermissionDialog,
  openPermissionsDialog,
  openQuestionDialog,
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
  AUTO_REVIEW_CONFIDENCE_THRESHOLD,
  buildApprovalModePermissionRules,
  buildAutoReviewPrompt,
  parseAutoReviewDecision,
  shouldSkipApprovalDialog
} from "./sessionController/approvalPolicy.js";
import { createBackgroundActivitySync } from "./sessionController/backgroundActivity.js";
import { createProviderConnectionController } from "./sessionController/providerConnection.js";
import { createRewindController } from "./sessionController/rewindController.js";
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
  let pendingApprovalResolver: ((decision: PermissionDecision) => void) | null = null;
  let pendingQuestionResolver: ((response: AskUserQuestionResponse | null) => void) | null = null;
  let pendingMcpElicitationResolver: ((response: McpElicitationResponse) => void) | null = null;
  let sessionApprovalMode = runtime.getSettings().approvalMode;
  const sessionAllowedKinds = new Set<ToolPermissionKind>();
  let sessionPermissionRules: PermissionRuleInput[] = [];
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
    store.updateState((state) => setStatusText(state, t("status.autoReviewing")));
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
        setStatusText(uiState, state.enabled ? "Plan Mode" : t("status.idle")),
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

  const {
    applyConnectProvider,
    authorizeProviderAuthFromDialog,
    completeProviderAuthFromDialog,
    cancelProviderAuthFromDialog,
    switchCurrentModel,
    openModelPicker
  } = createProviderConnectionController({ runtime, store, appendUiMessage });

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
      setLocale(runtime.getSettings().uiLanguage);
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

