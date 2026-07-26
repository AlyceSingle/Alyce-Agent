import process from "node:process";
import { resolveConnectProvider } from "../../../cli/connectCommand.js";
import { resolveModelSwitch } from "../../../cli/modelCommand.js";
import type { SessionRuntime } from "../../../cli/sessionRuntime.js";
import { getErrorMessage } from "../../../core/util/error.js";
import { t } from "../../../i18n/index.js";
import {
  closeDialog,
  openModelPickerDialog,
  setConnectionConfigState,
  setStatusText,
  updateModelPickerDialogState
} from "../../state/actions.js";
import type { TerminalUiStore } from "../../state/store.js";
import type { ModelPickerDialogState, TerminalUiMessage } from "../../state/types.js";
import { createErrorMessage, createSystemMessage } from "../messageMapper.js";

export interface ProviderConnectionController {
  applyConnectProvider: (
    provider: string | undefined,
    args: string[],
    options: { closeActiveDialog: boolean; appendErrorMessage: boolean }
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  authorizeProviderAuthFromDialog: (
    provider: string,
    methodIndex: number,
    inputs: Record<string, string>
  ) => Promise<
    | { ok: true; type: "stored" }
    | { ok: true; type: "flow"; method: "auto" | "code"; url: string; instructions: string }
    | { ok: false; message: string }
  >;
  completeProviderAuthFromDialog: (
    provider: string,
    methodIndex: number,
    code?: string,
    options?: { signal?: AbortSignal }
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  cancelProviderAuthFromDialog: (provider: string, methodIndex: number) => void;
  switchCurrentModel: (
    model: string,
    options: { closeActiveDialog: boolean; appendErrorMessage: boolean }
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  openModelPicker: () => Promise<void>;
}

export function createProviderConnectionController(deps: {
  runtime: SessionRuntime;
  store: TerminalUiStore;
  appendUiMessage: (message: TerminalUiMessage) => void;
}): ProviderConnectionController {
  const { runtime, store, appendUiMessage } = deps;

  const applyConnectProvider = async (
    provider: string | undefined,
    args: string[],
    options: {
      closeActiveDialog: boolean;
      appendErrorMessage: boolean;
    }
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    const result = resolveConnectProvider(provider, args, {
      connectionState: runtime.getConnectionConfigState()
    });
    if (!result.ok) {
      const message = [result.message, ...result.suggestions].filter(Boolean).join("\n");
      if (options.appendErrorMessage) {
        appendUiMessage(createErrorMessage(message));
      }
      return { ok: false, message };
    }

    try {
      await runtime.applyProviderConnection(result.plan);
      store.updateState((state) => {
        const nextState = setConnectionConfigState(
          setStatusText(state, t("status.idle")),
          runtime.getConnectionConfigState()
        );
        return options.closeActiveDialog ? closeDialog(nextState) : nextState;
      });
      appendUiMessage(
        createSystemMessage(
          [
            result.plan.summary,
            ...result.plan.details,
            `Auth file: ${runtime.getAuthStorePath()}`
          ].join("\n"),
          "Connect"
        )
      );
      return { ok: true };
    } catch (error) {
      const message = `Connect failed: ${getErrorMessage(error)}`;
      if (options.appendErrorMessage) {
        appendUiMessage(createErrorMessage(message));
      }
      store.updateState((state) => setStatusText(state, t("status.error")));
      return { ok: false, message };
    }
  };

  const finishProviderAuthDialogConnection = (
    providerId: string,
    model: string,
    closeActiveDialog: boolean
  ) => {
    store.updateState((state) => {
      const nextState = setConnectionConfigState(
        setStatusText(state, t("status.idle")),
        runtime.getConnectionConfigState()
      );
      return closeActiveDialog ? closeDialog(nextState) : nextState;
    });
    appendUiMessage(
      createSystemMessage(
        [
          `Connected ${providerId}.`,
          `Current model: ${model}`,
          `Auth file: ${runtime.getAuthStorePath()}`
        ].join("\n"),
        "Connect"
      )
    );
  };

  const authorizeProviderAuthFromDialog = async (
    provider: string,
    methodIndex: number,
    inputs: Record<string, string>
  ): Promise<
    | { ok: true; type: "stored" }
    | { ok: true; type: "flow"; method: "auto" | "code"; url: string; instructions: string }
    | { ok: false; message: string }
  > => {
    try {
      const result = await runtime.authorizeProviderAuth(provider, methodIndex, inputs);
      if (result.type === "flow") {
        store.updateState((state) => setStatusText(state, t("status.waitingAuth")));
        return {
          ok: true,
          type: "flow",
          method: result.flow.method,
          url: result.flow.url,
          instructions: result.flow.instructions
        };
      }

      finishProviderAuthDialogConnection(result.providerId, result.model, true);
      return { ok: true, type: "stored" };
    } catch (error) {
      const message = `Connect failed: ${getErrorMessage(error)}`;
      store.updateState((state) => setStatusText(state, t("status.error")));
      return { ok: false, message };
    }
  };

  const completeProviderAuthFromDialog = async (
    provider: string,
    methodIndex: number,
    code?: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      const result = await runtime.completeProviderAuth(provider, methodIndex, code, options);
      finishProviderAuthDialogConnection(result.providerId, result.model, true);
      return { ok: true };
    } catch (error) {
      const message = `Connect failed: ${getErrorMessage(error)}`;
      store.updateState((state) => setStatusText(state, t("status.error")));
      return { ok: false, message };
    }
  };

  const cancelProviderAuthFromDialog = (provider: string, _methodIndex: number) => {
    runtime.clearProviderAuthFlow(provider);
    store.updateState((state) => setStatusText(state, t("status.idle")));
  };

  const switchCurrentModel = async (
    model: string,
    options: {
      closeActiveDialog: boolean;
      appendErrorMessage: boolean;
    }
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    const result = resolveModelSwitch(model, {
      currentModel: runtime.getCurrentModel(),
      providers: runtime.getConnectionConfigState().providerProfiles,
      settings: runtime.getSettings(),
      env: process.env
    });
    if (!result.ok) {
      const message = [result.message, ...result.suggestions].filter(Boolean).join("\n");
      if (options.appendErrorMessage) {
        appendUiMessage(createErrorMessage(message));
      }
      return { ok: false, message };
    }

    try {
      await runtime.setCurrentModel(result.persistModel);
      store.updateState((state) => {
        const nextState = setConnectionConfigState(
          setStatusText(state, t("status.idle")),
          runtime.getConnectionConfigState()
        );
        return options.closeActiveDialog ? closeDialog(nextState) : nextState;
      });
      appendUiMessage(
        createSystemMessage(
          [
            `Switched model to: ${result.displayModel}`,
            ...result.warnings
          ].join("\n"),
          "Model"
        )
      );
      return { ok: true };
    } catch (error) {
      const message = `Model switch failed: ${getErrorMessage(error)}`;
      if (options.appendErrorMessage) {
        appendUiMessage(createErrorMessage(message));
      }
      store.updateState((state) => setStatusText(state, t("status.error")));
      return { ok: false, message };
    }
  };

  const createModelPickerLoadingState = (): ModelPickerDialogState => {
    try {
      const resolved = runtime.getResolvedModelProfile();
      return {
        status: "loading",
        providerId: resolved.providerId,
        providerLabel: resolved.provider.label
      };
    } catch {
      const currentModel = runtime.getCurrentModel();
      const providerId = currentModel.includes("/")
        ? currentModel.slice(0, currentModel.indexOf("/")).trim() || "openai"
        : "openai";
      return {
        status: "loading",
        providerId,
        providerLabel: providerId
      };
    }
  };

  const openModelPicker = async () => {
    const loadingState = createModelPickerLoadingState();
    store.updateState((state) =>
      openModelPickerDialog(setStatusText(state, t("status.refreshingModels")), loadingState)
    );

    const result = await runtime.refreshCurrentProviderModels()
      .catch((error: unknown) => ({
        providerId: loadingState.providerId,
        providerLabel: loadingState.providerLabel,
        models: {},
        source: "fallback" as const,
        error: getErrorMessage(error)
      }));
    store.updateState((state) =>
      updateModelPickerDialogState(
        setConnectionConfigState(setStatusText(state, t("status.idle")), runtime.getConnectionConfigState()),
        {
          status: "ready",
          providerId: result.providerId,
          providerLabel: result.providerLabel,
          source: result.source,
          ...(result.error ? { error: result.error } : {})
        }
      )
    );
  };

  return {
    applyConnectProvider,
    authorizeProviderAuthFromDialog,
    completeProviderAuthFromDialog,
    cancelProviderAuthFromDialog,
    switchCurrentModel,
    openModelPicker
  };
}
