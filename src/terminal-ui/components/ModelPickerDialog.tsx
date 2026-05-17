import { useEffect, useMemo, useState } from "react";
import type { ConnectionConfigState, SessionSettings } from "../../config/runtime.js";
import { getModelAdapterAvailability } from "../../core/api/modelAdapters.js";
import { formatModelRef, parseModelRef, resolveModelProfile } from "../../core/providers/resolveModel.js";
import type { ModelRef, ProviderProfile } from "../../core/providers/types.js";
import type { ModelPickerDialogState } from "../state/types.js";
import { Box, Text, useInput, useTerminalSize } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";
import { Pane } from "./Pane.js";

const VISIBLE_MODEL_COUNT = 12;

export interface ModelPickerOption {
  id: string;
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelRef: string;
  label: string;
  status: string;
  current: boolean;
  available: boolean;
}

export function ModelPickerDialog(props: {
  connectionState: ConnectionConfigState;
  settings: Pick<SessionSettings, "modelContextWindowOverrides">;
  currentModel: string;
  refreshState: ModelPickerDialogState;
  env?: NodeJS.ProcessEnv;
  onSelect: (model: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  onCancel: () => void;
}) {
  const terminalSize = useTerminalSize();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const options = useMemo(
    () => createModelPickerOptions({
      connectionState: props.connectionState,
      settings: props.settings,
      currentModel: props.currentModel,
      env: props.env
    }),
    [props.connectionState, props.currentModel, props.env, props.settings]
  );
  const visibleOptions = useMemo(
    () => filterModelPickerOptions(options, query),
    [options, query]
  );

  useEffect(() => {
    if (query.trim()) {
      setSelectedIndex(0);
      return;
    }

    const currentIndex = options.findIndex((option) => option.current);
    setSelectedIndex(Math.max(0, currentIndex));
  }, [options, query]);

  useEffect(() => {
    setSelectedIndex((current) =>
      Math.min(Math.max(0, current), Math.max(0, visibleOptions.length - 1))
    );
  }, [visibleOptions.length]);

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "c") {
      props.onCancel();
      return;
    }

    if (submitting) {
      return;
    }

    if (key.escape) {
      props.onCancel();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      setError(null);
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(visibleOptions.length - 1, current + 1));
      setError(null);
      return;
    }

    if (key.return) {
      const selected = visibleOptions[selectedIndex];
      if (!selected) {
        return;
      }

      setSubmitting(true);
      setError(null);
      props.onSelect(selected.modelRef)
        .then((result) => {
          if (!result.ok) {
            setSubmitting(false);
            setError(result.message);
          }
        })
        .catch((selectError: unknown) => {
          setSubmitting(false);
          setError(selectError instanceof Error ? selectError.message : String(selectError));
        });
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      setError(null);
      return;
    }

    if (key.ctrl && input.toLowerCase() === "u") {
      setQuery("");
      setError(null);
      return;
    }

    if (key.ctrl || key.meta || !input) {
      return;
    }

    setQuery((current) => current + input);
    setError(null);
  }, { isActive: true });

  const panelWidth = Math.max(1, Math.min(82, (terminalSize.columns || 90) - 4));
  const currentDisplay = options.find((option) => option.current)?.modelRef ?? props.currentModel;

  return (
    <Box alignItems="center" justifyContent="center" height="100%" width="100%">
      <Box
        borderStyle="round"
        borderColor={terminalUiTheme.colors.inputBorder}
        flexDirection="column"
        paddingX={2}
        paddingY={1}
        width={panelWidth}
      >
        <Pane
          title="Switch model"
          subtitle={`current ${currentDisplay}`}
          accentColor={terminalUiTheme.colors.chrome}
          footer="Type to search | Up/Down choose | Enter switch | Esc cancel"
        >
          {props.refreshState.status === "loading" ? (
            <Text color={terminalUiTheme.colors.info} wrap="truncate-end">
              Refreshing {props.refreshState.providerLabel} models...
            </Text>
          ) : (
            <ModelListView
              query={query}
              options={visibleOptions}
              selectedIndex={selectedIndex}
            />
          )}
          {props.refreshState.status === "ready" && props.refreshState.source === "fallback" ? (
            <Text color={terminalUiTheme.colors.warning} wrap="wrap">
              Using local model list: {props.refreshState.error ?? "live refresh unavailable"}
            </Text>
          ) : null}
          {submitting ? (
            <Text color={terminalUiTheme.colors.info} wrap="truncate-end">
              Switching model...
            </Text>
          ) : null}
          {error ? (
            <Text color={terminalUiTheme.colors.danger} wrap="wrap">
              {error}
            </Text>
          ) : null}
        </Pane>
      </Box>
    </Box>
  );
}

