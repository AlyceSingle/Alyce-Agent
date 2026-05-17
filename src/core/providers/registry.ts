import { BUILT_IN_PROVIDER_PROFILES, DEFAULT_PROVIDER_ID } from "./defaults.js";
import { parseModelRef } from "./resolveModel.js";
import type {
  ModelProfile,
  ProviderKind,
  ProviderProfile,
  ProviderProfileMap,
  ProviderRegistry
} from "./types.js";

export type ProviderProfileInput = Partial<Omit<ProviderProfile, "models">> & {
  models?: Record<string, ModelProfile>;
};

export type ProviderProfileInputMap = Record<string, ProviderProfileInput>;

const PROVIDER_KINDS = new Set<ProviderKind>([
  "openai-compatible",
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "local"
]);

export function buildProviderRegistry(options: {
  connection: {
    apiKey: string;
    baseURL?: string;
    model: string;
  };
  configuredProviders?: ProviderProfileInputMap;
  defaultProviderId?: string;
}): ProviderRegistry {
  const defaultProviderId = normalizeId(options.defaultProviderId) ?? DEFAULT_PROVIDER_ID;
  const parsedCurrentModel = parseModelRefOrDefault(options.connection.model, defaultProviderId);
  const currentModelRef = parsedCurrentModel.ref;
  const providers = cloneProviderMap(BUILT_IN_PROVIDER_PROFILES);

  const openaiBase = providers[DEFAULT_PROVIDER_ID];
  providers[DEFAULT_PROVIDER_ID] = mergeProviderProfileInput(
    openaiBase,
    DEFAULT_PROVIDER_ID,
    buildLegacyOpenAIProfile(
      options.connection,
      parsedCurrentModel.valid && currentModelRef.providerId === DEFAULT_PROVIDER_ID
        ? currentModelRef.modelId
        : undefined
    )
  );
  mergeProviderProfileInputsInto(
    providers,
    normalizeProviderProfileInputMap(options.configuredProviders)
  );

  if (parsedCurrentModel.valid && !providers[currentModelRef.providerId]) {
    providers[currentModelRef.providerId] = mergeProviderProfileInput(
      undefined,
      currentModelRef.providerId,
      {
        label: currentModelRef.providerId,
        kind: "openai-compatible",
        ...(options.connection.apiKey ? { apiKey: options.connection.apiKey } : {}),
        ...(options.connection.baseURL ? { baseURL: options.connection.baseURL } : {}),
        defaultModel: currentModelRef.modelId,
        models: {
          [currentModelRef.modelId]: {}
        }
      }
    );
  } else if (parsedCurrentModel.valid) {
    providers[currentModelRef.providerId] = mergeProviderProfileInput(
      providers[currentModelRef.providerId],
      currentModelRef.providerId,
      {
        models: {
          [currentModelRef.modelId]: {}
        }
      }
    );
  }

  return {
    defaultProviderId,
    currentModelRef,
    providers
  };
}

export function normalizeProviderProfileInputMap(
  input: ProviderProfileInputMap | ProviderProfileMap | undefined
): ProviderProfileInputMap {
  if (!input) {
    return {};
  }

  const normalized: ProviderProfileInputMap = {};
  for (const [key, value] of Object.entries(input)) {
    const id = normalizeId(value.id) ?? normalizeId(key);
    if (!id) {
      continue;
    }

    const profile: ProviderProfileInput = {};
    const label = value.label?.trim();
    const kind = normalizeProviderKind(value.kind);
    const apiKeyEnv = value.apiKeyEnv?.trim();
    const apiKey = value.apiKey?.trim();
    const baseURL = value.baseURL?.trim();
    const defaultModel = value.defaultModel?.trim();
    const models = value.models ? normalizeModelProfiles(value.models) : undefined;

    if (label) {
      profile.label = label;
    }
    if (kind) {
      profile.kind = kind;
    }
    if (apiKeyEnv) {
      profile.apiKeyEnv = apiKeyEnv;
    }
    if (apiKey) {
      profile.apiKey = apiKey;
    }
    if (baseURL) {
      profile.baseURL = baseURL;
    }
    if (defaultModel) {
      profile.defaultModel = defaultModel;
    }
    if (models && Object.keys(models).length > 0) {
      profile.models = models;
    }

    normalized[id] = profile;
  }

  return normalized;
}

export function normalizeProviderProfileMap(
  input: ProviderProfileInputMap | undefined
): ProviderProfileMap {
  const normalized: ProviderProfileMap = {};
  mergeProviderProfileInputsInto(normalized, normalizeProviderProfileInputMap(input));

  return normalized;
}

export function mergeProviderProfileMaps(
  ...maps: Array<ProviderProfileInputMap | ProviderProfileMap | undefined>
): ProviderProfileMap {
  const merged: ProviderProfileMap = {};
  for (const map of maps) {
    mergeProviderProfileInputsInto(merged, normalizeProviderProfileInputMap(map));
  }

  return merged;
}

function mergeProviderProfileInputsInto(
  target: ProviderProfileMap,
  source: ProviderProfileInputMap
) {
  for (const [id, profile] of Object.entries(source)) {
    target[id] = mergeProviderProfileInput(target[id], id, profile);
  }
}

