import process from "node:process";
import { createSessionRuntime } from "./sessionRuntime.js";
import { createSessionController } from "../terminal-ui/adapters/sessionController.js";
import { startReactUi } from "../terminal-ui/entrypoints/startReactUi.js";
import {
  createInitialTerminalUiState,
  setDraftInput
} from "../terminal-ui/state/actions.js";
import { createTerminalUiStore } from "../terminal-ui/state/store.js";
import { loadStartupContextFromArgs } from "./startupContext.js";

export async function startReactUiMode(argv: string[], env: NodeJS.ProcessEnv) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Alyce UI requires an interactive TTY terminal.");
  }

  const runtime = await createSessionRuntime(argv, env);
  const startupContext = await loadStartupContextFromArgs(argv, {
    workspaceRoot: runtime.workspaceRoot,
    allowedRoots: runtime.getAllowedRoots()
  });
  if (startupContext.contextMessage) {
    runtime.messages.push(startupContext.contextMessage);
  }

  const store = createTerminalUiStore(
    createInitialTerminalUiState({
      connectionState: runtime.getConnectionConfigState(),
      settingsState: runtime.getSettingsState(),
      workspaceRoot: runtime.workspaceRoot,
      requestPatchCount: runtime.requestPatches.length,
      planModeEnabled: runtime.getPlanModeState().enabled,
      connectionReady: runtime.hasConnectionConfig()
    })
  );
  if (startupContext.initialPrompt) {
    store.updateState((state) => setDraftInput(state, startupContext.initialPrompt ?? ""));
  }

  const controller = createSessionController(runtime, store, {
    startupContextSummary: startupContext.summary
  });
  controller.initialize();
  await startReactUi({
    store,
    controller
  });
}
