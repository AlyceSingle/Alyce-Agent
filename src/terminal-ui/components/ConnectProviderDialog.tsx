import { useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionConfigState } from "../../config/runtime.js";
import {
  BUILT_IN_PROVIDER_PROFILES,
  CONNECTABLE_PROVIDER_PRESET_IDS,
  DEFAULT_OLLAMA_BASE_URL,
  getBuiltInProviderProfile,
  isConnectableProviderPreset
} from "../../core/providers/defaults.js";
import { getBuiltInProviderConnectors } from "../../core/providers/connectors/index.js";
import type {
  AuthPrompt,
  AuthPromptCondition,
  ProviderConnector
} from "../../core/providers/providerAuth.js";
import type { ProviderProfile } from "../../core/providers/types.js";
import { Box, Text, useInput, useTerminalSize } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";
import { Pane } from "./Pane.js";

type ConnectProviderMode = "form" | "info" | "auth";
type ConnectFieldType = "text" | "select";

export type ConnectProviderAuthResult =
  | { ok: true; type: "stored" }
  | { ok: true; type: "flow"; method: "auto" | "code"; url: string; instructions: string }
  | { ok: false; message: string };

export type ConnectProviderOption = {
  id: string;
  provider: string;
  group: "Popular" | "Local" | "Providers" | "Experimental";
  label: string;
  description: string;
  mode: ConnectProviderMode;
  authMethodIndex?: number;
  authMethodLabel?: string;
  fields?: ConnectField[];
  status: string;
  infoLines?: string[];
};

export type ConnectField = {
  key: string;
  label: string;
  placeholder: string;
  type?: ConnectFieldType;
  options?: Array<{ label: string; value: string; hint?: string }>;
  secret?: boolean;
  optional?: boolean;
  when?: AuthPromptCondition;
};

export type ConnectValues = Record<string, string>;

const GROUP_ORDER: ConnectProviderOption["group"][] = ["Popular", "Local", "Providers", "Experimental"];
const DEFAULT_LOCAL_BASE_URL = DEFAULT_OLLAMA_BASE_URL;
const POPULAR_PROVIDER_IDS = new Set(["openrouter", "openai", "anthropic", "google", "deepseek", "kimi", "qwen"]);
const LOCAL_PROVIDER_IDS = new Set(["local", "ollama", "lmstudio"]);

