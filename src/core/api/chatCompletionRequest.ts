import OpenAI from "openai";
import { formatSystemDateTime } from "../time/systemTime.js";
import { extractAssistantTextContent } from "./assistantContent.js";
import { hasAssistantToolRequest } from "./openaiFunctionTools.js";

export type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

export interface ChatCompletionRequestOptions {
  model: string;
  messages: MessageParam[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  temperature?: number;
  toolChoice?: ChatCreateParams["tool_choice"];
  messageTimestampsEnabled?: boolean;
  currentRequestTimestamp?: string;
}

function normalizeMessagesForApi(
  messages: MessageParam[],
  options: {
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
          content: normalizedContent ?? ""
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
        content: ""
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
