import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgentTurn } from "../../agent.js";
import { isTurnInterruptedError, throwIfAborted } from "../../core/abort.js";
import { parseReplCommand } from "../../cli/commandRouter.js";
import {
  formatMemorySnapshot,
  getHelpText,
  type SessionRuntime
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
  closeMessageReader,
  closeDialog,
  getActiveDialog,
  openMessageReader,
  openPermissionDialog,
  openQuestionDialog,
  openRewindPickerDialog,
  openSessionPickerDialog,
  openSettingsDialog,
  replaceMessages,
  setConnectionConfigState,
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
  createErrorMessage,
  createSystemMessage,
  createThinkingMessage,
  createToolResultMessage,
  createToolStartMessage,
  createUserMessage
} from "./messageMapper.js";

// SessionController 负责把 REPL/UI 事件翻译成会话运行时调用，并维护中断恢复状态。
const RESTORABLE_TOOL_NAMES = new Set(["Edit", "Write"]);
const MAX_REWIND_POINTS = 100;

// 每轮请求在执行前都会记录一个 checkpoint，便于中断时回滚消息和文件改动。
interface TurnCheckpoint {
  turnId: string;
  input: string;
  createdAt: string;
  runtimeMessageCount: number;
  uiMessageCount: number;
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
  runtimeMessageCount: number;
  uiMessageCount: number;
  hasFileChanges: boolean;
  hasNonRestorableToolActivity: boolean;
  isRestoredFromHistory: boolean;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatPostResponseFailure(step: string, error: unknown): string {
  return `${step}: ${getErrorMessage(error)}`;
}

type CompletedTurnHistoryPlan = {
  mode: "delta" | "snapshot";
  apiMessages: SessionRuntime["messages"];
  uiBaseMessageCount: number;
};

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
  interrupt: () => void;
  openRewindSelector: () => void;
  restoreRewindPoint: (pointId: string, mode: RewindRestoreMode) => Promise<void>;
  respondToApproval: (decision: PermissionDecision) => void;
  respondToQuestion: (response: AskUserQuestionResponse | null) => void;
  openSettings: (section?: SettingsSection, reason?: string) => void;
  openMessageReader: (messageId: string) => void;
  closeMessageReader: () => void;
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
  let pendingApprovalResolver: ((decision: PermissionDecision) => void) | null = null;
  let pendingQuestionResolver: ((response: AskUserQuestionResponse | null) => void) | null = null;
  let sessionApprovalMode = runtime.getSettings().approvalMode;
  const sessionAllowedKinds = new Set<ToolPermissionKind>();
  let activeTurn: TurnCheckpoint | null = null;
  let rewindPoints: RewindPoint[] = [];

  const appendUiMessage = (message: TerminalUiMessage) => {
    store.updateState((state) => appendMessage(state, message));
  };