export function ConnectProviderDialog(props: {
  connectionState: ConnectionConfigState;
  onConnect: (provider: string, args: string[]) => Promise<{ ok: true } | { ok: false; message: string }>;
  onAuthorizeAuth?: (
    provider: string,
    methodIndex: number,
    inputs: Record<string, string>
  ) => Promise<ConnectProviderAuthResult>;
  onAuthCallback?: (
    provider: string,
    methodIndex: number,
    code?: string,
    options?: { signal?: AbortSignal }
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  onCancelAuth?: (provider: string, methodIndex: number) => void;
  onCancel: () => void;
}) {
  const terminalSize = useTerminalSize();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [step, setStep] = useState<"select" | "form" | "info" | "auth-flow">("select");
  const [activeOption, setActiveOption] = useState<ConnectProviderOption | null>(null);
  const [values, setValues] = useState<ConnectValues>({});
  const [fieldIndex, setFieldIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [authFlow, setAuthFlow] = useState<{
    provider: string;
    methodIndex: number;
    method: "auto" | "code";
    url: string;
    instructions: string;
  } | null>(null);
  const [authCode, setAuthCode] = useState("");
  const authFlowStartedRef = useRef(false);
  const authCallbackAbortRef = useRef<AbortController | null>(null);
  const onAuthCallbackRef = useRef(props.onAuthCallback);

  useEffect(() => {
    onAuthCallbackRef.current = props.onAuthCallback;
  }, [props.onAuthCallback]);

  const options = useMemo(
    () => createConnectProviderOptions(props.connectionState),
    [props.connectionState]
  );
  const visibleOptions = useMemo(
    () => filterConnectProviderOptions(options, query),
    [options, query]
  );
  const fields = useMemo(
    () => activeOption?.mode === "form" || activeOption?.mode === "auth"
      ? getConnectFields(activeOption, values)
      : [],
    [activeOption, values]
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(Math.max(0, current), Math.max(0, visibleOptions.length - 1)));
  }, [visibleOptions.length]);

  useEffect(() => () => {
    authCallbackAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    setFieldIndex((current) => Math.min(Math.max(0, current), Math.max(0, fields.length - 1)));
  }, [fields.length]);

  useEffect(() => {
    if (
      step !== "auth-flow" ||
      !authFlow ||
      authFlow.method !== "auto" ||
      authFlowStartedRef.current ||
      !onAuthCallbackRef.current
    ) {
      return;
    }

    let cancelled = false;
    const abortController = new AbortController();
    authCallbackAbortRef.current = abortController;
    authFlowStartedRef.current = true;
    setSubmitting(true);
    onAuthCallbackRef.current(authFlow.provider, authFlow.methodIndex, undefined, {
      signal: abortController.signal
    })
      .then((result) => {
        if (cancelled || abortController.signal.aborted) {
          return;
        }

        if (!result.ok) {
          setSubmitting(false);
          setError(result.message);
        }
      })
      .catch((callbackError: unknown) => {
        if (cancelled || abortController.signal.aborted) {
          return;
        }

        setSubmitting(false);
        setError(callbackError instanceof Error ? callbackError.message : String(callbackError));
      })
      .finally(() => {
        if (authCallbackAbortRef.current === abortController) {
          authCallbackAbortRef.current = null;
        }
      });

    return () => {
      cancelled = true;
      if (authCallbackAbortRef.current === abortController) {
        authCallbackAbortRef.current = null;
      }
    };
  }, [authFlow, step]);

  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "c") {
      if (step === "auth-flow" && authFlow) {
        cancelActiveAuthFlow(authFlow);
      }
      props.onCancel();
      return;
    }

    if (submitting && !(step === "auth-flow" && key.escape)) {
      return;
    }

    if (step === "select") {
      handleSelectInput(input, key);
      return;
    }

    if (step === "info") {
      if (key.escape) {
        setStep("select");
        setActiveOption(null);
        setError(null);
        return;
      }

      if (key.return || input.toLowerCase() === "b") {
        setStep("select");
        setActiveOption(null);
        setError(null);
      }
      return;
    }

    if (step === "auth-flow") {
      handleAuthFlowInput(input, key);
      return;
    }

    handleFormInput(input, key);
  }, { isActive: true });

  const handleSelectInput = (
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1]
  ) => {
    if (key.escape) {
      props.onCancel();
      return;
    }

    if (key.upArrow) {
      if (visibleOptions.length === 0) {
        return;
      }
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      if (visibleOptions.length === 0) {
        return;
      }
      setSelectedIndex((current) => Math.min(visibleOptions.length - 1, current + 1));
      return;
    }

    if (key.return) {
      const selected = visibleOptions[selectedIndex];
      if (!selected) {
        return;
      }

      setActiveOption(selected);
      setAuthFlow(null);
      setAuthCode("");
      authFlowStartedRef.current = false;
      setError(null);
      if (selected.mode === "info") {
        setStep("info");
        return;
      }

      setValues(createInitialConnectValuesForOption(selected, props.connectionState));
      setFieldIndex(0);
      setStep("form");
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      return;
    }

    if (key.ctrl && input.toLowerCase() === "u") {
      setQuery("");
      return;
    }

    if (key.ctrl || key.meta || !input) {
      return;
    }

    setQuery((current) => current + input);
  };

  const handleFormInput = (
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1]
  ) => {
    const currentField = fields[fieldIndex];
    if (!activeOption) {
      return;
    }

    if (key.escape) {
      setStep("select");
      setActiveOption(null);
      setValues({});
      setFieldIndex(0);
      setError(null);
      return;
    }

    if (!currentField) {
      if (key.return) {
        void submitForm(activeOption, values);
      }
      return;
    }

    if (key.upArrow) {
      setFieldIndex((current) => Math.max(0, current - 1));
      setError(null);
      return;
    }

    if (key.downArrow || key.tab) {
      setFieldIndex((current) => Math.min(fields.length - 1, current + 1));
      setError(null);
      return;
    }

    if (key.return) {
      if (fieldIndex < fields.length - 1) {
        setFieldIndex((current) => current + 1);
        setError(null);
        return;
      }

      void submitForm(activeOption, values);
      return;
    }

    if (currentField.type === "select") {
      if (key.leftArrow) {
        updateSelectField(currentField, -1);
        return;
      }

      if (key.rightArrow || input === " ") {
        updateSelectField(currentField, 1);
        return;
      }

      const numericIndex = Number.parseInt(input, 10);
      if (Number.isInteger(numericIndex) && currentField.options?.[numericIndex - 1]) {
        setValues((current) => ({
          ...current,
          [currentField.key]: currentField.options![numericIndex - 1]!.value
        }));
        setError(null);
      }
      return;
    }

    if (key.backspace || key.delete) {
      setValues((current) => ({
        ...current,
        [currentField.key]: (current[currentField.key] ?? "").slice(0, -1)
      }));
      setError(null);
      return;
    }

    if (key.ctrl && input.toLowerCase() === "u") {
      setValues((current) => ({
        ...current,
        [currentField.key]: ""
      }));
      setError(null);
      return;
    }

    if (key.ctrl || key.meta || !input) {
      return;
    }

    setValues((current) => ({
      ...current,
      [currentField.key]: (current[currentField.key] ?? "") + input
    }));
    setError(null);
  };

  const updateSelectField = (field: ConnectField, direction: -1 | 1) => {
    const options = field.options ?? [];
    if (options.length === 0) {
      return;
    }

    const currentValue = values[field.key] ?? options[0]!.value;
    const currentIndex = Math.max(0, options.findIndex((option) => option.value === currentValue));
    const nextIndex = (currentIndex + direction + options.length) % options.length;
    setValues((current) => ({
      ...current,
      [field.key]: options[nextIndex]!.value
    }));
    setError(null);
  };

  const handleAuthFlowInput = (
    input: string,
    key: Parameters<Parameters<typeof useInput>[0]>[1]
  ) => {
    if (!authFlow) {
      return;
    }

    if (key.escape) {
      cancelActiveAuthFlow(authFlow);
      setStep("select");
      setActiveOption(null);
      setAuthFlow(null);
      setAuthCode("");
      authFlowStartedRef.current = false;
      setSubmitting(false);
      setError(null);
      return;
    }

    if (authFlow.method !== "code") {
      return;
    }

    if (key.return) {
      const code = authCode.trim();
      if (!code) {
        setError("Authorization code is required.");
        return;
      }

      if (!props.onAuthCallback) {
        setError("This provider does not support interactive auth yet.");
        return;
      }

      setSubmitting(true);
      const abortController = new AbortController();
      authCallbackAbortRef.current = abortController;
      props.onAuthCallback(authFlow.provider, authFlow.methodIndex, code, {
        signal: abortController.signal
      })
        .then((result) => {
          if (abortController.signal.aborted) {
            return;
          }

          if (!result.ok) {
            setSubmitting(false);
            setError(result.message);
          }
        })
        .catch((callbackError: unknown) => {
          if (abortController.signal.aborted) {
            return;
          }

          setSubmitting(false);
          setError(callbackError instanceof Error ? callbackError.message : String(callbackError));
        })
        .finally(() => {
          if (authCallbackAbortRef.current === abortController) {
            authCallbackAbortRef.current = null;
          }
        });
      return;
    }

    if (key.backspace || key.delete) {
      setAuthCode((current) => current.slice(0, -1));
      setError(null);
      return;
    }

    if (key.ctrl && input.toLowerCase() === "u") {
      setAuthCode("");
      setError(null);
      return;
    }

    if (key.ctrl || key.meta || !input) {
      return;
    }

    setAuthCode((current) => current + input);
    setError(null);
  };

  const cancelActiveAuthFlow = (
    flow: { provider: string; methodIndex: number } | null
  ) => {
    authCallbackAbortRef.current?.abort();
    authCallbackAbortRef.current = null;
    if (flow) {
      props.onCancelAuth?.(flow.provider, flow.methodIndex);
    }
  };

  const submitForm = async (option: ConnectProviderOption, currentValues: ConnectValues) => {
    const validationError = validateConnectOption(option, currentValues);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    if (option.mode === "auth") {
      if (!props.onAuthorizeAuth || !props.onAuthCallback) {
        setSubmitting(false);
        setError("This provider does not support interactive auth yet.");
        return;
      }

      const methodIndex = option.authMethodIndex ?? 0;
      const result = await props.onAuthorizeAuth(option.provider, methodIndex, currentValues)
        .catch((authorizeError: unknown) => ({
          ok: false as const,
          message: authorizeError instanceof Error ? authorizeError.message : String(authorizeError)
        }));
      if (!result.ok) {
        setSubmitting(false);
        setError(result.message);
        return;
      }

      if (result.type === "flow") {
        setAuthFlow({
          provider: option.provider,
          methodIndex,
          method: result.method,
          url: result.url,
          instructions: result.instructions
        });
        setAuthCode("");
        authFlowStartedRef.current = false;
        setSubmitting(false);
        setError(null);
        setStep("auth-flow");
        return;
      }
      setSubmitting(false);
      return;
    }

    const result = await props.onConnect(option.provider, buildConnectProviderArgs(option.provider, currentValues))
      .catch((connectError: unknown) => ({
        ok: false as const,
        message: connectError instanceof Error ? connectError.message : String(connectError)
      }));
    if (!result.ok) {
      setSubmitting(false);
      setError(result.message);
    }
  };

  const panelWidth = Math.max(1, Math.min(82, (terminalSize.columns || 90) - 4));
  const footer = step === "select"
    ? "Type to search | Up/Down choose | Enter select | Esc cancel"
    : step === "info"
      ? "Enter back | b back | Esc back"
      : step === "auth-flow"
        ? "Open URL | Enter code if asked | Esc back"
        : "Type value | Up/Down field | Left/Right option | Enter next/save | Esc back";

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
          title="Connect a provider"
          subtitle="esc"
          accentColor={terminalUiTheme.colors.chrome}
          footer={footer}
        >
          {step === "select" ? (
            <ProviderListView
              query={query}
              options={visibleOptions}
              selectedIndex={selectedIndex}
            />
          ) : step === "info" && activeOption ? (
            <ProviderInfoView option={activeOption} />
          ) : step === "auth-flow" && activeOption && authFlow ? (
            <ProviderAuthFlowView
              option={activeOption}
              flow={authFlow}
              authCode={authCode}
              error={error}
              submitting={submitting}
            />
          ) : activeOption ? (
            <ProviderFormView
              option={activeOption}
              fields={fields}
              values={values}
              selectedIndex={fieldIndex}
              error={error}
              submitting={submitting}
            />
          ) : null}
        </Pane>
      </Box>
    </Box>
  );
}

