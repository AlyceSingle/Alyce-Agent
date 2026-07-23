import type OpenAI from "openai";
import { extractMessageText as extractContentText } from "./nativeAdapterUtils.js";
import { getFunctionToolCallNames } from "./openaiFunctionTools.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Extract plain text from a message content payload (string or content parts). */
export function extractMessageText(content: unknown): string {
  return extractContentText(content);
}

/** Collapse whitespace for display / history matching. */
export function extractCollapsedMessageText(content: unknown): string {
  return extractMessageText(content).replace(/\s+/g, " ").trim();
}

/**
 * Extract readable text from a chat message for memory/compaction previews.
 * Tool messages keep raw string content; assistant tool requests are summarized.
 */
export function extractChatMessageText(
  message: MessageParam,
  options?: { includeToolCallSummary?: boolean }
): string {
  if (message.role === "tool") {
    return typeof message.content === "string" ? message.content : "";
  }

  const content = (message as { content?: unknown }).content;
  const text = extractMessageText(content).trim();
  const parts: string[] = text ? [text] : [];

  if (
    options?.includeToolCallSummary &&
    message.role === "assistant" &&
    "tool_calls" in message &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  ) {
    const toolNames = getFunctionToolCallNames(message.tool_calls).join(", ");
    if (toolNames) {
      parts.push(`Requested tools: ${toolNames}`);
    }
  }

  return parts.join("\n").trim();
}
