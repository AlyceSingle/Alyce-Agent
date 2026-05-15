import type OpenAI from "openai";
import type { ResolvedModelProfile } from "../providers/types.js";
import { createOpenAICompatibleAdapter } from "./openaiCompatibleAdapter.js";

export type ChatCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

export interface ChatCompletionAdapter {
  providerId: string;
  modelId: string;
  kind: ResolvedModelProfile["kind"];
  sendChatCompletion: (
    request: ChatCreateParams,
    options: {
      resolvedModel: ResolvedModelProfile;
      abortSignal?: AbortSignal;
    }
  ) => Promise<OpenAI.Chat.Completions.ChatCompletion>;
}

export type ChatCompletionTransport = OpenAI | ChatCompletionAdapter;

export interface ModelAdapterAvailability {
  available: boolean;
  reason?: string;
}

export function createModelAdapter(resolvedModel: ResolvedModelProfile): ChatCompletionAdapter {
  const availability = getModelAdapterAvailability(resolvedModel);
  if (!availability.available) {
    throw new Error(
      availability.reason ?? `Provider '${resolvedModel.providerId}' is not available.`
    );
  }

  return createOpenAICompatibleAdapter(resolvedModel);
}

export function getModelAdapterAvailability(
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
      reason: `Provider '${resolvedModel.providerId}' is configured as '${resolvedModel.kind}', but Alyce currently only supports it through an OpenAI-compatible baseURL.`
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

export function isChatCompletionAdapter(
  transport: ChatCompletionTransport
): transport is ChatCompletionAdapter {
  return typeof (transport as { sendChatCompletion?: unknown }).sendChatCompletion === "function";
}