export function createConnectProviderOptions(
  connectionState: ConnectionConfigState,
  connectors: ProviderConnector[] = getBuiltInProviderConnectors()
): ConnectProviderOption[] {
  return orderConnectProviderOptions([
    ...CONNECTABLE_PROVIDER_PRESET_IDS.map((providerId) =>
      createPresetProviderOption(providerId, connectionState)
    ),
    {
      id: "custom",
      provider: "custom",
      group: "Providers",
      label: "Custom OpenAI-compatible",
      description: "Add your own baseURL, model, and API key.",
      mode: "form",
      status: "new"
    },
    ...connectors.map((connector) => createExperimentalConnectorOption(connector, connectionState))
  ]);
}

function createPresetProviderOption(
  providerId: string,
  connectionState: ConnectionConfigState
): ConnectProviderOption {
  const provider = connectionState.providerProfiles[providerId] ??
    BUILT_IN_PROVIDER_PROFILES[providerId]!;
  return {
    id: providerId,
    provider: providerId,
    group: getPresetOptionGroup(providerId),
    label: providerId === "openai" ? "OpenAI" : provider.label,
    description: getPresetDescription(provider),
    mode: "form",
    status: getProviderStatus(providerId, connectionState)
  };
}

function getPresetOptionGroup(providerId: string): ConnectProviderOption["group"] {
  if (LOCAL_PROVIDER_IDS.has(providerId)) {
    return "Local";
  }

  return POPULAR_PROVIDER_IDS.has(providerId) ? "Popular" : "Providers";
}

