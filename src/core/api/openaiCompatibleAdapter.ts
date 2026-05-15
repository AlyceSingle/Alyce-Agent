import OpenAI from "openai";
import type { ResolvedModelProfile } from "../providers/types.js";
import type { ChatCompletionAdapter } from "./modelAdapters.js";

export function createOpenAICompatibleAdapter(
  resolvedModel: ResolvedModelProfile
): ChatCompletionAdapter {
  const client = new OpenAI({
    apiKey: resolveOpenAICompatibleApiKey(resolvedModel),
    baseURL: resolvedModel.baseURL
  });

  return {
    providerId: resolvedModel.providerId,
    modelId: resolvedModel.modelId,
    kind: resolvedModel.kind,
    sendChatCompletion: (request, options) =>
      client.chat.completions.create(request, {
        signal: options.abortSignal
      })
  };
}

function resolveOpenAICompatibleApiKey(resolvedModel: ResolvedModelProfile): string {
  if (resolvedModel.apiKey?.trim()) {
    return resolvedModel.apiKey.trim();
  }

  if (resolvedModel.kind === "local" && resolvedModel.baseURL) {
    return "local";
  }

  return "";
}
