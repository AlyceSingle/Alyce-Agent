import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
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
import type { PermissionDecision, SettingsSection, TerminalUiMessage } from "../state/types.js";
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

// 每轮请求在执行前都会记录一个 checkpoint，便于中断时回滚消息和文件改动。
interface TurnCheckpoint {
  turnId: string;
  input: string;
  runtimeMessageCount: number;
  uiMessageCount: number;
  controller: AbortController;
  hasAssistantOutput: boolean;
  hasNonRestorableToolActivity: boolean;
  userCancelled: boolean;
}

export interface SessionController {
  initialize: () => void;
  submit: (input: string) => Promise<void>;
  setDraftInput: (value: string) => void;
  interrupt: () => void;
  restoreLastInterruptedTurn: () => Promise<void>;
  respondToApproval: (decision: PermissionDecision) => void;
  respondToQuestion: (response: AskUserQuestionResponse | null) => void;
  openSettings: (section?: SettingsSection, reason?: string) => void;
  openMessageReader: (messageId: string) => void;
  closeMessageReader: () => void;
  closeDialog: () => void;
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
  let lastInterruptedTurn: TurnCheckpoint | null = null;

  const appendUiMessage = (message: TerminalUiMessage) => {
    store.updateState((state) => appendMessage(state, message));
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

  const discardInterruptedTurn = () => {
    if (!lastInterruptedTurn) {
      return;
    }

    runtime.discardTurn(lastInterruptedTurn.turnId);
    lastInterruptedTurn = null;
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
    if (lastInterruptedTurn?.turnId === turn.turnId) {
      lastInterruptedTurn = null;
    }
  };

  const requestApproval = async (request: ToolApprovalRequest) => {
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

    return new Promise<boolean>((resolve) => {
      // 审批结果既影响当前请求，也可能提升为“本会话允许该类操作”或“全会话自动批准”。
      pendingApprovalResolver = (decision) => {
        pendingApprovalResolver = null;
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
    });
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

    const absolutePath = path.isAbsolute(normalized)
      ? path.resolve(normalized)
      : path.resolve(runtime.workspaceRoot, normalized);
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

  const dedupeDirectories = (directories: string[]) => {
    const deduped = new Set<string>();
    for (const directory of directories) {
      deduped.add(path.resolve(directory));
    }

    return [...deduped];
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
      exitHandler?.();
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

    if (parsedCommand.type === "clear") {
      discardInterruptedTurn();
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
      appendUiMessage(
        createSystemMessage(runtime.buildContextPreview(parsedCommand.nextUserInput), "Context Preview")
      );
      return true;
    }

    if (parsedCommand.type === "add-directory") {
      const absolutePath = await resolveAdditionalDirectory(parsedCommand.directory);
      const alreadyAllowed = runtime.getAllowedRoots().includes(absolutePath);

      if (alreadyAllowed) {
        appendUiMessage(
          createSystemMessage(`Directory is already allowed: ${absolutePath}`, "Permissions")
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
        const nextSessionDirectories = runtime
          .getSessionAdditionalDirectories()
          .filter((directory) => directory !== absolutePath);
        await runtime.setSessionAdditionalDirectories(nextSessionDirectories);

        store.updateState((state) =>
          setSessionSettingsState(setStatusText(state, "Idle"), runtime.getSettingsState())
        );
        appendUiMessage(
          createSystemMessage(`Allowed and saved directory: ${absolutePath}`, "Permissions")
        );
        return true;
      }

      const nextSessionDirectories = dedupeDirectories([
        ...runtime.getSessionAdditionalDirectories(),
        absolutePath
      ]);
      await runtime.setSessionAdditionalDirectories(nextSessionDirectories);
      appendUiMessage(
        createSystemMessage(`Allowed directory for this session: ${absolutePath}`, "Permissions")
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
            "Workspace: " + runtime.workspaceRoot,
            "Allowed roots: " + runtime.getAllowedRoots().join(", "),
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

      discardInterruptedTurn();
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
      runtime.messages.push({
        role: "user",
        content: normalized
      });
      appendUiMessage(createUserMessage(normalized));
      store.updateState((state) => setLoading(setStatusText(state, "Thinking..."), true));

      try {
        // 每轮都绑定独立的 abort controller 和 tool context，确保取消只影响当前轮次。
        const client = runtime.requireClient();
        const reply = await runAgentTurn(client, runtime.messages, {
          model: runtime.getCurrentModel(),
          maxSteps: runtime.getSettings().maxSteps,
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
        throwIfAborted(controller.signal);

        const summaryUpdated = await runtime.memoryService.maybeRefreshAutoSummary({
          client,
          model: runtime.getCurrentModel(),
          messages: runtime.messages,
          abortSignal: controller.signal
        });

        throwIfAborted(controller.signal);

        if (summaryUpdated) {
          await runtime.resetSystemMessage();
          appendUiMessage(createSystemMessage("Auto session summary updated.", "Memory"));
        }

        runtime.discardTurn(turnId);
        activeTurn = null;
        store.updateState((state) => setStatusText(state, "Idle"));
      } catch (error) {
        if (isTurnInterruptedError(error, controller.signal)) {
          activeTurn = null;

          // 只有在未产生不可回滚副作用时，才允许把中断前状态完整恢复出来。
          if (checkpoint.userCancelled && canFullyRestoreTurn(checkpoint) && !checkpoint.hasAssistantOutput) {
            try {
              await restoreTurn(checkpoint);
            } catch (restoreError) {
              const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
              appendUiMessage(
                createErrorMessage(`Interrupted, but failed to restore the previous turn: ${restoreMessage}`)
              );
              runtime.discardTurn(turnId);
              store.updateState((state) => setStatusText(state, "Error"));
            }
          } else if (checkpoint.userCancelled && canFullyRestoreTurn(checkpoint)) {
            lastInterruptedTurn = checkpoint;
            appendUiMessage(
              createSystemMessage(
                "Request interrupted by user. Press ESC again to restore the previous turn.",
                "Session"
              )
            );
            store.updateState((state) => setStatusText(state, "Interrupted"));
          } else {
            runtime.discardTurn(turnId);
            lastInterruptedTurn = null;
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
          runtime.discardTurn(turnId);
          const message = error instanceof Error ? error.message : String(error);
          appendUiMessage(createErrorMessage(message));
          store.updateState((state) => setStatusText(state, "Error"));
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
    restoreLastInterruptedTurn: async () => {
      if (!lastInterruptedTurn) {
        return;
      }

      try {
        await restoreTurn(lastInterruptedTurn);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendUiMessage(createErrorMessage(`Failed to restore the interrupted turn: ${message}`));
        store.updateState((state) => setStatusText(state, "Error"));
      }
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
      exitHandler?.();
    },
    setExitHandler: (handler) => {
      exitHandler = handler;
    }
  };
}