function getPresetDescription(provider: ProviderProfile): string {
  if (provider.kind === "local") {
    return `${provider.label} OpenAI-compatible local endpoint.`;
  }

  if (provider.kind === "openrouter") {
    return "OpenAI-compatible model gateway.";
  }

  if (provider.kind === "openai") {
    return "Use an OpenAI API key.";
  }

  return `${provider.label} OpenAI-compatible API.`;
}

function getApiKeyPlaceholder(providerId: string): string {
  switch (providerId) {
    case "openrouter":
      return "sk-or-...";
    case "openai":
      return "sk-...";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "google":
      return "GOOGLE_API_KEY";
    case "doubao":
      return "ARK_API_KEY";
    case "qwen":
      return "DASHSCOPE_API_KEY";
    case "kimi":
      return "MOONSHOT_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "siliconflow":
      return "SILICONFLOW_API_KEY";
    default:
      return "sk-...";
  }
}

function createExperimentalConnectorOption(
  connector: ProviderConnector,
  connectionState: ConnectionConfigState
): ConnectProviderOption {
  const authMethod = connector.auth?.methods[0];
  if (authMethod && connectionState.providerProfiles[connector.id]) {
    return {
      id: connector.id,
      provider: connector.id,
      group: "Experimental",
      label: connector.label,
      description: getConnectorDescription(connector),
      mode: "auth",
      authMethodIndex: 0,
      authMethodLabel: authMethod.label,
      fields: createAuthPromptFields(authMethod.prompts),
      status: getConnectorStatus(connector.id, connectionState)
    };
  }

  return {
    id: connector.id,
    provider: connector.id,
    group: "Experimental",
    label: connector.label,
    description: getConnectorDescription(connector),
    mode: "info",
    status: connector.experimental ? "experimental" : "available",
    infoLines: [
      `${connector.label} is loaded.`,
      "No server, domain, or certificate is needed.",
      "Credentials stay in the local AuthStore."
    ]
  };
}

