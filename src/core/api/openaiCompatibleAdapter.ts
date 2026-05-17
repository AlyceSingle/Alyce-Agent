import OpenAI from "openai";
import type { ResolvedModelProfile } from "../providers/types.js";
import type { ChatCompletionAdapter } from "./modelAdapters.js";

export function createOpenAICompatibleAdapter(
  resolvedModel: ResolvedModelProfile
): ChatCompletionAdapter {
  const client = new OpenAI({
    apiKey: resolveOpenAICompatibleApiKey(resolvedModel),
    baseURL: resolvedModel.baseURL,
    ...(resolvedModel.headers ? { defaultHeaders: resolvedModel.headers } : {})
  });

  return {
    providerId: resolvedModel.providerId,
    modelId: resolvedModel.modelId,
    kind: resolvedModel.kind,
    sendChatCompletion: async (request, options) => {
      try {
        return await client.chat.completions.create(request, {
          signal: options.abortSignal
        });
      } catch (error) {
        throw normalizeOpenAICompatibleError(error, resolvedModel);
      }
    }
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

function normalizeOpenAICompatibleError(
  error: unknown,
  resolvedModel: ResolvedModelProfile
): unknown {
  if (resolvedModel.kind !== "local" || !isLocalEndpointUnavailable(error)) {
    return error;
  }

  return new Error(
    `Local provider '${resolvedModel.providerId}' could not reach ${resolvedModel.baseURL ?? "its endpoint"}. Start the local OpenAI-compatible server or update the Base URL with /connect ${resolvedModel.providerId}.`
  );
}

function isLocalEndpointUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = getErrorCode(error);
  if (code && LOCAL_ENDPOINT_UNAVAILABLE_CODES.has(code)) {
    return true;
  }

  return /fetch failed|connection refused|econnrefused|failed to connect|connectex/i.test(error.message);
}

function getErrorCode(error: Error): string | undefined {
  const directCode = (error as Error & { code?: unknown }).code;
  if (typeof directCode === "string" && directCode.trim()) {
    return directCode.toUpperCase();
  }

  const causeCode = (error as Error & { cause?: { code?: unknown } }).cause?.code;
  if (typeof causeCode === "string" && causeCode.trim()) {
    return causeCode.toUpperCase();
  }

  return undefined;
}

const LOCAL_ENDPOINT_UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH"
]);
