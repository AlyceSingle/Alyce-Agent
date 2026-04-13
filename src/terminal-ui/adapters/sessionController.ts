import { runAgentTurn } from "../../agent.js";
import { parseReplCommand } from "../../cli/commandRouter.js";
import {
  formatMemorySnapshot,
  getHelpText,
  type SessionRuntime
} from "../../cli/sessionRuntime.js";
import type { ConnectionConfig, SessionSettings } from "../../config/runtime.js";
import type { ToolApprovalRequest, ToolPermissionKind } from "../../tools/types.js";
import {
  allowSessionKind,
  appendMessage,
  closeDialog,
  openPermissionDialog,
  openSettingsDialog,
  replaceMessages,
  setConnectionConfig,
  setLoading,
  setSessionAllowedKinds,
  setSessionApprovalMode,
  setSessionSettings,
  setStatusText
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

export interface SessionController {
  initialize: () => void;
  submit: (input: string) => Promise<void>;
  respondToApproval: (decision: PermissionDecision) => void;
  openSettings: (section?: SettingsSection, reason?: string) => void;
  closeDialog: () => void;
  saveConfig: (connection: ConnectionConfig, settings: SessionSettings) => Promise<void>;
  requestExit: () => void;
  setExitHandler: (handler: (() => void) | null) => void;
}

export function createSessionController(
  runtime: SessionRuntime,
  store: TerminalUiStore
): SessionController {
  let exitHandler: (() => void) | null = null;
  let pendingApprovalResolver: ((decision: PermissionDecision) => void) | null = null;
  let sessionApprovalMode = runtime.getSettings().approvalMode;
  const sessionAllowedKinds = new Set<ToolPermissionKind>();

  const appendUiMessage = (message: TerminalUiMessage) => {
    store.updateState((state) => appendMessage(state, message));
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
      await runtime.clearConversation();
      store.updateState((state) =>
        replaceMessages(
          setStatusText(state, "Idle"),
          [createSystemMessage("History and session memory cleared.", "Session")]
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

    if (parsedCommand.type === "switch-model") {
      await runtime.setCurrentModel(parsedCommand.model);
      store.updateState((state) => setConnectionConfig(state, runtime.getConnectionConfig()));
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

      runtime.messages.push({
        role: "user",
        content: normalized
      });
      appendUiMessage(createUserMessage(normalized));
      store.updateState((state) => setLoading(setStatusText(state, "Thinking..."), true));

      try {
        const client = runtime.requireClient();
        const reply = await runAgentTurn(client, runtime.messages, {
          model: runtime.getCurrentModel(),
          maxSteps: runtime.getSettings().maxSteps,
          context: runtime.createToolContext(requestApproval),
          requestPatches: runtime.requestPatches,
          onThinking: (thinking) => {
            const chunk = thinking.trim();
            if (!chunk) {
              return;
            }

            appendUiMessage(createThinkingMessage(chunk));
          },
          onToolCallStart: (toolName, rawArguments) => {
            appendUiMessage(createToolStartMessage(toolName, rawArguments));
            store.updateState((state) => setStatusText(state, `Running ${toolName}...`));
          },
          onToolCallResult: (toolName, result) => {
            appendUiMessage(createToolResultMessage(toolName, result));
          }
        });

        appendUiMessage(createAssistantMessage(reply));

        const summaryUpdated = await runtime.memoryService.maybeRefreshAutoSummary({
          client,
          model: runtime.getCurrentModel(),
          messages: runtime.messages
        });

        if (summaryUpdated) {
          await runtime.resetSystemMessage();
          appendUiMessage(createSystemMessage("Auto session summary updated.", "Memory"));
        }

        store.updateState((state) => setStatusText(state, "Idle"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendUiMessage(createErrorMessage(message));
        store.updateState((state) => setStatusText(state, "Error"));
      } finally {
        store.updateState((state) => setLoading(state, false));
      }
    },
    respondToApproval: (decision) => {
      pendingApprovalResolver?.(decision);
    },
    openSettings: (section = "session", reason) => {
      store.updateState((state) => openSettingsDialog(state, section, reason));
    },
    closeDialog: () => {
      const activeDialog = store.getState().dialog;
      if (activeDialog?.type === "permission") {
        return;
      }

      setDialogClosed();
    },
    saveConfig: async (connection, settings) => {
      await runtime.updateConnectionConfig(connection);
      await runtime.updateSettings(settings);

      sessionApprovalMode = settings.approvalMode;
      sessionAllowedKinds.clear();

      store.updateState((state) =>
        setStatusText(
          setSessionAllowedKinds(
            setSessionApprovalMode(
              setSessionSettings(setConnectionConfig(closeDialog(state), runtime.getConnectionConfig()), runtime.getSettings()),
              sessionApprovalMode
            ),
            []
          ),
          "Settings saved"
        )
      );

      appendUiMessage(createSystemMessage("Connection and runtime settings saved.", "Settings"));
    },
    requestExit: () => {
      exitHandler?.();
    },
    setExitHandler: (handler) => {
      exitHandler = handler;
    }
  };
}