function getConnectorDescription(connector: ProviderConnector): string {
  if (connector.id === "github-copilot") {
    return "Login with your GitHub account.";
  }

  return connector.experimental ? "Experimental account login." : "Account login.";
}

function getConnectorStatus(providerId: string, connectionState: ConnectionConfigState): string {
  return getProviderStatus(providerId, connectionState) === "connected" ? "connected" : "needs login";
}

function createAuthPromptFields(prompts: AuthPrompt[] | undefined): ConnectField[] {
  return (prompts ?? []).map((prompt) => ({
    key: prompt.key,
    label: prompt.message,
    placeholder: prompt.type === "select"
      ? prompt.options[0]?.label ?? ""
      : prompt.placeholder ?? "",
    type: prompt.type,
    ...(prompt.type === "select" ? { options: prompt.options } : {}),
    ...(prompt.type === "text" && prompt.secret ? { secret: prompt.secret } : {}),
    ...(prompt.when ? { when: prompt.when } : {})
  }));
}

export function filterConnectProviderOptions(
  options: ConnectProviderOption[],
  query: string
): ConnectProviderOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return orderConnectProviderOptions(options);
  }

  return orderConnectProviderOptions(options.filter((option) =>
    [
      option.label,
      option.provider,
      option.group,
      option.description,
      option.status
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  ));
}

function orderConnectProviderOptions(options: ConnectProviderOption[]): ConnectProviderOption[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort((left, right) => {
      const groupOrder = GROUP_ORDER.indexOf(left.option.group) - GROUP_ORDER.indexOf(right.option.group);
      return groupOrder || left.index - right.index;
    })
    .map(({ option }) => option);
}

