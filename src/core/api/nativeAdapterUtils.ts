import type OpenAI from "openai";

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
      if (!part || typeof part !== "object") {
        return "";
      }

      const record = part as JsonRecord;
      if (typeof record.text === "string") {
        return record.text;
      }

      if (typeof record.content === "string") {
        return record.content;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function parseJsonObject(value: string): JsonRecord {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : {};
  } catch {
    return {};
  }
}

export function createChatCompletionResponse(options: {
  id: string;
  model: string;
  content: string;
  finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"];
  toolCalls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  usage?: OpenAI.Completions.CompletionUsage;
}): OpenAI.Chat.Completions.ChatCompletion {
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
        message: {
          role: "assistant",
          content: options.content,
          refusal: null,
          ...(options.toolCalls && options.toolCalls.length > 0
            ? { tool_calls: options.toolCalls }
            : {})
        }
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
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as JsonRecord;
  const error = record.error;
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const errorRecord = error as JsonRecord;
    if (typeof errorRecord.message === "string") {
      return errorRecord.message;
    }
    if (typeof errorRecord.type === "string") {
      return errorRecord.type;
    }
  }

  if (typeof record.message === "string") {
    return record.message;
  }

  return undefined;
}
