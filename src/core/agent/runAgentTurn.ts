import OpenAI from "openai";
import { executeToolCall, TOOL_SCHEMAS, type ToolExecutionContext } from "../../tools.js";
import { isTurnInterruptedError, throwIfAborted, toTurnInterruptedError } from "../abort.js";
import { sendChatCompletion } from "../api/sendChatCompletion.js";
import type { RequestPatchOperation } from "../api/requestPatch.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type UnknownRecord = Record<string, unknown>;

// 单轮 Agent 执行采用“模型回复 -> 运行工具 -> 回填结果 -> 再次请求模型”的闭环。
export interface AgentTurnOptions {
  model: string;
  maxSteps: number;
  context: ToolExecutionContext;
  requestPatches?: RequestPatchOperation[];
  abortSignal?: AbortSignal;
  onThinking?: (content: string) => void;
  onToolCallStart?: (toolName: string, rawArguments: string) => void;
  onToolCallResult?: (toolName: string, result: string) => void;
}

export async function runAgentTurn(
  client: OpenAI,
  messages: MessageParam[],
  options: AgentTurnOptions
): Promise<string> {
  // 工具轮次受 maxSteps 限制，避免模型无限循环调用工具。
  for (let step = 0; step < options.maxSteps; step += 1) {
    throwIfAborted(options.abortSignal);

    let response: OpenAI.Chat.Completions.ChatCompletion;
    try {
      response = await sendChatCompletion(client, {
        model: options.model,
        messages,
        tools: TOOL_SCHEMAS,
        toolChoice: "auto",
        temperature: 0.2,
        requestPatches: options.requestPatches,
        abortSignal: options.abortSignal
      });
    } catch (error) {
      if (isTurnInterruptedError(error, options.abortSignal)) {
        throw toTurnInterruptedError(error, options.abortSignal);
      }

      throw error;
    }

    const next = response.choices[0]?.message;
    if (!next) {
      throw new Error("Model returned an empty response");
    }

    const toolCalls = next.tool_calls ?? [];
    const thinkingChunks = extractThinkingChunks(next, toolCalls.length > 0);
    for (const chunk of thinkingChunks) {
      options.onThinking?.(chunk);
    }

    // 无论下一步是直接结束还是继续调工具，都先把 assistant 原始输出写回上下文。
    messages.push({
      role: "assistant",
      content: next.content ?? "",
      tool_calls: next.tool_calls
    });

    if (toolCalls.length === 0) {
      return (next.content ?? "").trim() || "(No text output from model)";
    }

    for (const toolCall of toolCalls) {
      throwIfAborted(options.abortSignal);

      if (toolCall.type !== "function") {
        continue;
      }

      options.onToolCallStart?.(toolCall.function.name, toolCall.function.arguments);

      let result: string;
      try {
        result = await executeToolCall(toolCall.function.name, toolCall.function.arguments, options.context);
      } catch (error) {
        if (isTurnInterruptedError(error, options.abortSignal)) {
          throw toTurnInterruptedError(error, options.abortSignal);
        }

        throw error;
      }

      throwIfAborted(options.abortSignal);
      options.onToolCallResult?.(toolCall.function.name, result);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result
      });
    }
  }

  throw new Error(`Max tool steps reached (${options.maxSteps})`);
}

function extractThinkingChunks(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
  hasToolCalls: boolean
): string[] {
  const chunks: string[] = [];

  // 部分模型会把“思考”混在 content、reasoning 或扩展字段里，这里统一兜底提取。
  if (hasToolCalls && typeof message.content === "string") {
    pushUniqueChunk(chunks, message.content);
  }

  const extended = message as unknown as UnknownRecord;
  pushUniqueChunk(chunks, extended.reasoning_content);
  pushUniqueChunk(chunks, extended.reasoning_text);
  pushUniqueChunk(chunks, extractReasoningFromObject(extended.reasoning));

  if (Array.isArray(extended.content)) {
    for (const block of extended.content) {
      if (!block || typeof block !== "object") {
        continue;
      }

      const record = block as UnknownRecord;
      const type = asString(record.type);
      if (type === "reasoning" || type === "thinking") {
        pushUniqueChunk(chunks, record.text);
        pushUniqueChunk(chunks, record.content);
      }
    }
  }

  return chunks;
}

function extractReasoningFromObject(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as UnknownRecord;
  const direct = asString(record.content) ?? asString(record.text) ?? asString(record.summary);
  if (direct) {
    return direct;
  }

  if (Array.isArray(record.content)) {
    const merged = record.content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }

        const itemRecord = item as UnknownRecord;
        return asString(itemRecord.text) ?? asString(itemRecord.content) ?? "";
      })
      .filter(Boolean)
      .join("\n");

    return merged.length > 0 ? merged : undefined;
  }

  return undefined;
}

function pushUniqueChunk(chunks: string[], value: unknown) {
  const normalized = asString(value)?.trim();
  if (!normalized) {
    return;
  }

  if (!chunks.includes(normalized)) {
    chunks.push(normalized);
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