export function getConnectFields(
  providerOrOption: string | ConnectProviderOption,
  values: ConnectValues = {}
): ConnectField[] {
  if (typeof providerOrOption !== "string") {
    const fields = providerOrOption.fields ?? getConnectFields(providerOrOption.provider, values);
    return fields.filter((field) => shouldShowField(field, values));
  }

  const provider = providerOrOption;
  const preset = getBuiltInProviderProfile(provider);
  if (preset && isConnectableProviderPreset(provider)) {
    if (preset.kind === "local") {
      return [
        { key: "baseURL", label: "Base URL", placeholder: preset.baseURL ?? DEFAULT_LOCAL_BASE_URL },
        { key: "model", label: "Model", placeholder: preset.defaultModel ?? "local-model" }
      ];
    }

    return [
      { key: "apiKey", label: "API key", placeholder: getApiKeyPlaceholder(provider), secret: true },
      { key: "baseURL", label: "Base URL", placeholder: preset.baseURL ?? "https://api.example.com/v1", optional: true },
      { key: "model", label: "Default model", placeholder: preset.defaultModel ?? "model" }
    ];
  }

  switch (provider) {
    case "custom":
      return [
        { key: "providerId", label: "Provider id", placeholder: "siliconflow" },
        { key: "label", label: "Label", placeholder: "SiliconFlow", optional: true },
        { key: "baseURL", label: "Base URL", placeholder: "https://api.example.com/v1" },
        { key: "model", label: "Model", placeholder: "deepseek-ai/DeepSeek-V3" },
        { key: "apiKey", label: "API key", placeholder: "sk-...", secret: true }
      ];
    default:
      return [];
  }
}

function shouldShowField(field: ConnectField, values: ConnectValues): boolean {
  if (!field.when) {
    return true;
  }

  const currentValue = values[field.when.key] ?? "";
  return field.when.op === "eq"
    ? currentValue === field.when.value
    : currentValue !== field.when.value;
}

export function createInitialConnectValues(
  provider: string,
  connectionState: ConnectionConfigState
): ConnectValues {
  const profile = connectionState.providerProfiles[provider];
  const preset = getBuiltInProviderProfile(provider);
  if (preset && isConnectableProviderPreset(provider)) {
    if (preset.kind === "local") {
      return {
        baseURL: profile?.baseURL ?? preset.baseURL ?? DEFAULT_LOCAL_BASE_URL,
        model: profile?.defaultModel ?? preset.defaultModel ?? "local-model"
      };
    }

    return {
      apiKey: "",
      baseURL: profile?.baseURL ?? preset.baseURL ?? "",
      model: profile?.defaultModel ?? preset.defaultModel ?? "model"
    };
  }

  switch (provider) {
    case "custom":
      return {
        providerId: "",
        label: "",
        baseURL: "",
        model: "",
        apiKey: ""
      };
    default:
      return {};
  }
}

function createInitialConnectValuesForOption(
  option: ConnectProviderOption,
  connectionState: ConnectionConfigState
): ConnectValues {
  if (option.mode !== "auth") {
    return createInitialConnectValues(option.provider, connectionState);
  }

  const initial: ConnectValues = {};
  for (const field of option.fields ?? []) {
    if (field.type === "select") {
      initial[field.key] = field.options?.[0]?.value ?? "";
    } else {
      initial[field.key] = "";
    }
  }

  return initial;
}

export function validateConnectValues(provider: string, values: ConnectValues): string | null {
  for (const field of getConnectFields(provider)) {
    if (field.optional) {
      continue;
    }

    if (!values[field.key]?.trim()) {
      return `${field.label} is required.`;
    }
  }

  if (isConnectableProviderPreset(provider) || provider === "custom") {
    const baseURL = values.baseURL?.trim();
    if (baseURL) {
      try {
        new URL(baseURL);
      } catch {
        return `Invalid base URL: ${baseURL}`;
      }
    }
  }

  if (provider === "custom") {
    const providerId = values.providerId?.trim();
    if (providerId && !/^[a-z0-9][a-z0-9._-]*$/i.test(providerId)) {
      return "Provider id can use letters, numbers, dot, underscore, or dash.";
    }
  }

  return null;
}

