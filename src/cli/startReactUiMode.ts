import process from "node:process";
import {
  isStartupTimingEnabled,
  logStartupTiming,
  measureStartupTiming
} from "../core/startup/startupTiming.js";

export async function startReactUiMode(argv: string[], env: NodeJS.ProcessEnv) {
  logStartupTiming("startReactUiMode:entered", {
    stdinTTY: process.stdin.isTTY,
    stdoutTTY: process.stdout.isTTY,
    argvLength: argv.length
  });
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Alyce UI requires an interactive TTY terminal.");
  }

  const {
    createSessionRuntime,
    createSessionController,
    startReactUi,
    createInitialTerminalUiState,
    setDraftInput,
    createTerminalUiStore,
    loadStartupContextFromArgs
  } = await loadStartReactUiModeDependencies();

  const runtime = await measureStartupTiming("startReactUiMode:createSessionRuntime", () =>
    createSessionRuntime(argv, env)
  );
  const startupContext = await measureStartupTiming(
    "startReactUiMode:loadStartupContext",
    () => loadStartupContextFromArgs(argv, {
      workspaceRoot: runtime.workspaceRoot,
      allowedRoots: runtime.getAllowedRoots()
    })
  );
  if (startupContext.contextMessage) {
    runtime.messages.push(startupContext.contextMessage);
  }

  const store = await measureStartupTiming("startReactUiMode:createStore", () =>
    createTerminalUiStore(
      createInitialTerminalUiState({
        connectionState: runtime.getConnectionConfigState(),
        settingsState: runtime.getSettingsState(),
        workspaceRoot: runtime.workspaceRoot,
        requestPatchCount: runtime.requestPatches.length,
        planModeEnabled: runtime.getPlanModeState().enabled,
        connectionReady: runtime.hasConnectionConfig()
      })
    )
  );
  if (startupContext.initialPrompt) {
    store.updateState((state) => setDraftInput(state, startupContext.initialPrompt ?? ""));
  }

  const controller = await measureStartupTiming("startReactUiMode:createController", () =>
    createSessionController(runtime, store, {
      startupContextSummary: startupContext.summary
    })
  );
  await measureStartupTiming("startReactUiMode:initializeController", () =>
    controller.initialize()
  );
  await measureStartupTiming("startReactUiMode:startReactUi", () =>
    startReactUi({
      store,
      controller
    })
  );
}

