import React from "react";
import { App } from "../app/App.js";
import type { SessionController } from "../adapters/sessionController.js";
import { render } from "../runtime/ink.js";
import type { TerminalUiStore } from "../state/store.js";

export async function startReactUi(options: {
  store: TerminalUiStore;
  controller: SessionController;
}) {
  const instance = await render(<App store={options.store} controller={options.controller} />, {
    exitOnCtrlC: false
  });
  await instance.waitUntilExit();
}
