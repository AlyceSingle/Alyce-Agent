import type { ConnectionConfigState, SessionSettings } from "../config/runtime.js";
import { getModelAdapterAvailability } from "../core/api/modelAdapters.js";
import type { ProviderAuthMap } from "../core/auth/authStore.js";
import { formatModelRef, parseModelRef, resolveModelProfile } from "../core/providers/resolveModel.js";
import type {
  ModelRef,
  ProviderProfile,
  ProviderProfileMap,
  ResolvedModelProfile
} from "../core/providers/types.js";

export type ModelSwitchResult =
  | {
      ok: true;
      persistModel: string;
      displayModel: string;
      resolvedModel: ResolvedModelProfile;
      warnings: string[];
    }
  | {
      ok: false;
      message: string;
      suggestions: string[];
    };

export function formatCurrentModelDisplay(model: string): string {
  try {
    return formatModelRef(parseModelRef(model));
  } catch {
    return model.trim() || "(none)";
  }
}

export function isConnectionStateReady(
  connectionState: ConnectionConfigState,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    const resolved = resolveModelProfile(connectionState.effective.model, {
      providers: connectionState.providerProfiles,
      env
    });
    return getModelAdapterAvailability(resolved).available;
  } catch {
    return false;
  }
}

export function resolveModelSwitch(
  input: string,
  options: {
    currentModel: string;
    providers: ProviderProfileMap;
    settings: Pick<SessionSettings, "modelContextWindowOverrides">;
    env?: NodeJS.ProcessEnv;
  }
): ModelSwitchResult {
  const raw = input.trim();
  if (!raw) {
    return {
      ok: false,
      message: "Missing model name.",
      suggestions: ["Use /model to list configured providers and models."]
    };
  }

  const currentProvider = parseModelRefSafely(options.currentModel);
  if (!raw.includes("/") && !currentProvider) {
    return {
      ok: false,
      message: "Current model is invalid, so a bare model name cannot be resolved.",
      suggestions: ["Use /model <provider/model> to switch explicitly."]
    };
  }

  const parsedInput = raw.includes("/") ? parseModelRefSafely(raw) : undefined;
  if (raw.includes("/") && !parsedInput) {
    return {
      ok: false,
      message: `Invalid model reference: ${raw}`,
      suggestions: ["Use /model <provider/model> or /model <model>."]
    };
  }

  const modelRef = parsedInput ?? {
    providerId: currentProvider!.providerId,
    modelId: raw
  };
  const provider = options.providers[modelRef.providerId];
  if (!provider) {
    return {
      ok: false,
      message: `Unknown provider: ${modelRef.providerId}`,
      suggestions: [
        buildProviderSuggestion(options.providers),
        "Use /model to list configured providers and models."
      ].filter(Boolean)
    };
  }

  const resolvedModel = resolveModelProfile(modelRef, {
    providers: options.providers,
    modelContextWindowOverrides: options.settings.modelContextWindowOverrides,
    env: options.env
  });
  const availability = getModelAdapterAvailability(resolvedModel);
  if (!availability.available) {
    return {
      ok: false,
      message: availability.reason ?? `Provider '${modelRef.providerId}' is not available.`,
      suggestions: buildModelSuggestions(provider, modelRef.providerId)
    };
  }

  const knownModels = Object.keys(provider.models ?? {});
  const warnings = knownModels.length > 0 && !knownModels.includes(modelRef.modelId)
    ? [
        [
          `Model '${modelRef.modelId}' is not listed for provider '${modelRef.providerId}'.`,
          buildKnownModelText(knownModels)
        ].filter(Boolean).join(" ")
      ]
    : [];

  return {
    ok: true,
    persistModel: raw.includes("/") || modelRef.providerId !== "openai"
      ? formatModelRef(modelRef)
      : modelRef.modelId,
    displayModel: formatModelRef(modelRef),
    resolvedModel,
    warnings
  };
}