async function loadStartReactUiModeDependencies() {
  if (isStartupTimingEnabled()) {
    logStartupTiming("startReactUiMode:dependencyImportMode", { mode: "serial" });
    const stateActionsModule = await measureStartupTiming(
      "startReactUiMode:importStateActions",
      () => import("../terminal-ui/state/actions.js")
    );
    const stateStoreModule = await measureStartupTiming(
      "startReactUiMode:importStateStore",
      () => import("../terminal-ui/state/store.js")
    );
    const startupContextModule = await measureStartupTiming(
      "startReactUiMode:importStartupContext",
      () => import("./startupContext.js")
    );
    await preloadStartupTimingModules("sessionRuntimeDeps", [
      ["configRuntime", () => import("../config/runtime.js")],
      ["authStore", () => import("../core/auth/authStore.js")],
      ["backgroundProcessManager", () => import("../core/background-process/backgroundProcessManager.js")],
      ["ptyManager", () => import("../core/pty/ptyManager.js")],
      ["memoryService", () => import("../core/memory/memoryService.js")],
      ["turnSnapshotService", () => import("../core/snapshot/turnSnapshotService.js")],
      ["diffService", () => import("../core/diff/diffService.js")],
      ["modelAdapterAvailability", () => import("../core/api/modelAdapterAvailability.js")],
      ["promptBuilder", () => import("../core/prompt/builder.js")],
      ["providerAuth", () => import("../core/providers/providerAuth.js")],
      ["modelDiscovery", () => import("../core/providers/modelDiscovery.js")],
      ["sessionHistoryStorage", () => import("../core/session-history/sessionStorage.js")],
      ["skillService", () => import("../skills/service.js")]
    ]);
    const sessionRuntimeModule = await measureStartupTiming(
      "startReactUiMode:importSessionRuntime",
      () => import("./sessionRuntime.js")
    );
    const sessionControllerModule = await measureStartupTiming(
      "startReactUiMode:importSessionController",
      () => import("../terminal-ui/adapters/sessionController.js")
    );
    await preloadStartupTimingModules("reactUiDeps", [
      ["inkRuntime", () => import("../terminal-ui/runtime/ink.js")],
      ["store", () => import("../terminal-ui/state/store.js")],
      ["app", () => import("../terminal-ui/app/App.js")],
      ["agentScreen", () => import("../terminal-ui/screens/AgentScreen.js")],
      ["messageList", () => import("../terminal-ui/components/MessageList.js")],
      ["markdownRenderer", () => import("../terminal-ui/components/MarkdownRenderer.js")],
      ["promptInput", () => import("../terminal-ui/components/PromptInput.js")],
      ["connectProviderDialog", () => import("../terminal-ui/components/ConnectProviderDialog.js")],
      ["askUserQuestionDialog", () => import("../terminal-ui/components/AskUserQuestionDialog.js")],
      ["mcpElicitationDialog", () => import("../terminal-ui/components/McpElicitationDialog.js")]
    ]);
    const reactUiModule = await measureStartupTiming(
      "startReactUiMode:importReactUi",
      () => import("../terminal-ui/entrypoints/startReactUi.js")
    );

    return {
      createSessionRuntime: sessionRuntimeModule.createSessionRuntime,
      createSessionController: sessionControllerModule.createSessionController,
      startReactUi: reactUiModule.startReactUi,
      createInitialTerminalUiState: stateActionsModule.createInitialTerminalUiState,
      setDraftInput: stateActionsModule.setDraftInput,
      createTerminalUiStore: stateStoreModule.createTerminalUiStore,
      loadStartupContextFromArgs: startupContextModule.loadStartupContextFromArgs
    };
  }

  const [
    sessionRuntimeModule,
    sessionControllerModule,
    reactUiModule,
    stateActionsModule,
    stateStoreModule,
    startupContextModule
  ] = await Promise.all([
    measureStartupTiming("startReactUiMode:importSessionRuntime", () =>
      import("./sessionRuntime.js")
    ),
    measureStartupTiming("startReactUiMode:importSessionController", () =>
      import("../terminal-ui/adapters/sessionController.js")
    ),
    measureStartupTiming("startReactUiMode:importReactUi", () =>
      import("../terminal-ui/entrypoints/startReactUi.js")
    ),
    measureStartupTiming("startReactUiMode:importStateActions", () =>
      import("../terminal-ui/state/actions.js")
    ),
    measureStartupTiming("startReactUiMode:importStateStore", () =>
      import("../terminal-ui/state/store.js")
    ),
    measureStartupTiming("startReactUiMode:importStartupContext", () =>
      import("./startupContext.js")
    )
  ]);

  return {
    createSessionRuntime: sessionRuntimeModule.createSessionRuntime,
    createSessionController: sessionControllerModule.createSessionController,
    startReactUi: reactUiModule.startReactUi,
    createInitialTerminalUiState: stateActionsModule.createInitialTerminalUiState,
    setDraftInput: stateActionsModule.setDraftInput,
    createTerminalUiStore: stateStoreModule.createTerminalUiStore,
    loadStartupContextFromArgs: startupContextModule.loadStartupContextFromArgs
  };
}

async function preloadStartupTimingModules(
  group: string,
  imports: Array<[name: string, run: () => Promise<unknown>]>
) {
  logStartupTiming(`startReactUiMode:${group}:start`, { count: imports.length });
  for (const [name, run] of imports) {
    await measureStartupTiming(`startReactUiMode:${group}:${name}`, run);
  }
  logStartupTiming(`startReactUiMode:${group}:end`);
}