function validateConnectOption(option: ConnectProviderOption, values: ConnectValues): string | null {
  if (option.mode !== "auth") {
    return validateConnectValues(option.provider, values);
  }

  for (const field of getConnectFields(option, values)) {
    if (field.optional) {
      continue;
    }

    if (!values[field.key]?.trim()) {
      return `${field.label} is required.`;
    }
  }

  if (option.provider === "github-copilot" && values.deploymentType === "enterprise") {
    const enterpriseUrl = values.enterpriseUrl?.trim();
    if (!enterpriseUrl) {
      return "GitHub Enterprise URL or domain is required.";
    }

    try {
      new URL(enterpriseUrl.includes("://") ? enterpriseUrl : `https://${enterpriseUrl}`);
    } catch {
      return "Enter a valid GitHub Enterprise URL or domain.";
    }
  }

  return null;
}

export function buildConnectProviderArgs(provider: string, values: ConnectValues): string[] {
  const preset = getBuiltInProviderProfile(provider);
  if (preset && isConnectableProviderPreset(provider)) {
    if (preset.kind === "local") {
      return [
        values.baseURL?.trim() ?? "",
        values.model?.trim() ?? ""
      ].filter(Boolean);
    }

    return [
      values.apiKey?.trim() ?? "",
      values.model?.trim() ?? "",
      values.baseURL?.trim() ?? ""
    ].filter(Boolean);
  }

  switch (provider) {
    case "custom": {
      const args = [
        values.providerId?.trim() ?? "",
        values.baseURL?.trim() ?? "",
        values.model?.trim() ?? "",
        values.apiKey?.trim() ?? ""
      ];
      const label = values.label?.trim();
      if (label) {
        args.push(label);
      }

      return args;
    }
    default:
      return [];
  }
}

export function maskConnectSecret(value: string): string {
  if (!value) {
    return "";
  }

  return "*".repeat(Math.min(12, Math.max(4, value.length)));
}

function ProviderListView(props: {
  query: string;
  options: ConnectProviderOption[];
  selectedIndex: number;
}) {
  let renderedIndex = 0;
  return (
    <Box flexDirection="column" width="100%">
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        Search {props.query}
        <Text inverse>{" "}</Text>
      </Text>
      {props.options.length === 0 ? (
        <Text color={terminalUiTheme.colors.warning}>No providers match this search.</Text>
      ) : (
        GROUP_ORDER.map((group) => {
          const groupOptions = props.options.filter((option) => option.group === group);
          if (groupOptions.length === 0) {
            return null;
          }

          return (
            <Box key={group} flexDirection="column" width="100%">
              <Text color={terminalUiTheme.colors.system}>{group}</Text>
              {groupOptions.map((option) => {
                const optionIndex = renderedIndex;
                renderedIndex += 1;
                return (
                  <ProviderOptionLine
                    key={option.id}
                    option={option}
                    selected={optionIndex === props.selectedIndex}
                  />
                );
              })}
            </Box>
          );
        })
      )}
    </Box>
  );
}

