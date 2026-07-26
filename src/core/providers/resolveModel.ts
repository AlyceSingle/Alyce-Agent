import {
  resolveModelContextWindow,
  type ModelContextWindowOverrides
} from "../context/modelContextWindows.js";
import { DEFAULT_PROVIDER_ID } from "./defaults.js";
import type {
  ModelRef,
  ProviderProfileMap,
  ResolvedModelProfile
} from "./types.js";

export function parseModelRef(
  value: string,
  defaultProviderId = DEFAULT_PROVIDER_ID
): ModelRef {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Model name is required.");
  }

  const separatorIndex = normalized.indexOf("/");
  if (separatorIndex < 0) {
    return {
      providerId: normalizeProviderId(defaultProviderId),
      modelId: normalized
    };
  }

  const providerId = normalizeProviderId(normalized.slice(0, separatorIndex));
  const modelId = normalized.slice(separatorIndex + 1).trim();
  if (!providerId || !modelId) {
    throw new Error(`Invalid model reference: ${value}`);
  }

  return {
    providerId,
    modelId
  };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.providerId}/${ref.modelId}`;
}

// 解析最终模型档案。上下文窗口优先级：
// 1) 用户 override（设置/配置）
// 2) provider.models[id].contextWindow（静态配置 + /models 实时发现合并后的值）
// 3) 模型名后缀推断 / 默认 128k（见 resolveModelContextWindow）
export function resolveModelProfile(
  value: string | ModelRef,
  options: {
    providers: ProviderProfileMap;
    defaultProviderId?: string;
    modelContextWindowOverrides?: ModelContextWindowOverrides;
    env?: NodeJS.ProcessEnv;
  }
): ResolvedModelProfile {
  const modelRef = typeof value === "string"
    ? parseModelRef(value, options.defaultProviderId ?? DEFAULT_PROVIDER_ID)
    : value;
  const provider = options.providers[modelRef.providerId];
  if (!provider) {
    throw new Error(`Unknown provider: ${modelRef.providerId}`);
  }

  const modelProfile = provider.models?.[modelRef.modelId] ?? {};
  const providerModelName = formatModelRef(modelRef);
  // 名称推断与默认值仅作兜底；有 provider 档案上下文时不覆盖（override 除外）。
  const contextWindowResolution = resolveModelContextWindow(
    providerModelName,
    options.modelContextWindowOverrides
  );
  const resolvedContextWindow = contextWindowResolution.source === "override" ||
    modelProfile.contextWindow === undefined
    ? {
        contextWindow: contextWindowResolution.contextWindow,
        source: contextWindowResolution.source,
        label: contextWindowResolution.label,
        matchedPattern: contextWindowResolution.matchedPattern
      }
    : {
        contextWindow: modelProfile.contextWindow,
        source: "provider_profile" as const,
        label: `provider profile: ${providerModelName}`,
        matchedPattern: providerModelName
      };

  const apiKey = provider.apiKey ?? (
    provider.apiKeyEnv ? options.env?.[provider.apiKeyEnv] : undefined
  );

  return {
    providerId: modelRef.providerId,
    modelId: modelRef.modelId,
    modelRef: { ...modelRef },
    label: modelProfile.label ?? modelRef.modelId,
    provider: {
      ...provider,
      models: provider.models ? { ...provider.models } : undefined
    },
    kind: provider.kind,
    ...(apiKey ? { apiKey } : {}),
    ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
    ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
    ...(provider.headers ? { headers: { ...provider.headers } } : {}),
    contextWindow: resolvedContextWindow.contextWindow,
    contextWindowSource: resolvedContextWindow.source,
    contextWindowLabel: resolvedContextWindow.label,
    ...(resolvedContextWindow.matchedPattern
      ? { contextWindowMatchedPattern: resolvedContextWindow.matchedPattern }
      : {}),
    ...(modelProfile.maxOutputTokens !== undefined
      ? { maxOutputTokens: modelProfile.maxOutputTokens }
      : {}),
    ...(modelProfile.inputCostPerMillionTokens !== undefined
      ? { inputCostPerMillionTokens: modelProfile.inputCostPerMillionTokens }
      : {}),
    ...(modelProfile.outputCostPerMillionTokens !== undefined
      ? { outputCostPerMillionTokens: modelProfile.outputCostPerMillionTokens }
      : {}),
    ...(modelProfile.temperature !== undefined
      ? { temperature: modelProfile.temperature }
      : {}),
    ...(modelProfile.reasoningEffort !== undefined
      ? { reasoningEffort: modelProfile.reasoningEffort }
      : {}),
    ...(modelProfile.thinkingBudgetTokens !== undefined
      ? { thinkingBudgetTokens: modelProfile.thinkingBudgetTokens }
      : {})
  };
}

function normalizeProviderId(value: string): string {
  return value.trim().toLowerCase();
}
