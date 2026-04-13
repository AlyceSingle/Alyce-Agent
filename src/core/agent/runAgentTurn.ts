import OpenAI from "openai";
import { executeToolCall, TOOL_SCHEMAS, type ToolExecutionContext } from "../../tools.js";
import { sendChatCompletion } from "../api/sendChatCompletion.js";
import type { RequestPatchOperation } from "../api/requestPatch.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

type UnknownRecord = Record<string, unknown>;

export interface AgentTurnOptions {
  model: string;
  maxSteps: number;
  context: ToolExecutionContext;
  requestPatches?: RequestPatchOperation[];
  onThinking?: (content: string) => void;
  onToolCallStart?: (toolName: string, rawArguments: string) => void;
  onToolCallResult?: (toolName: string, result: string) => void;
}

// 执行单轮对话：允许模型在本轮内多次调用工具后再产出最终文本。
export async function runAgentTurn(
  client: OpenAI,
  messages: MessageParam[],
  options: AgentTurnOptions
): Promise<string> {
  // 循环上限用于防止工具调用链无限增长。
  for (let step = 0; step < options.maxSteps; step += 1) {
    const response = await sendChatCompletion(client, {
      model: options.model,
      messages,
      tools: TOOL_SCHEMAS,
      toolChoice: "auto",
      temperature: 0.2,
      requestPatches: options.requestPatches
    });

    const next = response.choices[0]?.message;
    if (!next) {
      throw new Error("Model returned an empty response");
    }

    const toolCalls = next.tool_calls ?? [];
    // thinking 优先展示：工具调用前的中间文本 + 供应商扩展字段。
    const thinkingChunks = extractThinkingChunks(next, toolCalls.length > 0);
    for (const chunk of thinkingChunks) {
      options.onThinking?.(chunk);
    }

    messages.push({
      role: "assistant",
      content: next.content ?? "",
      tool_calls: next.tool_calls
    });

    // 没有工具调用时，本轮可直接返回模型文本。
    if (toolCalls.length === 0) {
      return (next.content ?? "").trim() || "(No text output from model)";
    }

    for (const toolCall of toolCalls) {
      // 当前仅支持函数工具调用。
      if (toolCall.type !== "function") {
        continue;
      }

      options.onToolCallStart?.(toolCall.function.name, toolCall.function.arguments);
      const result = await executeToolCall(toolCall.function.name, toolCall.function.arguments, options.context);
      options.onToolCallResult?.(toolCall.function.name, result);

      // 将工具结果追加到消息历史，供模型继续推理。
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

  // 对于“先工具后答案”的步骤，assistant 的文本通常是中间思考或计划。
  if (hasToolCalls && typeof message.content === "string") {
    pushUniqueChunk(chunks, message.content);
  }

  const extended = message as unknown as UnknownRecord;
  pushUniqueChunk(chunks, extended.reasoning_content);
  pushUniqueChunk(chunks, extended.reasoning_text);
  pushUniqueChunk(chunks, extractReasoningFromObject(extended.reasoning));

  // 某些兼容网关会把内容块放在 content 数组里。
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
