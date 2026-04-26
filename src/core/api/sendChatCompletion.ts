import OpenAI from "openai";
import { formatSystemDateTime } from "../time/systemTime.js";
import { applyRequestPatchOperations, type RequestPatchOperation } from "./requestPatch.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

type ChatCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

export interface SendChatCompletionOptions {
  model: string;
  messages: MessageParam[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  temperature?: number;
  toolChoice?: ChatCreateParams["tool_choice"];
  gcliGeminiCompat?: boolean;
  messageTimestampsEnabled?: boolean;
  currentRequestTimestamp?: string;
  requestPatches?: RequestPatchOperation[];
  abortSignal?: AbortSignal;
}

function normalizeMessagesForApi(
  messages: MessageParam[],
  options: {
    gcliGeminiCompat: boolean;
    messageTimestampsEnabled: boolean;
    currentRequestTimestamp?: string;
  }
): MessageParam[] {
  const normalizedMessages = messages.map((message) => {
    if (
      message.role === "tool" &&
      typeof message.content === "string" &&
      message.content.trim().length === 0
    ) {
      return {
        ...message,
        content: "(tool returned empty output)"
      };
    }

    if (
      message.role === "assistant" &&
      message.tool_calls &&
      isNullishOrEmptyString(message.content)
    ) {
      return {
        ...message,
        content: options.gcliGeminiCompat ? "(assistant requested a tool call)" : ""
      };
    }

    return message;
  });

  if (!options.messageTimestampsEnabled) {
    return normalizedMessages;
  }

  const currentRequestTimestamp = options.currentRequestTimestamp ?? formatSystemDateTime(new Date());
  const timestampMessage: OpenAI.Chat.Completions.ChatCompletionSystemMessageParam = {
    role: "system",
    content: [
      "# Current System Time",
      `Current local system date and time: ${currentRequestTimestamp}`
    ].join("\n")
  };

  let insertIndex = 0;
  while (insertIndex < normalizedMessages.length && normalizedMessages[insertIndex]?.role === "system") {
    insertIndex += 1;
  }

  return [
    ...normalizedMessages.slice(0, insertIndex),
    timestampMessage,
    ...normalizedMessages.slice(insertIndex)
  ];
}

export function buildChatCompletionRequest(
  options: Omit<SendChatCompletionOptions, "abortSignal" | "requestPatches">
): ChatCreateParams {
  return {
    model: options.model,
    messages: normalizeMessagesForApi(options.messages, {
      gcliGeminiCompat: options.gcliGeminiCompat ?? false,
      messageTimestampsEnabled: options.messageTimestampsEnabled ?? false,
      currentRequestTimestamp: options.currentRequestTimestamp
    }),
    tools: options.tools,
    tool_choice: options.toolChoice ?? "auto",
    temperature: options.temperature ?? 0.2
  };
}

// 统一模型请求发送逻辑，支持请求标准化和 JSON Patch 二次改写。
export async function sendChatCompletion(
  client: OpenAI,
  options: SendChatCompletionOptions
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const baseRequest = buildChatCompletionRequest(options);
  const patchedRequest = applyRequestPatchOperations(baseRequest, options.requestPatches ?? []);
  return client.chat.completions.create(patchedRequest, {
    signal: options.abortSignal
  });
}

function isNullishOrEmptyString(value: unknown): boolean {
  if (value == null) {
    return true;
  }

  return typeof value === "string" && value.trim().length === 0;
}
