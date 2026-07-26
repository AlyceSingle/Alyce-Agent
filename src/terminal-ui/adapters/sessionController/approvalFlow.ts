import {
  isTurnInterruptedError,
  throwIfAborted,
  TurnInterruptedError
} from "../../../core/abort.js";
import { getErrorMessage } from "../../../core/util/error.js";
import { createPlanModeOverlayRules } from "../../../core/planMode/planMode.js";
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
} from "../../../core/permissions/permissionRules.js";
import type { SessionRuntime } from "../../../cli/sessionRuntime.js";
import type { ApprovalMode } from "../../../config/runtime.js";
import { t } from "../../../i18n/index.js";
import type {
  TodoItem,
  ToolApprovalRequest,
  ToolPermissionKind
} from "../../../tools/types.js";
import {
  closeDialog,
  openPermissionDialog,
  setSessionAllowedKinds,
  setSessionApprovalMode,
  setSessionSettingsState,
  setStatusText
} from "../../state/actions.js";
import type { TerminalUiStore } from "../../state/store.js";
import type { PermissionDecision, TerminalUiMessage } from "../../state/types.js";
import type { TurnCheckpoint } from "../agentTurnRunner.js";
import { createErrorMessage, createSystemMessage } from "../messageMapper.js";
import {
  AUTO_REVIEW_CONFIDENCE_THRESHOLD,
  buildApprovalModePermissionRules,
  buildAutoReviewPrompt,
  parseAutoReviewDecision,
  shouldSkipApprovalDialog
} from "./approvalPolicy.js";
import { waitForUiPaint } from "./helpers.js";

export interface ApprovalFlowController {
  requestApproval: (
    request: ToolApprovalRequest,
    options?: { signal?: AbortSignal }
  ) => Promise<boolean>;
  setApprovalModeFromUi: (
    mode: ApprovalMode,
    sourceLabel: string,
    options?: { closeActiveDialog?: boolean }
  ) => Promise<void>;
  resetSessionPermissions: () => void;
  getSessionApprovalMode: () => ApprovalMode;
  hasPendingApproval: () => boolean;
  resolvePendingApproval: (decision: PermissionDecision) => void;
}

export function createApprovalFlowController(deps: {
  runtime: SessionRuntime;
  store: TerminalUiStore;
  appendUiMessage: (message: TerminalUiMessage) => void;
  setDialogClosed: () => void;
  getActiveTurn: () => TurnCheckpoint | null;
  isDirectoryAlreadyAllowed: (directory: string) => boolean;
  resolveAdditionalDirectory: (directory: string) => Promise<string>;
  dedupeDirectories: (directories: string[]) => string[];
  getTodos: () => TodoItem[];
  setTodoItems: (todos: TodoItem[]) => void;
}): ApprovalFlowController {
  const {
    runtime,
    store,
    appendUiMessage,
    setDialogClosed,
    getActiveTurn,
    isDirectoryAlreadyAllowed,
    resolveAdditionalDirectory,
    dedupeDirectories,
    getTodos,
    setTodoItems
  } = deps;

  let pendingApprovalResolver: ((decision: PermissionDecision) => void) | null = null;
  let sessionApprovalMode = runtime.getSettings().approvalMode;
  const sessionAllowedKinds = new Set<ToolPermissionKind>();
  let sessionPermissionRules: PermissionRuleInput[] = [];

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
    const activeTurn = getActiveTurn();
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
      if (isTurnInterruptedError(error, options.signal ?? getActiveTurn()?.controller.signal)) {
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

  const resetSessionPermissions = () => {
    sessionAllowedKinds.clear();
    sessionPermissionRules = [];
    sessionApprovalMode = runtime.getSettings().approvalMode;
  };

  return {
    requestApproval,
    setApprovalModeFromUi,
    resetSessionPermissions,
    getSessionApprovalMode: () => sessionApprovalMode,
    hasPendingApproval: () => pendingApprovalResolver !== null,
    resolvePendingApproval: (decision) => {
      pendingApprovalResolver?.(decision);
    }
  };
}
