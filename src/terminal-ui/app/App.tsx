import React from "react";
import type { SessionController } from "../adapters/sessionController.js";
import { AlternateScreen } from "../runtime/ink.js";
import { AgentScreen } from "../screens/AgentScreen.js";
import { TerminalUiStoreProvider, type TerminalUiStore } from "../state/store.js";

export function App(props: {
  store: TerminalUiStore;
  controller: SessionController;
}) {
  return (
    <TerminalUiStoreProvider store={props.store}>
      <AlternateScreen>
        <AgentScreen controller={props.controller} />
      </AlternateScreen>
    </TerminalUiStoreProvider>
  );
}
