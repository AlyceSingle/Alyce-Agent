import OpenAI from "openai";
import { formatSystemDateTime } from "../time/systemTime.js";
import {
  ASSISTANT_TOOL_CALL_PLACEHOLDER,
  extractAssistantTextContent
} from "./assistantContent.js";

export type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

const ASSISTANT_EMPTY_RESPONSE_PLACEHOLDER = "(assistant response had no text output)";

export interface ChatCompletionRequestOptions {
  model: string;
  messages: MessageParam[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  temperature?: number;
  toolChoice?: ChatCreateParams["tool_choice"];
  gcliGeminiCompat?: boolean;
  messageTimestampsEnabled?: boolean;
  currentRequestTimestamp?: string;
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

    if (message.role === "assistant") {
      const normalizedContent = extractAssistantTextContent(message.content);
      if (hasAssistantToolRequest(message)) {
        return {
          ...message,
          content: normalizedContent ?? (options.gcliGeminiCompat ? ASSISTANT_TOOL_CALL_PLACEHOLDER : "")
        };
      }

      if (normalizedContent !== undefined) {
        if (typeof message.content === "string" && message.content === normalizedContent) {
          return message;
        }

        return {
          ...message,
          content: normalizedContent
        };
      }

      return {
        ...message,
        content: ASSISTANT_EMPTY_RESPONSE_PLACEHOLDER
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
      `Authoritative local time for this request: ${currentRequestTimestamp}`,
      "Resolve words like today, yesterday, tomorrow, now, latest, currently, and recently against this timestamp.",
      "If timing is ambiguous or the user may be mistaken, state the exact date explicitly."
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

export function buildChatCompletionRequest(options: ChatCompletionRequestOptions): ChatCreateParams {
  const request: ChatCreateParams = {
    model: options.model,
    messages: normalizeMessagesForApi(options.messages, {
      gcliGeminiCompat: options.gcliGeminiCompat ?? false,
      messageTimestampsEnabled: options.messageTimestampsEnabled ?? false,
      currentRequestTimestamp: options.currentRequestTimestamp
    }),
    temperature: options.temperature ?? 0.2
  };

  if (options.tools.length > 0) {
    request.tools = options.tools;
    request.tool_choice = options.toolChoice ?? "auto";
  }

  return request;
}

function hasAssistantToolRequest(message: {
  tool_calls?: unknown;
  function_call?: unknown;
}): boolean {
  return (
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
    message.function_call !== undefined
  );
}
