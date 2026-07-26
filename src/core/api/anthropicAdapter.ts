import type OpenAI from "openai";
import type { ResolvedModelProfile } from "../providers/types.js";
import type { ChatCompletionAdapter, ChatCreateParams } from "./modelAdapters.js";
import {
  getFunctionTools,
  isFunctionToolCall,
  type ChatCompletionFunctionTool
} from "./openaiFunctionTools.js";
import {
  createChatCompletionResponse,
  extractMessageParts,
  extractMessageText,
  fetchWithHeadersTimeout,
  parseJsonObject,
  parseJsonResponse,
  toOpenAIUsage,
  type JsonRecord
} from "./nativeAdapterUtils.js";
import { asRecord as asRecordOrNull } from "../util/unknown.js";
import { readServerSentEvents } from "./sseStream.js";
import type { ChatCompletionStreamHandlers } from "./chatCompletionStream.js";

type AnthropicCacheControl = { type: "ephemeral" };

type AnthropicContentBlock = (
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: JsonRecord }
  | { type: "tool_result"; tool_use_id: string; content: string }
) & { cache_control?: AnthropicCacheControl };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
};

type AnthropicRequest = {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: Array<{ type: "text"; text: string; cache_control?: AnthropicCacheControl }>;
  temperature?: number;
  thinking?: { type: "enabled"; budget_tokens: number };
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: unknown;
  }>;
  tool_choice?: unknown;
};

// thinking 预算之外至少给回答留这么多输出空间。
const THINKING_ANSWER_HEADROOM_TOKENS = 1024;

