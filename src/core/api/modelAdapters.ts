import type OpenAI from "openai";
import type { ResolvedModelProfile } from "../providers/types.js";
import type { ChatCompletionStreamHandlers } from "./chatCompletionStream.js";
import { resolveModelAdapterFactory } from "./adapterRegistry.js";
export {
  getModelAdapterAvailability,
  type ModelAdapterAvailability
} from "./modelAdapterAvailability.js";

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
      /** 若提供，适配器在支持时应走流式并回传增量。 */
      streamHandlers?: ChatCompletionStreamHandlers;
    }
  ) => Promise<OpenAI.Chat.Completions.ChatCompletion>;
}

export type ChatCompletionTransport = OpenAI | ChatCompletionAdapter;

export function createModelAdapter(resolvedModel: ResolvedModelProfile): ChatCompletionAdapter {
  const factory = resolveModelAdapterFactory(resolvedModel);
  const availability = factory.availability(resolvedModel);
  if (!availability.available) {
    throw new Error(
      availability.reason ?? `Provider '${resolvedModel.providerId}' is not available.`
    );
  }

  return factory.create(resolvedModel);
}

export function isChatCompletionAdapter(
  transport: ChatCompletionTransport
): transport is ChatCompletionAdapter {
  return typeof (transport as { sendChatCompletion?: unknown }).sendChatCompletion === "function";
}
