import type OpenAI from "openai";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface ToolResultEnvelope {
  __alyceToolResultEnvelope: true;
  result: unknown;
  supplementalMessages?: MessageParam[];
}

export function createToolResultEnvelope(
  result: unknown,
  supplementalMessages: MessageParam[] = []
): ToolResultEnvelope {
  return {
    __alyceToolResultEnvelope: true,
    result,
    supplementalMessages
  };
}

export function isToolResultEnvelope(value: unknown): value is ToolResultEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }

  return (value as { __alyceToolResultEnvelope?: unknown }).__alyceToolResultEnvelope === true;
}
