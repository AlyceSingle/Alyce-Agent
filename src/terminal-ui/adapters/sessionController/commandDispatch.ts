import process from "node:process";
import { parseReplCommand } from "../../../cli/commandRouter.js";
import { normalizeLogoutProvider } from "../../../cli/connectCommand.js";
import { formatCurrentModelDisplay } from "../../../cli/modelCommand.js";
import {
  formatBackgroundProcessList,
  formatBackgroundProcessStopResult
} from "../../../cli/processCommand.js";
import {
  formatMemorySnapshot,
  getHelpText,
  type SessionRuntime
} from "../../../cli/sessionRuntime.js";
import {
  formatTaskDetails,
  formatTaskList,
  formatTaskStopResult
} from "../../../cli/taskCommand.js";
import {
  formatDiffDetails,
  formatDiffOverview
} from "../../../core/diff/diffService.js";
import { formatDoctorReport, runDoctorDiagnostics } from "../../../core/doctor/doctor.js";
import { getErrorMessage } from "../../../core/util/error.js";
import { t } from "../../../i18n/index.js";
import {
  openConnectProviderDialog,
  openPermissionsDialog,
  openSettingsDialog,
  replaceMessages,
  setConnectionConfigState,
  setContextBudget,
  setDraftInput,
  setSessionSettingsState,
  setStatusText,
  setTodos
} from "../../state/actions.js";
import type { TerminalUiStore } from "../../state/store.js";
import type { TerminalUiMessage } from "../../state/types.js";
import { createErrorMessage, createSystemMessage } from "../messageMapper.js";
import type { DirectoryAccessHelpers } from "./directoryAccess.js";
import type { ProviderConnectionController } from "./providerConnection.js";
import {
  isMcpParsedCommand,
  isSkillsParsedCommand,
  isTrustParsedCommand,
  type ParsedReplCommand,
  type WorkspaceCommandHandlers
} from "./workspaceCommands.js";

export interface CommandDispatcherDeps extends DirectoryAccessHelpers, WorkspaceCommandHandlers {
  runtime: SessionRuntime;
  store: TerminalUiStore;
  appendUiMessage: (message: TerminalUiMessage) => void;
  requestExit: () => void;
  applyConnectProvider: ProviderConnectionController["applyConnectProvider"];
  switchCurrentModel: ProviderConnectionController["switchCurrentModel"];
  openModelPicker: ProviderConnectionController["openModelPicker"];
  setPlanModeFromUi: (enabled: boolean) => Promise<void>;
  openSessionPicker: () => Promise<void>;
  resumeSessionByQuery: (query: string) => Promise<void>;
  formatSessionList: (
    sessions: Awaited<ReturnType<SessionRuntime["listSessionHistory"]>>
  ) => string;
  openRewindSelector: () => void;
  clearRewindPoints: () => void;
  resetSessionHistoryPaging: () => void;
  resetTaskTracking: () => void;
  syncBackgroundTasks: (options?: { notify?: boolean }) => void;
  syncBackgroundProcesses: () => void;
  unreadTaskIds: Set<string>;
  syncDiagnosticsRegistrySettings: () => void;
}

export function createCommandDispatcher(deps: CommandDispatcherDeps) {
  const {
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
  } = deps;

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

  return handleCommand;
}