export function formatModelStatusReport(options: {
  connectionState: ConnectionConfigState;
  settings: Pick<SessionSettings, "modelContextWindowOverrides">;
  currentModel: string;
  env?: NodeJS.ProcessEnv;
  authRecords?: ProviderAuthMap;
}): string {
  const currentDisplay = formatCurrentModelDisplay(options.currentModel);
  const lines = [
    "Current model",
    `- Model: ${currentDisplay}`
  ];

  try {
    const resolved = resolveModelProfile(options.currentModel, {
      providers: options.connectionState.providerProfiles,
      modelContextWindowOverrides: options.settings.modelContextWindowOverrides,
      env: options.env
    });
    const availability = getModelAdapterAvailability(resolved);
    lines.push(
      `- Provider: ${resolved.provider.label} (${resolved.providerId}, ${resolved.kind})`,
      `- Endpoint: ${resolved.baseURL ?? "OpenAI SDK default endpoint"}`,
      `- Auth: ${formatProviderAuthStatus(resolved.provider, options)}`,
      `- Context window: ${formatTokenCount(resolved.contextWindow)} (${resolved.contextWindowSource}: ${resolved.contextWindowLabel})`,
      `- Status: ${availability.available ? "available" : availability.reason ?? "unavailable"}`
    );
  } catch (error) {
    lines.push(`- Status: ${error instanceof Error ? error.message : String(error)}`);
  }

  lines.push("", "Providers");
  const currentProviderId = parseModelRefSafely(currentDisplay)?.providerId;
  const providers = Object.values(options.connectionState.providerProfiles)
    .sort((left, right) => providerSortKey(left, currentProviderId).localeCompare(providerSortKey(right, currentProviderId)));
  for (const provider of providers) {
    lines.push(formatProviderLine(provider, {
      currentProviderId,
      providers: options.connectionState.providerProfiles,
      settings: options.settings,
      env: options.env,
      authRecords: options.authRecords
    }));
  }

  lines.push(
    "",
    "Switch examples",
    `- /model ${currentDisplay}`,
    "- /model gpt-5.2",
    "- /model openrouter/openai/gpt-5.2"
  );

  return lines.join("\n");
}

function formatProviderLine(
  provider: ProviderProfile,
  options: {
    currentProviderId?: string;
    providers: ProviderProfileMap;
    settings: Pick<SessionSettings, "modelContextWindowOverrides">;
    env?: NodeJS.ProcessEnv;
    authRecords?: ProviderAuthMap;
  }
): string {
  const models = Object.keys(provider.models ?? {});
  const defaultModel = provider.defaultModel ?? models[0];
  const currentMarker = provider.id === options.currentProviderId
    ? " current"
    : "";
  const modelSummary = models.length > 0
    ? models.slice(0, 4).join(", ") + (models.length > 4 ? `, +${models.length - 4} more` : "")
    : "(no listed models)";
  const availability = defaultModel
    ? getModelAvailabilityLabel({
        providerId: provider.id,
        modelId: defaultModel
      }, options)
    : "no default model";

  return `- ${provider.id}${currentMarker}: ${provider.label} [${provider.kind}], default ${defaultModel ?? "(none)"}, ${formatProviderAuthStatus(provider, options)}, ${availability}, models: ${modelSummary}`;
}

function formatProviderAuthStatus(
  provider: ProviderProfile,
  options: {
    env?: NodeJS.ProcessEnv;
    authRecords?: ProviderAuthMap;
  }
): string {
  if (provider.kind === "local") {
    return "auth: not required";
  }

  if (options.authRecords?.[provider.id]?.type === "api") {
    return "auth: AuthStore";
  }

  if (provider.apiKey?.trim()) {
    return "auth: config apiKey";
  }

  if (provider.apiKeyEnv) {
    return options.env?.[provider.apiKeyEnv]?.trim()
      ? `auth: env ${provider.apiKeyEnv}`
      : `auth: missing ${provider.apiKeyEnv}`;
  }

  return "auth: missing apiKey";
}

function getModelAvailabilityLabel(
  ref: ModelRef,
  options: {
    providers: ProviderProfileMap;
    settings: Pick<SessionSettings, "modelContextWindowOverrides">;
    env?: NodeJS.ProcessEnv;
  }
) {
  try {
    const resolved = resolveModelProfile(ref, {
      providers: options.providers,
      modelContextWindowOverrides: options.settings.modelContextWindowOverrides,
      env: options.env
    });
    const availability = getModelAdapterAvailability(resolved);
    return availability.available ? "available" : `unavailable: ${availability.reason}`;
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function buildProviderSuggestion(providers: ProviderProfileMap): string {
  const ids = Object.keys(providers).sort();
  return ids.length > 0 ? `Available providers: ${ids.join(", ")}` : "";
}

function buildModelSuggestions(provider: ProviderProfile, providerId: string): string[] {
  const suggestions = buildKnownModelText(Object.keys(provider.models ?? {}));
  return [
    suggestions,
    provider.defaultModel ? `Try /model ${formatModelRef({ providerId, modelId: provider.defaultModel })}` : ""
  ].filter(Boolean);
}

function buildKnownModelText(models: string[]): string {
  return models.length > 0
    ? `Known models: ${models.slice(0, 8).join(", ")}${models.length > 8 ? ", ..." : ""}`
    : "";
}

function providerSortKey(provider: ProviderProfile, currentProviderId: string | undefined): string {
  return `${provider.id === currentProviderId ? "0" : "1"}:${provider.id}`;
}

function parseModelRefSafely(value: string): ModelRef | null {
  try {
    return parseModelRef(value);
  } catch {
    return null;
  }
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }

  return String(value);
}
