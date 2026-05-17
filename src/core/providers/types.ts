import type { ContextWindowSource } from "../context/modelContextWindows.js";

export type ProviderId = string;
export type ModelId = string;

export type ProviderKind =
  | "openai-compatible"
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "local";

export interface ModelRef {
  providerId: ProviderId;
  modelId: ModelId;
}

export interface ModelProfile {
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
}

export interface ProviderProfile {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  apiKeyEnv?: string;
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  defaultModel?: ModelId;
  models?: Record<ModelId, ModelProfile>;
}

export type ProviderProfileMap = Record<ProviderId, ProviderProfile>;

export interface ProviderRegistry {
  defaultProviderId: ProviderId;
  currentModelRef: ModelRef;
  providers: ProviderProfileMap;
}

export type ResolvedContextWindowSource = ContextWindowSource | "provider_profile";

export interface ResolvedModelProfile {
  providerId: ProviderId;
  modelId: ModelId;
  modelRef: ModelRef;
  label: string;
  provider: ProviderProfile;
  kind: ProviderKind;
  apiKey?: string;
  apiKeyEnv?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  contextWindow: number;
  contextWindowSource: ResolvedContextWindowSource;
  contextWindowLabel: string;
  contextWindowMatchedPattern?: string;
  maxOutputTokens?: number;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
}