function ProviderOptionLine(props: {
  option: ConnectProviderOption;
  selected: boolean;
}) {
  return (
    <Text
      color={props.selected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
      backgroundColor={props.selected ? terminalUiTheme.colors.selection : undefined}
      wrap="truncate-end"
    >
      {props.selected ? ">" : " "}
      {" "}
      {props.option.label}
    </Text>
  );
}

function ProviderInfoView(props: {
  option: ConnectProviderOption;
}) {
  return (
    <Box flexDirection="column" width="100%">
      <Text color={terminalUiTheme.colors.chrome}>{props.option.label}</Text>
      <Text color={terminalUiTheme.colors.subtle}>{props.option.description}</Text>
      {(props.option.infoLines ?? []).map((line) => (
        <Text key={line} color={terminalUiTheme.colors.muted} wrap="wrap">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function ProviderAuthFlowView(props: {
  option: ConnectProviderOption;
  flow: {
    method: "auto" | "code";
    url: string;
    instructions: string;
  };
  authCode: string;
  error: string | null;
  submitting: boolean;
}) {
  return (
    <Box flexDirection="column" width="100%">
      <Text color={terminalUiTheme.colors.chrome} wrap="truncate-end">
        {props.option.authMethodLabel ?? props.option.label}
      </Text>
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        {props.flow.url}
      </Text>
      <Text color={terminalUiTheme.colors.muted} wrap="truncate-end">
        {props.flow.instructions}
      </Text>
      {props.flow.method === "code" ? (
        <Text
          color={terminalUiTheme.colors.chrome}
          backgroundColor={terminalUiTheme.colors.selection}
          wrap="truncate-end"
        >
          &gt; Code: {props.authCode || "authorization code"}
          <Text inverse>{" "}</Text>
        </Text>
      ) : (
        <Text color={terminalUiTheme.colors.info} wrap="truncate-end">
          {props.submitting ? "Waiting for authorization..." : "Open the URL and enter the code."}
        </Text>
      )}
      {props.error ? (
        <Text color={terminalUiTheme.colors.danger} wrap="wrap">
          {props.error}
        </Text>
      ) : null}
    </Box>
  );
}

function ProviderFormView(props: {
  option: ConnectProviderOption;
  fields: ConnectField[];
  values: ConnectValues;
  selectedIndex: number;
  error: string | null;
  submitting: boolean;
}) {
  return (
    <Box flexDirection="column" width="100%">
      <Text color={terminalUiTheme.colors.muted} wrap="wrap">
        {props.option.mode === "auth"
          ? props.option.authMethodLabel ?? props.option.label
          : props.option.status === "connected"
          ? `${props.option.label} connected. Saving replaces the credential.`
          : props.option.label}
      </Text>
      {props.fields.map((field, index) => (
        <FieldLine
          key={field.key}
          field={field}
          value={props.values[field.key] ?? ""}
          selected={index === props.selectedIndex}
        />
      ))}
      {props.fields.length === 0 ? (
        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          Press Enter to continue.
        </Text>
      ) : null}
      {props.error ? (
        <Text color={terminalUiTheme.colors.danger} wrap="wrap">
          {props.error}
        </Text>
      ) : null}
      {props.submitting ? (
        <Text color={terminalUiTheme.colors.info}>
          {props.option.mode === "auth" ? "Starting login..." : "Saving provider..."}
        </Text>
      ) : (
        <Box flexDirection="column" width="100%">
          <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
            Secrets: ~/.alyce/auth.json
          </Text>
          <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
            Project config never stores real keys.
          </Text>
        </Box>
      )}
    </Box>
  );
}

function FieldLine(props: {
  field: ConnectField;
  value: string;
  selected: boolean;
}) {
  const selectedOption = props.field.type === "select"
    ? props.field.options?.find((option) => option.value === props.value) ?? props.field.options?.[0]
    : undefined;
  const rawDisplayValue = selectedOption?.label ?? props.value;
  const displayValue = props.field.secret ? maskConnectSecret(rawDisplayValue) : rawDisplayValue;
  const value = displayValue || props.field.placeholder;
  const color = displayValue ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.subtle;
  return (
    <Text
      color={props.selected ? terminalUiTheme.colors.chrome : terminalUiTheme.colors.muted}
      backgroundColor={props.selected ? terminalUiTheme.colors.selection : undefined}
      wrap="truncate-end"
    >
      {props.selected ? ">" : " "}
      {" "}
      {props.field.label}
      {props.field.optional ? " (optional)" : ""}
      {": "}
      <Text color={color}>
        {value}
      </Text>
      {props.field.type === "select" && props.selected ? (
        <Text color={terminalUiTheme.colors.subtle}> {"< >"}</Text>
      ) : null}
      {props.selected ? <Text inverse>{" "}</Text> : null}
    </Text>
  );
}

function getProviderStatus(providerId: string, connectionState: ConnectionConfigState): string {
  const provider = connectionState.providerProfiles[providerId];
  if (!provider) {
    return "new";
  }

  if (provider.kind === "local") {
    return provider.baseURL ? "connected" : "needs endpoint";
  }

  if (provider.apiKey?.trim()) {
    return "connected";
  }

  if (provider.apiKeyEnv) {
    return `needs ${provider.apiKeyEnv}`;
  }

  return "needs key";
}
