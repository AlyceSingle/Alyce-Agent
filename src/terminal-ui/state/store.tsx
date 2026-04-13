import React, { createContext, useContext, useSyncExternalStore } from "react";
import type { TerminalUiState } from "./types.js";

type Listener = () => void;

export interface TerminalUiStore {
  getState: () => TerminalUiState;
  subscribe: (listener: Listener) => () => void;
  setState: (nextState: TerminalUiState) => void;
  updateState: (updater: (state: TerminalUiState) => TerminalUiState) => void;
}

const TerminalUiStoreContext = createContext<TerminalUiStore | null>(null);

export function createTerminalUiStore(initialState: TerminalUiState): TerminalUiStore {
  let state = initialState;
  const listeners = new Set<Listener>();

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setState: (nextState) => {
      state = nextState;
      notify();
    },
    updateState: (updater) => {
      state = updater(state);
      notify();
    }
  };
}

export function TerminalUiStoreProvider(props: {
  store: TerminalUiStore;
  children: React.ReactNode;
}) {
  return (
    <TerminalUiStoreContext.Provider value={props.store}>
      {props.children}
    </TerminalUiStoreContext.Provider>
  );
}

export function useTerminalUiStore() {
  const store = useContext(TerminalUiStoreContext);
  if (!store) {
    throw new Error("TerminalUiStoreProvider is missing.");
  }

  return store;
}

export function useTerminalUiSelector<T>(selector: (state: TerminalUiState) => T) {
  const store = useTerminalUiStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState())
  );
}
