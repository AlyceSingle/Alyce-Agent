import type OpenAI from "openai";
import { createChatCompletionResponse } from "./nativeAdapterUtils.js";

export type ChatCompletionStreamHandlers = {
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
};

type MutableToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

type StreamDelta = {
  content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
  // 部分 OpenAI 兼容通道会把 reasoning 放在这些扩展字段里。
  reasoning_content?: string | null;
  reasoning?: string | null;
  reasoning_text?: string | null;
};

/**
 * 消费 OpenAI Chat Completions SSE 流，边收边回调，最终组装成非流式 ChatCompletion，
 * 以便现有 tool_calls / history 逻辑无需分叉。
 *
 * 注意：onTextDelta 应尽量轻量（只入队/拼接），重 UI 工作放到定时合并刷新，
 * 否则会阻塞事件循环、拖慢后续 SSE chunk 读取（看起来像 API 变慢）。
 */
export async function consumeOpenAIChatCompletionStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  options: {
    model: string;
    handlers?: ChatCompletionStreamHandlers;
    abortSignal?: AbortSignal;
  }
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  let id = "";
  let model = options.model;
  let content = "";
  let reasoningContent = "";
  let finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"] = "stop";
  let usage: OpenAI.Completions.CompletionUsage | undefined;
  const toolCalls = new Map<number, MutableToolCall>();

  for await (const chunk of stream) {
    if (options.abortSignal?.aborted) {
      const error = new Error("Request aborted");
      error.name = "AbortError";
      throw error;
    }

    if (chunk.id) {
      id = chunk.id;
    }
    if (chunk.model) {
      model = chunk.model;
    }
    if (chunk.usage) {
      usage = chunk.usage;
    }

    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }

    const delta = (choice.delta ?? {}) as StreamDelta;
    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      options.handlers?.onTextDelta?.(delta.content);
    }

    const thinkingDelta =
      (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
      (typeof delta.reasoning === "string" && delta.reasoning) ||
      (typeof delta.reasoning_text === "string" && delta.reasoning_text) ||
      "";
    if (thinkingDelta) {
      reasoningContent += thinkingDelta;
      options.handlers?.onThinkingDelta?.(thinkingDelta);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        const index = typeof toolCall.index === "number" ? toolCall.index : 0;
        let accumulated = toolCalls.get(index);
        if (!accumulated) {
          accumulated = {
            id: toolCall.id?.trim() || `call_${index}`,
            type: "function",
            function: {
              name: "",
              arguments: ""
            }
          };
          toolCalls.set(index, accumulated);
        }

        if (toolCall.id?.trim()) {
          accumulated.id = toolCall.id.trim();
        }
        if (toolCall.function?.name) {
          accumulated.function.name += toolCall.function.name;
        }
        if (toolCall.function?.arguments) {
          accumulated.function.arguments += toolCall.function.arguments;
        }
      }
    }
  }

  const orderedToolCalls = [...toolCalls.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => value as OpenAI.Chat.Completions.ChatCompletionMessageToolCall);

  return createChatCompletionResponse({
    id: id || `chatcmpl_stream_${Date.now()}`,
    model,
    content,
    reasoningContent: reasoningContent || undefined,
    finishReason,
    toolCalls: orderedToolCalls.length > 0 ? orderedToolCalls : undefined,
    usage
  });
}