  const requestExit = () => {
    void runtime.flushSessionHistory().finally(() => exitHandler?.());
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

  const canFullyRestoreTurn = (turn: TurnCheckpoint) => !turn.hasNonRestorableToolActivity;

  const restoreTurn = async (turn: TurnCheckpoint) => {
    // 文件回滚和消息截断必须一起做，避免 UI 与真实工作区状态脱节。
    if (runtime.hasTrackedFileChanges(turn.turnId)) {
      await runtime.restoreFilesForTurn(turn.turnId);
    }

    runtime.messages.splice(turn.runtimeMessageCount);
    store.updateState((state) =>
      setDraftInput(
        setTranscriptSticky(
          replaceMessages(setStatusText(state, "Idle"), state.messages.slice(0, turn.uiMessageCount)),
          true
        ),
        turn.input
      )
    );

    runtime.discardTurn(turn.turnId);
    if (activeTurn?.turnId === turn.turnId) {
      activeTurn = null;
    }
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
      runtimeMessageCount: checkpoint.runtimeMessageCount,
      uiMessageCount: checkpoint.uiMessageCount,
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

      runtime.messages.splice(target.runtimeMessageCount);
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
            replaceMessages(setStatusText(closeDialog(state), "Rewound"), [
              ...baseMessages,
              systemMessage
            ]),
            true
          ),
          target.input
        )
      );

      await runtime.recordSessionRewind({
        apiMessageCount: Math.max(0, target.runtimeMessageCount - 1),
        uiMessageCount: target.uiMessageCount,
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
        runtimeMessageCount: apiUserMessage.runtimeMessageCount,
        uiMessageCount: uiUserMessage.index,
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

    if (sessionAllowedKinds.has(request.kind)) {
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

      // 审批结果既影响当前请求，也可能提升为“本会话允许该类操作”或“全会话自动批准”。
      const settle = (decision: PermissionDecision) => {
        pendingApprovalResolver = null;
        cleanup();
        setDialogClosed();

        let approved = false;
        if (decision === "allow-once") {
          approved = true;
        } else if (decision === "allow-kind-session") {
          approved = true;
          sessionAllowedKinds.add(request.kind);
        } else if (decision === "auto-approve-session") {
          approved = true;
          sessionApprovalMode = "auto";
        }

        syncApprovalState();
        appendUiMessage(
          createSystemMessage(
            [
              `${approved ? "Approved" : "Denied"} permission request.`,
              `${request.title}: ${request.summary}`,
              `Mode: ${
                decision === "allow-kind-session"
                  ? `allow ${request.kind} for session`
                  : decision === "auto-approve-session"
                    ? "auto approve session"
                    : decision
              }`
            ].join("\n"),
            "Permissions"
          )
        );
        resolve(approved);
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

  const resumeSessionById = async (sessionId: string) => {
    const resumed = await runtime.resumeSessionHistory(sessionId);
    activeTurn = null;
    sessionAllowedKinds.clear();
    sessionApprovalMode = runtime.getSettings().approvalMode;

    const restoredMessages = resumed.uiMessages as TerminalUiMessage[];
    rebuildRewindPointsFromCurrentConversation(restoredMessages);
    const systemMessage = createSystemMessage(
      [
        `Resumed session ${resumed.sessionId.slice(0, 8)}.`,
        `Title: ${resumed.title || "(session)"}`,
        `Messages restored: ${resumed.messageCount}`
      ].join("\n"),
      "Session"
    );

    store.updateState((state) =>
      setStatusText(
        setSessionAllowedKinds(
          setSessionApprovalMode(
            setDraftInput(
              setTodos(replaceMessages(closeDialog(state), [...restoredMessages, systemMessage]), []),
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
      "Workspace: " + runtime.workspaceRoot,
      "Path scope: local filesystem paths are available to tools.",
      "Execution may still require user approval depending on the tool."
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
      await runtime.clearConversation();
      store.updateState((state) =>
        setDraftInput(
          replaceMessages(
            setTodos(setStatusText(state, "Idle"), []),
            [createSystemMessage("History and session memory cleared.", "Session")]
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
            : "Saved to session memory only.",
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
      runtime.memoryService.clearSession();
      if (parsedCommand.clearPersistent) {
        await runtime.memoryService.clearPersistent();
      }

      await runtime.resetSystemMessage();
      appendUiMessage(
        createSystemMessage(
          parsedCommand.clearPersistent
            ? "Session and persistent memory cleared."
            : "Session memory cleared.",
          "Memory"
        )
      );
      return true;
    }

    if (parsedCommand.type === "context-preview") {
      await runtime.resetSystemMessage();
      appendUiMessage(
        createSystemMessage(runtime.buildContextPreview(parsedCommand.nextUserInput), "Context Preview")
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

      await runtime.resetSystemMessage();

      const turnId = randomUUID();
      const controller = new AbortController();
      const checkpoint: TurnCheckpoint = {
        turnId,
        input: normalized,
        createdAt: new Date().toISOString(),
        runtimeMessageCount: runtime.messages.length,
        uiMessageCount: store.getState().messages.length,
        controller,
        hasAssistantOutput: false,
        hasNonRestorableToolActivity: false,
        userCancelled: false
      };

      runtime.beginTurn(turnId);
      activeTurn = checkpoint;

      store.updateState((state) => setTranscriptSticky(state, true));
      const userMessage = {
        role: "user",
        content: normalized
      } as const;
      runtime.messages.push(userMessage);
      appendUiMessage(createUserMessage(normalized));
      store.updateState((state) => setLoading(setStatusText(state, "Thinking..."), true));
      let completedTurnHistoryPlan: CompletedTurnHistoryPlan | null = null;
      let turnRecorded = false;

      try {
        // 每轮都绑定独立的 abort controller 和 tool context，确保取消只影响当前轮次。
        const client = runtime.requireClient();
        const currentModel = runtime.getCurrentModel();
        const gcliGeminiCompat = shouldUseGcliGeminiCompat(
          runtime.getConnectionConfig().baseURL,
          currentModel
        );
        const reply = await runAgentTurn(client, runtime.messages, {
          model: currentModel,
          maxSteps: runtime.getSettings().maxSteps,
          gcliGeminiCompat,
          messageTimestampsEnabled: runtime.getSettings().messageTimestampsEnabled,
          abortSignal: controller.signal,
          context: runtime.createToolContext({
            turnId,
            abortSignal: controller.signal,
            requestApproval,
            askUserQuestions,
            getTodos,
            setTodos: setTodoItems
          }),
          requestPatches: runtime.requestPatches,
          onThinking: (thinking) => {
            const chunk = thinking.trim();
            if (!chunk) {
              return;
            }

            appendUiMessage(createThinkingMessage(chunk));
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
          onToolCallStart: (toolName, rawArguments) => {
            if (!RESTORABLE_TOOL_NAMES.has(toolName)) {
              checkpoint.hasNonRestorableToolActivity = true;
            }

            appendUiMessage(createToolStartMessage(toolName, rawArguments));
            store.updateState((state) => setStatusText(state, `Running ${toolName}...`));
          },
          onToolCallResult: (toolName, result) => {
            appendUiMessage(createToolResultMessage(toolName, result));
          }
        });

        checkpoint.hasAssistantOutput = true;
        appendUiMessage(createAssistantMessage(reply));
        completedTurnHistoryPlan = {
          mode: "delta",
          apiMessages: runtime.messages.slice(checkpoint.runtimeMessageCount),
          uiBaseMessageCount: checkpoint.uiMessageCount
        };
        throwIfAborted(controller.signal);
        let summaryUpdated = false;
        let compacted = false;
        const postResponseFailures: string[] = [];

        try {
          summaryUpdated = await runtime.memoryService.maybeRefreshAutoSummary({
            client,
            model: currentModel,
            messages: runtime.messages,
            abortSignal: controller.signal
          });
          throwIfAborted(controller.signal);
        } catch (error) {
          if (isTurnInterruptedError(error, controller.signal)) {
            throw error;
          }

          postResponseFailures.push(formatPostResponseFailure("Auto session summary update failed", error));
        }

        try {
          compacted = await runtime.maybeCompactConversation({
            client,
            model: currentModel,
            abortSignal: controller.signal
          });
          if (compacted) {
            completedTurnHistoryPlan = {
              mode: "snapshot",
              apiMessages: runtime.messages.slice(1),
              uiBaseMessageCount: checkpoint.uiMessageCount
            };
          }
          throwIfAborted(controller.signal);
        } catch (error) {
          if (isTurnInterruptedError(error, controller.signal)) {
            throw error;
          }

          postResponseFailures.push(formatPostResponseFailure("Conversation compaction failed", error));
        }

        if (summaryUpdated || compacted) {
          try {
            await runtime.resetSystemMessage();
          } catch (error) {
            if (isTurnInterruptedError(error, controller.signal)) {
              throw error;
            }

            postResponseFailures.push(formatPostResponseFailure("System prompt refresh failed", error));
          }
        }

        if (summaryUpdated) {
          appendUiMessage(createSystemMessage("Auto session summary updated.", "Memory"));
        }

        if (compacted) {
          appendUiMessage(
            createSystemMessage("Conversation was compacted to keep the prompt context bounded.", "Context")
          );
        }

        try {
          if (!completedTurnHistoryPlan) {
            throw new Error("Completed turn history was not prepared.");
          }

          await recordCompletedTurnHistory(runtime, store, completedTurnHistoryPlan);
          turnRecorded = true;
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

          if (checkpoint.userCancelled && !checkpoint.hasAssistantOutput) {
            try {
              if (canFullyRestoreTurn(checkpoint)) {
                await restoreTurn(checkpoint);
              } else {
                runtime.messages.splice(checkpoint.runtimeMessageCount);
                runtime.discardTurn(turnId);
                store.updateState((state) =>
                  setDraftInput(
                    setTranscriptSticky(
                      replaceMessages(
                        setStatusText(state, "Interrupted"),
                        [
                          ...state.messages.slice(0, checkpoint.uiMessageCount),
                          createSystemMessage(
                            [
                              "Request interrupted by user.",
                              "Conversation was rewound because the turn did not finish.",
                              "Some non-rewindable tool side effects may remain on disk."
                            ].join("\n"),
                            "Session"
                          )
                        ]
                      ),
                      true
                    ),
                    checkpoint.input
                  )
                );
              }
            } catch (restoreError) {
              const restoreMessage = getErrorMessage(restoreError);
              appendUiMessage(
                createErrorMessage(`Interrupted, but failed to restore the previous turn: ${restoreMessage}`)
              );
              runtime.discardTurn(turnId);
              store.updateState((state) => setStatusText(state, "Error"));
            }
          } else if (checkpoint.userCancelled) {
            const interruptedApiMessages = runtime.messages.slice(checkpoint.runtimeMessageCount);
            const interruptedUiMessages = store.getState().messages.slice(checkpoint.uiMessageCount);
            try {
              await runtime.recordSessionTurn({
                apiMessages: interruptedApiMessages,
                uiMessages: interruptedUiMessages
              });
            } catch (historyError) {
              const historyMessage = getErrorMessage(historyError);
              appendUiMessage(createErrorMessage(`Interrupted turn was not saved: ${historyMessage}`));
            }

            rememberRewindPoint(checkpoint);
            appendUiMessage(
              createSystemMessage(
                "Request interrupted by user. Press ESC from empty input to choose where to rewind.",
                "Session"
              )
            );
            store.updateState((state) => setStatusText(state, "Interrupted"));
          } else {
            runtime.discardTurn(turnId);
            appendUiMessage(
              createSystemMessage(
                "Request interrupted by user. This turn cannot be fully restored because non-rewindable tools already ran.",
                "Session"
              )
            );
            store.updateState((state) => setStatusText(state, "Interrupted"));
          }
        } else {
          activeTurn = null;
          runtime.messages.splice(checkpoint.runtimeMessageCount);
          runtime.discardTurn(turnId);
          const message = getErrorMessage(error);
          appendUiMessage(createErrorMessage(message));
          store.updateState((state) =>
            setDraftInput(setTranscriptSticky(setStatusText(state, "Error"), true), checkpoint.input)
          );
        }
      } finally {
        store.updateState((state) => setLoading(state, false));
      }
    },
    setDraftInput: (value) => {
      setDraftInputValue(value);
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
    openMessageReader: (messageId) => {
      store.updateState((state) => openMessageReader(state, messageId));
    },
    closeMessageReader: () => {
      store.updateState((state) => closeMessageReader(state));
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
