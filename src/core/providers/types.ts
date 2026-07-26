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

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface ModelProfile {
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
  /** 缓存命中 token 的单价；未配置时按 provider 默认折扣估算（Anthropic 0.1x，其余 0.5x）。 */
  cachedInputCostPerMillionTokens?: number;
  /** 采样温度。null 表示"不要发送 temperature 参数"（部分推理模型不接受该参数）。 */
  temperature?: number | null;
  /** OpenAI 兼容通道的 reasoning_effort 参数；设置后不再发送 temperature。 */
  reasoningEffort?: ReasoningEffort;
  /** Anthropic extended thinking / Gemini thinkingConfig 的思考 token 预算。 */
  thinkingBudgetTokens?: number;
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
  cachedInputCostPerMillionTokens?: number;
  temperature?: number | null;
  reasoningEffort?: ReasoningEffort;
  thinkingBudgetTokens?: number;
}
