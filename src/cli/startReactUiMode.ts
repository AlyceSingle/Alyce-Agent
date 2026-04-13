import process from "node:process";
import { createSessionRuntime } from "./sessionRuntime.js";
import { createSessionController } from "../terminal-ui/adapters/sessionController.js";
import { startReactUi } from "../terminal-ui/entrypoints/startReactUi.js";
import {
  createInitialTerminalUiState
} from "../terminal-ui/state/actions.js";
import { createTerminalUiStore } from "../terminal-ui/state/store.js";

export async function startReactUiMode(argv: string[], env: NodeJS.ProcessEnv) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Alyce UI requires an interactive TTY terminal.");
  }

  const runtime = await createSessionRuntime(argv, env);
  const store = createTerminalUiStore(
    createInitialTerminalUiState({
      connection: runtime.getConnectionConfig(),
      settings: runtime.getSettings(),
      workspaceRoot: runtime.workspaceRoot,
      requestPatchCount: runtime.requestPatches.length
    })
  );

  const controller = createSessionController(runtime, store);
  controller.initialize();
  await startReactUi({
    store,
    controller
  });
}
