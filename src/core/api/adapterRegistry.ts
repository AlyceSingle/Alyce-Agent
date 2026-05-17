import type { ResolvedModelProfile } from "../providers/types.js";
import { createAnthropicAdapter } from "./anthropicAdapter.js";
import { createGoogleAdapter } from "./googleAdapter.js";
import type { ChatCompletionAdapter, ModelAdapterAvailability } from "./modelAdapters.js";
import { createOpenAICompatibleAdapter } from "./openaiCompatibleAdapter.js";

export interface ModelAdapterFactory {
  id: string;
  create: (resolvedModel: ResolvedModelProfile) => ChatCompletionAdapter;
  availability: (resolvedModel: ResolvedModelProfile) => ModelAdapterAvailability;
}

const OPENAI_COMPATIBLE_FACTORY: ModelAdapterFactory = {
  id: "openai-compatible",
  create: createOpenAICompatibleAdapter,
  availability: getOpenAICompatibleAvailability
};

const ANTHROPIC_NATIVE_FACTORY: ModelAdapterFactory = {
  id: "anthropic-native",
  create: createAnthropicAdapter,
  availability: getApiKeyAvailability
};

const GOOGLE_NATIVE_FACTORY: ModelAdapterFactory = {
  id: "google-native",
  create: createGoogleAdapter,
  availability: getApiKeyAvailability
};

export function resolveModelAdapterFactory(
  resolvedModel: ResolvedModelProfile
): ModelAdapterFactory {
  if (resolvedModel.kind === "anthropic" && !resolvedModel.baseURL) {
    return ANTHROPIC_NATIVE_FACTORY;
  }

  if (resolvedModel.kind === "google" && !resolvedModel.baseURL) {
    return GOOGLE_NATIVE_FACTORY;
  }

  return OPENAI_COMPATIBLE_FACTORY;
}

function getOpenAICompatibleAvailability(
  resolvedModel: ResolvedModelProfile
): ModelAdapterAvailability {
  if (resolvedModel.kind === "local" && !resolvedModel.baseURL) {
    return {
      available: false,
      reason: `Provider '${resolvedModel.providerId}' is local and requires a baseURL for its OpenAI-compatible endpoint.`
    };
  }

  if (
    (resolvedModel.kind === "anthropic" || resolvedModel.kind === "google") &&
    !resolvedModel.baseURL
  ) {
    return {
      available: false,
      reason: `Provider '${resolvedModel.providerId}' is configured as '${resolvedModel.kind}', but no native adapter is registered.`
    };
  }

  if (!resolvedModel.apiKey && resolvedModel.kind !== "local") {
    const envHint = resolvedModel.apiKeyEnv ? ` or set ${resolvedModel.apiKeyEnv}` : "";
    return {
      available: false,
      reason: `Provider '${resolvedModel.providerId}' is missing an API key. Configure apiKey${envHint}.`
    };
  }

  return {
    available: true
  };
}

function getApiKeyAvailability(
  resolvedModel: ResolvedModelProfile
): ModelAdapterAvailability {
  if (!resolvedModel.apiKey) {
    const envHint = resolvedModel.apiKeyEnv ? ` or set ${resolvedModel.apiKeyEnv}` : "";
    return {
      available: false,
      reason: `Provider '${resolvedModel.providerId}' is missing an API key. Configure apiKey${envHint}.`
    };
  }

  return {
    available: true
  };
}
