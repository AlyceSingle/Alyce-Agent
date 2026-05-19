import type OpenAI from "openai";
import type { ResolvedModelProfile } from "../providers/types.js";
import type { ChatCompletionAdapter, ChatCreateParams } from "./modelAdapters.js";
import {
  createChatCompletionResponse,
  extractMessageText,
  parseJsonObject,
  parseJsonResponse,
  toOpenAIUsage,
  type JsonRecord
} from "./nativeAdapterUtils.js";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: JsonRecord }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

type AnthropicRequest = {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: unknown;
  }>;
  tool_choice?: unknown;
};

export function createAnthropicAdapter(
  resolvedModel: ResolvedModelProfile
): ChatCompletionAdapter {
  return {
    providerId: resolvedModel.providerId,
    modelId: resolvedModel.modelId,
    kind: resolvedModel.kind,
    sendChatCompletion: async (request, options) => {
      const anthropicRequest = buildAnthropicRequest(request, options.resolvedModel);
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": options.resolvedModel.apiKey ?? ""
        },
        body: JSON.stringify(anthropicRequest),
        signal: options.abortSignal
      });
      return convertAnthropicResponse(
        await parseJsonResponse(response),
        options.resolvedModel.modelId
      );
    }
  };
}

export function buildAnthropicRequest(
  request: ChatCreateParams,
  resolvedModel: ResolvedModelProfile
): AnthropicRequest {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  const toolNameById = new Map<string, string>();

  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = extractMessageText(message.content);
      if (text) {
        system.push(text);
      }
      continue;
    }

    if (message.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      const text = extractMessageText(message.content);
      if (text) {
        blocks.push({ type: "text", text });
      }

      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.type !== "function") {
          continue;
        }

        toolNameById.set(toolCall.id, toolCall.function.name);
        blocks.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseJsonObject(toolCall.function.arguments)
        });
      }

      appendAnthropicMessage(messages, "assistant", blocks.length > 0 ? blocks : [
        { type: "text", text: "" }
      ]);
      continue;
    }

    if (message.role === "tool") {
      const content = extractMessageText(message.content);
      appendAnthropicMessage(messages, "user", [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: content || "(tool returned empty output)"
        }
      ]);
      continue;
    }

    if (message.role === "user") {
      const text = extractMessageText(message.content);
      appendAnthropicMessage(messages, "user", [
        { type: "text", text: text || "(empty user message)" }
      ]);
      continue;
    }

    if (message.role === "function") {
      const name = message.name ?? "function";
      appendAnthropicMessage(messages, "user", [
        {
          type: "text",
          text: `Function result (${name}): ${extractMessageText(message.content)}`
        }
      ]);
    }
  }

  return {
    model: resolvedModel.modelId,
    max_tokens: resolvedModel.maxOutputTokens ?? 4096,
    messages,
    ...(system.length > 0 ? { system: system.join("\n\n") } : {}),
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(request.tools && request.tools.length > 0
      ? { tools: request.tools.map(convertAnthropicTool) }
      : {}),
    ...(request.tool_choice ? { tool_choice: convertAnthropicToolChoice(request.tool_choice) } : {})
  };
}

export function convertAnthropicResponse(
  value: unknown,
  modelId: string
): OpenAI.Chat.Completions.ChatCompletion {
  const record = asRecord(value);
  const content = Array.isArray(record.content) ? record.content : [];
  const textBlocks: string[] = [];
  const reasoningBlocks: string[] = [];
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

  for (const block of content) {
    const blockRecord = asRecord(block);
    if (blockRecord.type === "text" && typeof blockRecord.text === "string") {
      textBlocks.push(blockRecord.text);
      continue;
    }

    if (blockRecord.type === "thinking" && typeof blockRecord.thinking === "string") {
      reasoningBlocks.push(blockRecord.thinking);
      continue;
    }

    if (blockRecord.type === "tool_use") {
      const id = typeof blockRecord.id === "string" ? blockRecord.id : `tool_${toolCalls.length}`;
      const name = typeof blockRecord.name === "string" ? blockRecord.name : "tool";
      toolCalls.push({
        id,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(blockRecord.input ?? {})
        }
      });
    }
  }

  const usage = asRecord(record.usage);
  const inputTokens = numberValue(usage.input_tokens) + numberValue(usage.cache_creation_input_tokens) + numberValue(usage.cache_read_input_tokens);
  const outputTokens = numberValue(usage.output_tokens);
  return createChatCompletionResponse({
    id: typeof record.id === "string" ? record.id : "anthropic-message",
    model: typeof record.model === "string" ? record.model : modelId,
    content: textBlocks.join("\n"),
    reasoningContent: reasoningBlocks.join("\n"),
    finishReason: mapAnthropicStopReason(record.stop_reason),
    toolCalls,
    ...(inputTokens > 0 || outputTokens > 0
      ? { usage: toOpenAIUsage(inputTokens, outputTokens) }
      : {})
  });
}

function appendAnthropicMessage(
  messages: AnthropicMessage[],
  role: "user" | "assistant",
  content: AnthropicContentBlock[]
) {
  const previous = messages[messages.length - 1];
  if (previous?.role === role) {
    previous.content.push(...content);
    return;
  }

  messages.push({ role, content });
}

function convertAnthropicTool(tool: OpenAI.Chat.Completions.ChatCompletionTool) {
  return {
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    input_schema: tool.function.parameters ?? { type: "object", properties: {} }
  };
}

function convertAnthropicToolChoice(toolChoice: ChatCreateParams["tool_choice"]) {
  if (toolChoice === "none") {
    return { type: "none" };
  }
  if (toolChoice === "required") {
    return { type: "any" };
  }
  if (typeof toolChoice === "object" && toolChoice?.type === "function") {
    return { type: "tool", name: toolChoice.function.name };
  }

  return { type: "auto" };
}

function mapAnthropicStopReason(value: unknown): OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"] {
  switch (value) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "stop_sequence":
    case "end_turn":
    default:
      return "stop";
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
