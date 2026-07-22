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

// OpenAI 兼容网关的模型列表是上下文窗口的首选来源；解析时务必保留 context_length 等字段。
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
    // OpenRouter / vLLM / 多数网关会在 /models 里带上上下文长度；优先用活数据，少依赖内置穷举表。
    const contextWindow = extractContextWindowTokens(record);
    const maxOutputTokens = extractMaxOutputTokens(record);
    models[id] = {
      ...(label ? { label } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})
    };
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

// 活数据覆盖同名字段；配置里有但网关未返回的模型保留，避免自定义条目被刷新冲掉。
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

  for (const [modelId, profile] of Object.entries(existing)) {
    if (!(modelId in merged)) {
      merged[modelId] = profile;
    }
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

// 从 OpenAI 兼容 /models 条目中尽量解析上下文窗口。
// 注意：不要把 max_tokens 当上下文——很多网关里它只是默认 completion 上限（常为 4k）。
function extractContextWindowTokens(record: Record<string, unknown>): number | undefined {
  const candidates: unknown[] = [
    record.context_length,
    record.context_window,
    record.contextWindow,
    record.max_model_len,
    record.max_context_length,
    record.max_context_window,
    record.max_input_tokens,
    record.input_token_limit,
    record.inputTokenLimit
  ];

  const nestedObjects = [
    getObject(record.top_provider),
    getObject(record.architecture),
    getObject(record.limits),
    getObject(record.meta),
    getObject(record.capabilities)
  ];
  for (const nested of nestedObjects) {
    candidates.push(
      nested.context_length,
      nested.context_window,
      nested.contextWindow,
      nested.max_model_len,
      nested.max_context_length,
      nested.max_input_tokens,
      nested.input_token_limit
    );
  }

  for (const candidate of candidates) {
    const value = contextWindowTokenCount(candidate);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

// 输出上限字段；同样避开含义模糊的 max_tokens。
function extractMaxOutputTokens(record: Record<string, unknown>): number | undefined {
  const candidates: unknown[] = [
    record.max_output_tokens,
    record.maxOutputTokens,
    record.max_completion_tokens,
    record.maxCompletionTokens,
    record.output_token_limit,
    record.outputTokenLimit
  ];

  const nestedObjects = [
    getObject(record.top_provider),
    getObject(record.limits),
    getObject(record.meta)
  ];
  for (const nested of nestedObjects) {
    candidates.push(
      nested.max_output_tokens,
      nested.maxOutputTokens,
      nested.max_completion_tokens,
      nested.maxCompletionTokens,
      nested.output_token_limit
    );
  }

  for (const candidate of candidates) {
    const value = positiveInteger(candidate);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

// 上下文窗口合理区间：过小通常是 completion 默认值，过大基本是脏数据。
function contextWindowTokenCount(value: unknown): number | undefined {
  const normalized = positiveInteger(value);
  if (normalized === undefined || normalized < 4_000 || normalized > 10_000_000) {
    return undefined;
  }

  return normalized;
}

