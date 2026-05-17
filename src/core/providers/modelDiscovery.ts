import type { ProviderAuthRecord } from "../auth/authStore.js";
import type { ModelProfile, ProviderProfile } from "./types.js";
import type { ProviderConnector } from "./providerAuth.js";

export type ProviderModelRefreshSource = "live" | "fallback";

export interface ProviderModelRefreshResult {
  providerId: string;
  providerLabel: string;
  models: Record<string, ModelProfile>;
  source: ProviderModelRefreshSource;
  error?: string;
}

export async function refreshProviderModels(options: {
  provider: ProviderProfile;
  auth?: ProviderAuthRecord;
  connector?: ProviderConnector;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ProviderModelRefreshResult> {
  const fallbackModels = normalizeModelMap(options.provider.models ?? {});
  try {
    const liveModels = options.connector?.models
      ? await options.connector.models({
          provider: options.provider,
          auth: options.auth,
          env: options.env,
          signal: options.signal
        })
      : await fetchProviderModelList({
          provider: options.provider,
          env: options.env,
          fetchImpl: options.fetchImpl,
          signal: options.signal
        });
    const models = mergeDiscoveredModels(fallbackModels, normalizeModelMap(liveModels));
    if (Object.keys(models).length === 0) {
      throw new Error("Provider returned an empty model list.");
    }

    return {
      providerId: options.provider.id,
      providerLabel: options.provider.label,
      models,
      source: "live"
    };
  } catch (error) {
    return {
      providerId: options.provider.id,
      providerLabel: options.provider.label,
      models: fallbackModels,
      source: "fallback",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function fetchProviderModelList(options: {
  provider: ProviderProfile;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Record<string, ModelProfile>> {
  if (options.provider.kind === "anthropic" && !options.provider.baseURL) {
    return fetchAnthropicModels(options);
  }

  if (options.provider.kind === "google" && !options.provider.baseURL) {
    return fetchGoogleModels(options);
  }

  return fetchOpenAICompatibleModels(options);
}

export async function fetchOpenAICompatibleModels(options: {
  provider: ProviderProfile;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Record<string, ModelProfile>> {
  const baseURL = options.provider.baseURL?.trim();
  if (!baseURL) {
    throw new Error(`Provider '${options.provider.id}' does not define a model list endpoint.`);
  }

  const response = await (options.fetchImpl ?? fetch)(buildModelListUrl(baseURL), {
    method: "GET",
    headers: buildAuthorizationHeaders(options.provider, options.env),
    signal: options.signal
  });
  if (!response.ok) {
    throw new Error(`Model list request failed: HTTP ${response.status}`);
  }

  return parseOpenAICompatibleModels(await response.json());
}

export async function fetchAnthropicModels(options: {
  provider: ProviderProfile;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Record<string, ModelProfile>> {
  const apiKey = getProviderApiKey(options.provider, options.env);
  if (!apiKey) {
    throw new Error("Anthropic model list requires an API key.");
  }

  const response = await (options.fetchImpl ?? fetch)("https://api.anthropic.com/v1/models", {
    method: "GET",
    headers: {
      accept: "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey
    },
    signal: options.signal
  });
  if (!response.ok) {
    throw new Error(`Anthropic model list request failed: HTTP ${response.status}`);
  }

  return parseAnthropicModels(await response.json());
}

export async function fetchGoogleModels(options: {
  provider: ProviderProfile;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Record<string, ModelProfile>> {
  const apiKey = getProviderApiKey(options.provider, options.env);
  if (!apiKey) {
    throw new Error("Google model list requires an API key.");
  }

  const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
  url.searchParams.set("key", apiKey);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: options.signal
  });
  if (!response.ok) {
    throw new Error(`Google model list request failed: HTTP ${response.status}`);
  }

  return parseGoogleModels(await response.json());
}

export function parseOpenAICompatibleModels(input: unknown): Record<string, ModelProfile> {
  const data = getObject(input).data;
  if (!Array.isArray(data)) {
    throw new Error("Model list response is missing data array.");
  }

  const models: Record<string, ModelProfile> = {};
  for (const item of data) {
    const record = getObject(item);
    const id = asNonEmptyString(record.id);
    if (!id) {
      continue;
    }

    const label = asNonEmptyString(record.name) ?? asNonEmptyString(record.display_name);
    models[id] = label ? { label } : {};
  }

  return models;
}

export function parseAnthropicModels(input: unknown): Record<string, ModelProfile> {
  const data = getObject(input).data;
  if (!Array.isArray(data)) {
    throw new Error("Anthropic model list response is missing data array.");
  }

  const models: Record<string, ModelProfile> = {};
  for (const item of data) {
    const record = getObject(item);
    const id = asNonEmptyString(record.id);
    if (!id) {
      continue;
    }

    const label = asNonEmptyString(record.display_name) ?? asNonEmptyString(record.name);
    models[id] = label ? { label } : {};
  }

  return models;
}

export function parseGoogleModels(input: unknown): Record<string, ModelProfile> {
  const items = getObject(input).models;
  if (!Array.isArray(items)) {
    throw new Error("Google model list response is missing models array.");
  }

  const models: Record<string, ModelProfile> = {};
  for (const item of items) {
    const record = getObject(item);
    const rawName = asNonEmptyString(record.name);
    const id = rawName?.replace(/^models\//, "");
    if (!id) {
      continue;
    }

    const generationMethods = Array.isArray(record.supportedGenerationMethods)
      ? record.supportedGenerationMethods
      : [];
    if (
      generationMethods.length > 0 &&
      !generationMethods.includes("generateContent") &&
      !generationMethods.includes("streamGenerateContent")
    ) {
      continue;
    }

    const contextWindow = positiveInteger(record.inputTokenLimit);
    const maxOutputTokens = positiveInteger(record.outputTokenLimit);
    models[id] = {
      ...(asNonEmptyString(record.displayName) ? { label: asNonEmptyString(record.displayName) } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})
    };
  }

  return models;
}

export function buildModelListUrl(baseURL: string): string {
  const normalized = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  return new URL("models", normalized).toString();
}

function buildAuthorizationHeaders(
  provider: ProviderProfile,
  env: NodeJS.ProcessEnv | undefined
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(provider.headers ?? {})
  };
  const hasAuthorization = Object.keys(headers)
    .some((key) => key.toLowerCase() === "authorization");
  const apiKey = getProviderApiKey(provider, env);
  if (apiKey && !hasAuthorization && provider.kind !== "local") {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function getProviderApiKey(provider: ProviderProfile, env: NodeJS.ProcessEnv | undefined) {
  return provider.apiKey?.trim() || (provider.apiKeyEnv ? env?.[provider.apiKeyEnv]?.trim() : "");
}

function mergeDiscoveredModels(
  existing: Record<string, ModelProfile>,
  discovered: Record<string, ModelProfile>
): Record<string, ModelProfile> {
  const merged: Record<string, ModelProfile> = {};
  for (const [modelId, profile] of Object.entries(discovered)) {
    merged[modelId] = {
      ...(existing[modelId] ?? {}),
      ...profile
    };
  }

  return merged;
}

function normalizeModelMap(input: Record<string, ModelProfile>): Record<string, ModelProfile> {
  const models: Record<string, ModelProfile> = {};
  for (const [key, value] of Object.entries(input)) {
    const modelId = key.trim();
    if (!modelId) {
      continue;
    }

    models[modelId] = {
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
  }

  return models;
}

function getObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function asNonEmptyString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value > 0 ? value : undefined;
}
