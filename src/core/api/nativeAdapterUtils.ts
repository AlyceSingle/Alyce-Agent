import type OpenAI from "openai";
import { asRecord, asString } from "../util/unknown.js";

export type JsonRecord = Record<string, unknown>;

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      const record = asRecord(part);
      if (!record) {
        return "";
      }

      return asString(record.text) ?? asString(record.content) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

export function parseJsonObject(value: string): JsonRecord {
  try {
    return asRecord(JSON.parse(value) as unknown) ?? {};
  } catch {
    return {};
  }
}

export function createChatCompletionResponse(options: {
  id: string;
  model: string;
  content: string;
  reasoningContent?: string;
  finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"];
  toolCalls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  usage?: OpenAI.Completions.CompletionUsage;
}): OpenAI.Chat.Completions.ChatCompletion {
  const message: OpenAI.Chat.Completions.ChatCompletionMessage & Record<string, unknown> = {
    role: "assistant",
    content: options.content,
    refusal: null,
    ...(options.toolCalls && options.toolCalls.length > 0
      ? { tool_calls: options.toolCalls }
      : {})
  };
  const reasoningContent = options.reasoningContent?.trim();
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  return {
    id: options.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [
      {
        index: 0,
        finish_reason: options.finishReason,
        logprobs: null,
        message
      }
    ],
    ...(options.usage ? { usage: options.usage } : {})
  };
}

export function toOpenAIUsage(inputTokens: number, outputTokens: number): OpenAI.Completions.CompletionUsage {
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  };
}

export async function parseJsonResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) as unknown : {};
  if (!response.ok) {
    const message = extractProviderErrorMessage(parsed) ?? (raw || `HTTP ${response.status}`);
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  return parsed;
}

export function extractProviderErrorMessage(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const error = record.error;
  if (typeof error === "string") {
    return error;
  }

  const errorRecord = asRecord(error);
  if (errorRecord) {
    const message = asString(errorRecord.message);
    if (message) {
      return message;
    }
    const type = asString(errorRecord.type);
    if (type) {
      return type;
    }
  }

  return asString(record.message);
}