export function createModelPickerOptions(options: {
  connectionState: ConnectionConfigState;
  settings: Pick<SessionSettings, "modelContextWindowOverrides">;
  currentModel: string;
  env?: NodeJS.ProcessEnv;
}): ModelPickerOption[] {
  const currentRef = parseModelRefSafely(options.currentModel);
  const provider = currentRef
    ? options.connectionState.providerProfiles[currentRef.providerId]
    : undefined;
  const result: ModelPickerOption[] = [];

  if (!provider || !currentRef) {
    return result;
  }

  const modelIds = getProviderModelIds(provider, currentRef.modelId);
  for (const modelId of modelIds) {
    const ref = {
      providerId: provider.id,
      modelId
    };
    const modelRef = formatModelRef(ref);
    const current = currentRef.providerId === ref.providerId && currentRef.modelId === ref.modelId;
    const availability = getModelAvailability(ref, options);
    const label = provider.models?.[modelId]?.label?.trim() || modelId;
    result.push({
      id: modelRef,
      providerId: provider.id,
      providerLabel: provider.label,
      modelId,
      modelRef,
      label,
      status: current ? "current" : availability.status,
      current,
      available: availability.available
    });
  }

  return result;
}

export function filterModelPickerOptions(
  options: ModelPickerOption[],
  query: string
): ModelPickerOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) =>
    [
      option.providerId,
      option.providerLabel,
      option.modelId,
      option.modelRef,
      option.label,
      option.status
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  );
}

function ModelListView(props: {
  query: string;
  options: ModelPickerOption[];
  selectedIndex: number;
}) {
  const window = getVisibleModelWindow(props.options, props.selectedIndex);
  return (
    <Box flexDirection="column" width="100%">
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        Search {props.query}
        <Text inverse>{" "}</Text>
      </Text>
      {props.options.length === 0 ? (
        <Text color={terminalUiTheme.colors.warning} wrap="truncate-end">
          No models match this search.
        </Text>
      ) : (
        window.options.map((option, index) => {
          const actualIndex = window.startIndex + index;
          const previous = actualIndex > 0 ? props.options[actualIndex - 1] : undefined;
          const showProvider = previous?.providerId !== option.providerId;
          return (
            <Box key={option.id} flexDirection="column" width="100%">
              {showProvider ? (
                <Text color={terminalUiTheme.colors.system} wrap="truncate-end">
                  {option.providerLabel}
                </Text>
              ) : null}
              <ModelOptionLine
                option={option}
                selected={actualIndex === props.selectedIndex}
              />
            </Box>
          );
        })
      )}
    </Box>
  );
}

function ModelOptionLine(props: {
  option: ModelPickerOption;
  selected: boolean;
}) {
  const statusColor = props.option.current
    ? terminalUiTheme.colors.info
    : props.option.available
      ? terminalUiTheme.colors.subtle
      : terminalUiTheme.colors.warning;
  const labelSuffix =
    props.option.label && props.option.label !== props.option.modelId
      ? ` ${props.option.label}`
      : "";

  return (
    <Text
      color={props.selected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
      backgroundColor={props.selected ? terminalUiTheme.colors.selection : undefined}
      wrap="truncate-end"
    >
      {props.selected ? ">" : " "}
      {" "}
      {props.option.modelId}
      {labelSuffix}
      {" "}
      <Text color={statusColor}>
        {props.option.status}
      </Text>
      {props.selected ? <Text inverse>{" "}</Text> : null}
    </Text>
  );
}

function getVisibleModelWindow(options: ModelPickerOption[], selectedIndex: number) {
  const visibleCount = Math.min(VISIBLE_MODEL_COUNT, options.length);
  if (visibleCount === 0) {
    return {
      startIndex: 0,
      options: []
    };
  }

  const safeSelectedIndex = Math.min(Math.max(0, selectedIndex), options.length - 1);
  const startIndex = Math.min(
    Math.max(0, safeSelectedIndex - visibleCount + 1),
    options.length - visibleCount
  );

  return {
    startIndex,
    options: options.slice(startIndex, startIndex + visibleCount)
  };
}

function getProviderModelIds(provider: ProviderProfile, currentModelId?: string): string[] {
  const models = Object.keys(provider.models ?? {});
  const ordered = [
    currentModelId,
    provider.defaultModel,
    ...models
  ];
  return [...new Set(ordered.filter((modelId): modelId is string =>
    typeof modelId === "string" && modelId.trim().length > 0
  ))];
}

function getModelAvailability(
  ref: ModelRef,
  options: {
    connectionState: ConnectionConfigState;
    settings: Pick<SessionSettings, "modelContextWindowOverrides">;
    env?: NodeJS.ProcessEnv;
  }
) {
  try {
    const resolved = resolveModelProfile(ref, {
      providers: options.connectionState.providerProfiles,
      modelContextWindowOverrides: options.settings.modelContextWindowOverrides,
      env: options.env
    });
    const availability = getModelAdapterAvailability(resolved);
    return {
      available: availability.available,
      status: availability.available
        ? "ready"
        : formatUnavailableStatus(resolved.provider, availability.reason)
    };
  } catch (error) {
    return {
      available: false,
      status: error instanceof Error ? error.message : String(error)
    };
  }
}

function formatUnavailableStatus(provider: ProviderProfile, reason?: string) {
  if (provider.kind === "local" && !provider.baseURL) {
    return "needs baseURL";
  }

  if (reason?.includes("missing an API key")) {
    return provider.apiKeyEnv ? `needs ${provider.apiKeyEnv}` : "needs key";
  }

  return reason ?? "unavailable";
}

function parseModelRefSafely(model: string) {
  try {
    return parseModelRef(model);
  } catch {
    return undefined;
  }
}
