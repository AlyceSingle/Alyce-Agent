import type { ResolvedModelProfile } from "../providers/types.js";
import {
  getModelAdapterAvailability,
  type ModelAdapterAvailability
} from "./modelAdapterAvailability.js";
import { createAnthropicAdapter } from "./anthropicAdapter.js";
import { createGoogleAdapter } from "./googleAdapter.js";
import type { ChatCompletionAdapter } from "./modelAdapters.js";
import { createOpenAICompatibleAdapter } from "./openaiCompatibleAdapter.js";

export interface ModelAdapterFactory {
  id: string;
  create: (resolvedModel: ResolvedModelProfile) => ChatCompletionAdapter;
  availability: (resolvedModel: ResolvedModelProfile) => ModelAdapterAvailability;
}

const OPENAI_COMPATIBLE_FACTORY: ModelAdapterFactory = {
  id: "openai-compatible",
  create: createOpenAICompatibleAdapter,
  availability: getModelAdapterAvailability
};

const ANTHROPIC_NATIVE_FACTORY: ModelAdapterFactory = {
  id: "anthropic-native",
  create: createAnthropicAdapter,
  availability: getModelAdapterAvailability
};

const GOOGLE_NATIVE_FACTORY: ModelAdapterFactory = {
  id: "google-native",
  create: createGoogleAdapter,
  availability: getModelAdapterAvailability
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