export function createAnthropicAdapter(
  resolvedModel: ResolvedModelProfile
): ChatCompletionAdapter {
  return {
    providerId: resolvedModel.providerId,
    modelId: resolvedModel.modelId,
    kind: resolvedModel.kind,
    sendChatCompletion: async (request, options) => {
      const anthropicRequest = buildAnthropicRequest(request, options.resolvedModel);
      const streaming = Boolean(options.streamHandlers);
      const response = await fetchWithHeadersTimeout("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": options.resolvedModel.apiKey ?? ""
        },
        body: JSON.stringify(streaming ? { ...anthropicRequest, stream: true } : anthropicRequest)
      }, { signal: options.abortSignal });
      if (streaming && response.ok) {
        return consumeAnthropicMessageStream(response, {
          modelId: options.resolvedModel.modelId,
          handlers: options.streamHandlers,
          abortSignal: options.abortSignal
        });
      }
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
        if (!isFunctionToolCall(toolCall)) {
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
      const blocks = toAnthropicUserBlocks(message.content);
      appendAnthropicMessage(messages, "user", blocks.length > 0 ? blocks : [
        { type: "text", text: "(empty user message)" }
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

  // Prompt caching：system 块 + 最后一条消息各设一个缓存断点。
  // system 断点覆盖 tools+system 前缀；末消息断点让下一轮请求命中整段对话历史。
  applyCacheControlToLastBlock(messages[messages.length - 1]);

  const thinkingBudget = resolvedModel.thinkingBudgetTokens;
  const maxTokens = resolvedModel.maxOutputTokens ?? 4096;
  return {
    model: resolvedModel.modelId,
    max_tokens: thinkingBudget
      ? Math.max(maxTokens, thinkingBudget + THINKING_ANSWER_HEADROOM_TOKENS)
      : maxTokens,
    messages,
    ...(system.length > 0
      ? {
          system: [{
            type: "text" as const,
            text: system.join("\n\n"),
            cache_control: { type: "ephemeral" as const }
          }]
        }
      : {}),
    // extended thinking 只兼容默认 temperature，这里不再透传。
    ...(thinkingBudget
      ? { thinking: { type: "enabled" as const, budget_tokens: thinkingBudget } }
      : typeof request.temperature === "number"
        ? { temperature: request.temperature }
        : {}),
    ...(getFunctionTools(request.tools).length > 0
      ? { tools: getFunctionTools(request.tools).map(convertAnthropicTool) }
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
  const cacheReadTokens = numberValue(usage.cache_read_input_tokens);
  const cacheCreationTokens = numberValue(usage.cache_creation_input_tokens);
  const inputTokens = numberValue(usage.input_tokens) + cacheCreationTokens + cacheReadTokens;
  const outputTokens = numberValue(usage.output_tokens);
  return createChatCompletionResponse({
    id: typeof record.id === "string" ? record.id : "anthropic-message",
    model: typeof record.model === "string" ? record.model : modelId,
    content: textBlocks.join("\n"),
    reasoningContent: reasoningBlocks.join("\n"),
    finishReason: mapAnthropicStopReason(record.stop_reason),
    toolCalls,
    ...(inputTokens > 0 || outputTokens > 0
      ? { usage: toOpenAIUsage(inputTokens, outputTokens, { cacheReadTokens, cacheCreationTokens }) }
      : {})
  });
}

export async function consumeAnthropicMessageStream(
  response: Response,
  options: {
    modelId: string;
    handlers?: ChatCompletionStreamHandlers;
    abortSignal?: AbortSignal;
  }
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  let id = "anthropic-message";
  let model = options.modelId;
  let stopReason: unknown;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  const textBlocks: string[] = [];
  const reasoningBlocks: string[] = [];
  const blockTypes = new Map<number, string>();
  const toolCallsByIndex = new Map<number, { id: string; name: string; argumentsJson: string }>();

  for await (const event of readServerSentEvents(response, options.abortSignal)) {
    const payload = asRecord(parseLooseJson(event.data));
    const type = typeof payload.type === "string" ? payload.type : event.event;

    if (type === "error") {
      const errorRecord = asRecord(payload.error);
      throw new Error(
        typeof errorRecord.message === "string" ? errorRecord.message : "Anthropic stream error"
      );
    }

    if (type === "message_start") {
      const message = asRecord(payload.message);
      if (typeof message.id === "string") {
        id = message.id;
      }
      if (typeof message.model === "string") {
        model = message.model;
      }
      const usage = asRecord(message.usage);
      cacheReadTokens = numberValue(usage.cache_read_input_tokens);
      cacheCreationTokens = numberValue(usage.cache_creation_input_tokens);
      inputTokens = numberValue(usage.input_tokens) + cacheCreationTokens + cacheReadTokens;
      continue;
    }

    if (type === "content_block_start") {
      const index = numberValue(payload.index);
      const block = asRecord(payload.content_block);
      const blockType = typeof block.type === "string" ? block.type : "text";
      blockTypes.set(index, blockType);
      if (blockType === "text") {
        textBlocks.push("");
      } else if (blockType === "thinking") {
        reasoningBlocks.push("");
      } else if (blockType === "tool_use") {
        toolCallsByIndex.set(index, {
          id: typeof block.id === "string" ? block.id : `tool_${toolCallsByIndex.size}`,
          name: typeof block.name === "string" ? block.name : "tool",
          argumentsJson: ""
        });
      }
      continue;
    }

    if (type === "content_block_delta") {
      const index = numberValue(payload.index);
      const delta = asRecord(payload.delta);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        textBlocks[textBlocks.length - 1] = (textBlocks[textBlocks.length - 1] ?? "") + delta.text;
        options.handlers?.onTextDelta?.(delta.text);
        continue;
      }
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        reasoningBlocks[reasoningBlocks.length - 1] =
          (reasoningBlocks[reasoningBlocks.length - 1] ?? "") + delta.thinking;
        options.handlers?.onThinkingDelta?.(delta.thinking);
        continue;
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const toolCall = toolCallsByIndex.get(index);
        if (toolCall) {
          toolCall.argumentsJson += delta.partial_json;
        }
      }
      continue;
    }

    if (type === "message_delta") {
      const delta = asRecord(payload.delta);
      if (delta.stop_reason !== undefined) {
        stopReason = delta.stop_reason;
      }
      const usage = asRecord(payload.usage);
      const streamedOutput = numberValue(usage.output_tokens);
      if (streamedOutput > 0) {
        outputTokens = streamedOutput;
      }
    }
  }

  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [...toolCallsByIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => ({
      id: value.id,
      type: "function",
      function: {
        name: value.name,
        arguments: value.argumentsJson || "{}"
      }
    }));

  return createChatCompletionResponse({
    id,
    model,
    content: textBlocks.filter(Boolean).join("\n"),
    reasoningContent: reasoningBlocks.filter(Boolean).join("\n"),
    finishReason: mapAnthropicStopReason(stopReason),
    toolCalls,
    ...(inputTokens > 0 || outputTokens > 0
      ? { usage: toOpenAIUsage(inputTokens, outputTokens, { cacheReadTokens, cacheCreationTokens }) }
      : {})
  });
}

function parseLooseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function applyCacheControlToLastBlock(message: AnthropicMessage | undefined) {
  if (!message) {
    return;
  }

  for (let index = message.content.length - 1; index >= 0; index -= 1) {
    const block = message.content[index]!;
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      continue;
    }

    block.cache_control = { type: "ephemeral" };
    return;
  }
}

function toAnthropicUserBlocks(content: unknown): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  for (const part of extractMessageParts(content)) {
    if (part.kind === "text") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.kind === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: part.mediaType, data: part.base64Data }
      });
      continue;
    }
    if (part.kind === "image-url") {
      blocks.push({ type: "image", source: { type: "url", url: part.url } });
      continue;
    }
    blocks.push({
      type: "document",
      source: { type: "base64", media_type: part.mediaType, data: part.base64Data }
    });
  }

  return blocks;
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

function convertAnthropicTool(tool: ChatCompletionFunctionTool) {
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
  return asRecordOrNull(value) ?? {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
