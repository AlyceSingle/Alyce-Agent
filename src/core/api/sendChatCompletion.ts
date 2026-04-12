import OpenAI from "openai";
import { applyRequestPatchOperations, type RequestPatchOperation } from "./requestPatch.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

type ChatCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

export interface SendChatCompletionOptions {
  model: string;
  messages: MessageParam[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  temperature?: number;
  toolChoice?: ChatCreateParams["tool_choice"];
  requestPatches?: RequestPatchOperation[];
}

function normalizeMessagesForApi(messages: MessageParam[]): MessageParam[] {
  return messages.map((message) => {
    if (message.role === "tool" && typeof message.content === "string" && message.content.trim().length === 0) {
      return {
        ...message,
        content: "(tool returned empty output)"
      };
    }

    if (message.role === "assistant" && message.tool_calls && message.content == null) {
      return {
        ...message,
        content: ""
      };
    }

    return message;
  });
}

// 统一模型请求发送逻辑，支持请求标准化和 JSON Patch 二次改写。
export async function sendChatCompletion(
  client: OpenAI,
  options: SendChatCompletionOptions
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const baseRequest: ChatCreateParams = {
    model: options.model,
    messages: normalizeMessagesForApi(options.messages),
    tools: options.tools,
    tool_choice: options.toolChoice ?? "auto",
    temperature: options.temperature ?? 0.2
  };

  const patchedRequest = applyRequestPatchOperations(baseRequest, options.requestPatches ?? []);
  return client.chat.completions.create(patchedRequest);
}
