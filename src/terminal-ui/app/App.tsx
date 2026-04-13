import React from "react";
import type { SessionController } from "../adapters/sessionController.js";
import { AgentScreen } from "../screens/AgentScreen.js";
import { TerminalUiStoreProvider, type TerminalUiStore } from "../state/store.js";

export function App(props: {
  store: TerminalUiStore;
  controller: SessionController;
}) {
  return (
    <TerminalUiStoreProvider store={props.store}>
      <AgentScreen controller={props.controller} />
    </TerminalUiStoreProvider>
  );
}
