import OpenAI from "openai";
import type { SessionMessageTimestampMetadata } from "../conversation/messageMetadata.js";
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
  getMessageTimestampMetadata?: (
    message: MessageParam,
    index: number
  ) => SessionMessageTimestampMetadata | undefined;
  requestPatches?: RequestPatchOperation[];
  abortSignal?: AbortSignal;
}

function normalizeMessagesForApi(
  messages: MessageParam[],
  options: {
    gcliGeminiCompat: boolean;
    messageTimestampsEnabled: boolean;
    currentRequestTimestamp?: string;
    getMessageTimestampMetadata?: (
      message: MessageParam,
      index: number
    ) => SessionMessageTimestampMetadata | undefined;
  }
): MessageParam[] {
  const normalizedMessages = messages.map((message, index) => {
    const timestampMetadata = options.messageTimestampsEnabled
      ? options.getMessageTimestampMetadata?.(message, index)
      : undefined;
    const currentTimestampLabel = getTimestampPrefix(message.role, timestampMetadata);
    const messageWithTimestamp = currentTimestampLabel
      ? prependContentPrefix(message, currentTimestampLabel)
      : message;

    if (
      messageWithTimestamp.role === "tool" &&
      typeof messageWithTimestamp.content === "string" &&
      messageWithTimestamp.content.trim().length === 0
    ) {
      return {
        ...messageWithTimestamp,
        content: "(tool returned empty output)"
      };
    }

    if (
      messageWithTimestamp.role === "assistant" &&
      messageWithTimestamp.tool_calls &&
      isNullishOrEmptyString(messageWithTimestamp.content)
    ) {
      return {
        ...messageWithTimestamp,
        content: options.gcliGeminiCompat ? "(assistant requested a tool call)" : ""
      };
    }

    return messageWithTimestamp;
  });

  if (!options.messageTimestampsEnabled) {
    return normalizedMessages;
  }

  const currentRequestTimestamp = options.currentRequestTimestamp ?? formatSystemDateTime(new Date());
  const timestampMessage: OpenAI.Chat.Completions.ChatCompletionSystemMessageParam = {
    role: "system",
    content: [
      "# Current System Time",
      `The current local system date and time for the response you are generating right now is ${currentRequestTimestamp}.`
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
      currentRequestTimestamp: options.currentRequestTimestamp,
      getMessageTimestampMetadata: options.getMessageTimestampMetadata
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

function prependContentPrefix(message: MessageParam, prefix: string): MessageParam {
  if ("content" in message && (typeof message.content === "string" || message.content == null)) {
    if (message.role === "tool" && typeof message.content === "string" && message.content.trim().length === 0) {
      return {
        ...message,
        content: prefix
      };
    }

    return {
      ...message,
      content: `${prefix}\n\n${message.content ?? ""}`.trimEnd()
    };
  }

  return message;
}

function getTimestampPrefix(
  role: MessageParam["role"],
  metadata: SessionMessageTimestampMetadata | undefined
) {
  if (!metadata) {
    return undefined;
  }

  if (role === "user" && metadata.submittedAt) {
    return `User message timestamp: ${metadata.submittedAt}`;
  }

  if (role === "assistant" && metadata.generatedAt) {
    return `Assistant message timestamp: ${metadata.generatedAt}`;
  }

  return undefined;
}

function isNullishOrEmptyString(value: unknown): boolean {
  if (value == null) {
    return true;
  }

  return typeof value === "string" && value.trim().length === 0;
}