function mergeProviderProfileInput(
  base: ProviderProfile | undefined,
  id: string,
  input: ProviderProfileInput
): ProviderProfile {
  const builtIn = BUILT_IN_PROVIDER_PROFILES[id];
  const models = input.models ? normalizeModelProfiles(input.models) : undefined;
  const mergedModels = mergeModelProfileMaps(base?.models, models);

  return {
    id,
    label: input.label?.trim() || base?.label || builtIn?.label || id,
    kind: normalizeProviderKind(input.kind) ?? base?.kind ?? builtIn?.kind ?? "openai-compatible",
    ...(base?.apiKeyEnv ? { apiKeyEnv: base.apiKeyEnv } : {}),
    ...(base?.apiKey ? { apiKey: base.apiKey } : {}),
    ...(base?.baseURL ? { baseURL: base.baseURL } : {}),
    ...(base?.headers ? { headers: { ...base.headers } } : {}),
    ...(base?.defaultModel ? { defaultModel: base.defaultModel } : {}),
    ...(input.apiKeyEnv?.trim() ? { apiKeyEnv: input.apiKeyEnv.trim() } : {}),
    ...(input.apiKey?.trim() ? { apiKey: input.apiKey.trim() } : {}),
    ...(input.baseURL?.trim() ? { baseURL: input.baseURL.trim() } : {}),
    ...(input.defaultModel?.trim() ? { defaultModel: input.defaultModel.trim() } : {}),
    ...(Object.keys(mergedModels).length > 0 ? { models: mergedModels } : {})
  };
}

function mergeModelProfileMaps(
  base: Record<string, ModelProfile> | undefined,
  override: Record<string, ModelProfile> | undefined
): Record<string, ModelProfile> {
  const merged: Record<string, ModelProfile> = {};
  for (const [modelId, profile] of Object.entries(base ?? {})) {
    merged[modelId] = { ...profile };
  }
  for (const [modelId, profile] of Object.entries(override ?? {})) {
    merged[modelId] = {
      ...(merged[modelId] ?? {}),
      ...profile
    };
  }

  return merged;
}

function normalizeModelProfiles(
  input: Record<string, ModelProfile>
): Record<string, ModelProfile> {
  const models: Record<string, ModelProfile> = {};
  for (const [key, value] of Object.entries(input)) {
    const modelId = key.trim();
    if (!modelId) {
      continue;
    }

    const profile: ModelProfile = {
      ...(value.label?.trim() ? { label: value.label.trim() } : {}),
      ...(positiveInteger(value.contextWindow) !== undefined
        ? { contextWindow: positiveInteger(value.contextWindow) }
        : {}),
      ...(positiveInteger(value.maxOutputTokens) !== undefined
        ? { maxOutputTokens: positiveInteger(value.maxOutputTokens) }
        : {}),
      ...(positiveNumber(value.inputCostPerMillionTokens) !== undefined
        ? { inputCostPerMillionTokens: positiveNumber(value.inputCostPerMillionTokens) }
        : {}),
      ...(positiveNumber(value.outputCostPerMillionTokens) !== undefined
        ? { outputCostPerMillionTokens: positiveNumber(value.outputCostPerMillionTokens) }
        : {})
    };
    models[modelId] = profile;
  }

  return models;
}

function buildLegacyOpenAIProfile(
  connection: { apiKey: string; baseURL?: string; model: string },
  modelId: string | undefined
): ProviderProfile {
  return {
    id: DEFAULT_PROVIDER_ID,
    label: "OpenAI",
    kind: connection.baseURL ? "openai-compatible" : "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    ...(connection.apiKey.trim() ? { apiKey: connection.apiKey.trim() } : {}),
    ...(connection.baseURL ? { baseURL: connection.baseURL } : {}),
    ...(modelId ? { defaultModel: modelId, models: { [modelId]: {} } } : {})
  };
}

function cloneProviderMap(input: ProviderProfileMap): ProviderProfileMap {
  return Object.fromEntries(
    Object.entries(input).map(([id, profile]) => [
      id,
      {
        ...profile,
        headers: profile.headers ? { ...profile.headers } : undefined,
        models: profile.models
          ? Object.fromEntries(
              Object.entries(profile.models).map(([modelId, model]) => [
                modelId,
                { ...model }
              ])
            )
          : undefined
      }
    ])
  );
}

function normalizeId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function parseModelRefOrDefault(
  value: string,
  defaultProviderId: string
): { ref: ReturnType<typeof parseModelRef>; valid: boolean } {
  try {
    return {
      ref: parseModelRef(value, defaultProviderId),
      valid: true
    };
  } catch {
    const defaultProvider = BUILT_IN_PROVIDER_PROFILES[defaultProviderId] ??
      BUILT_IN_PROVIDER_PROFILES[DEFAULT_PROVIDER_ID]!;
    return {
      ref: {
        providerId: defaultProvider.id,
        modelId: defaultProvider.defaultModel ?? Object.keys(defaultProvider.models ?? {})[0] ?? "model"
      },
      valid: false
    };
  }
}

function normalizeProviderKind(value: ProviderKind | undefined): ProviderKind | undefined {
  return value && PROVIDER_KINDS.has(value) ? value : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value!);
  return normalized > 0 ? normalized : undefined;
}

function positiveNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}
