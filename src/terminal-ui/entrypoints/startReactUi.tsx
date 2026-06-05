import { App } from "../app/App.js";
import type { SessionController } from "../adapters/sessionController.js";
import { renderSync as render } from "../runtime/ink-runtime/root.js";
import type { TerminalUiStore } from "../state/store.js";
import {
  logStartupTiming,
  measureStartupTiming
} from "../../core/startup/startupTiming.js";

export async function startReactUi(options: {
  store: TerminalUiStore;
  controller: SessionController;
}) {
  logStartupTiming("reactUi:start");
  const instance = await measureStartupTiming("reactUi:render", () =>
    render(<App store={options.store} controller={options.controller} />, {
      exitOnCtrlC: false
    })
  );
  logStartupTiming("reactUi:rendered");
  await measureStartupTiming("reactUi:waitUntilExit", () => instance.waitUntilExit());
}
