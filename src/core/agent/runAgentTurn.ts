import OpenAI from "openai";
import { executeToolCall, TOOL_SCHEMAS, type ToolExecutionContext } from "../../tools.js";
import { isTurnInterruptedError, throwIfAborted, toTurnInterruptedError } from "../abort.js";
import { extractAssistantTextContent } from "../api/assistantContent.js";
import { removeGeneratedContextMessages } from "../api/generatedMessages.js";
import {
  buildPatchedChatCompletionRequest,
  sendChatCompletion,
  type ChatCompletionReconnectEvent
} from "../api/sendChatCompletion.js";
import type { ChatCompletionTransport } from "../api/modelAdapters.js";
import type { RequestPatchOperation } from "../api/requestPatch.js";
import type { AgentQuerySource } from "./querySource.js";
import {
  ContextOverflowError,
  formatContextOverflowMessage,
  type ContextBudgetSnapshot,
  type ContextBudgetService,
  snipOversizedToolOutputs,
  type ToolOutputSnipResult
} from "../context/contextBudget.js";
import type { ResolvedModelProfile } from "../providers/types.js";
import type { UsageRecordInput, UsageSource } from "../usage/types.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type UnknownRecord = Record<string, unknown>;
const ASSISTANT_HISTORY_EXTENSION_KEYS = [
  "reasoning_content",
  "reasoning_text",
  "reasoning"
] as const;

// 单轮 Agent 执行采用“模型回复 -> 运行工具 -> 回填结果 -> 再次请求模型”的闭环。
export interface AgentTurnOptions {
  model: string;
  resolvedModel?: ResolvedModelProfile;
  maxSteps: number;
  context: ToolExecutionContext;
  querySource?: AgentQuerySource;
  gcliGeminiCompat?: boolean;
  requestPatches?: RequestPatchOperation[];
  abortSignal?: AbortSignal;
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  onThinking?: (content: string) => void;
  onToolCallStart?: (toolName: string, rawArguments: string) => void;
  onToolCallResult?: (toolName: string, result: string, rawArguments: string) => void;
  onMessagesAppended?: (messages: MessageParam[]) => void | Promise<void>;
  onReconnect?: (event: ChatCompletionReconnectEvent) => void;
  onUsage?: (event: UsageRecordInput) => void;
  usageSource?: UsageSource;
  usageTurnId?: string;
  usageTaskId?: string;
  usageLabel?: string;
  onContextBudget?: (snapshot: ContextBudgetSnapshot) => void;
  onContextCompactionStart?: (snapshot: ContextBudgetSnapshot) => void;
  onContextCompactionResult?: (event: {
    compacted: boolean;
    before: ContextBudgetSnapshot;
    after: ContextBudgetSnapshot;
    snipResult?: ToolOutputSnipResult;
  }) => void;
  contextBudgetService?: ContextBudgetService;
  preflightCompactConversation?: (options: {
    abortSignal?: AbortSignal;
    querySource: AgentQuerySource;
  }) => Promise<boolean>;
  refreshTools?: (options: { abortSignal?: AbortSignal }) => Promise<OpenAI.Chat.Completions.ChatCompletionTool[]>;
  messageTimestampsEnabled?: boolean;
}

export async function runAgentTurn(
  client: ChatCompletionTransport,
  messages: MessageParam[],
  options: AgentTurnOptions
): Promise<string> {
  try {
    let activeTools = options.tools ?? TOOL_SCHEMAS;
    // 工具轮次受 maxSteps 限制，避免模型无限循环调用工具。
    for (let step = 0; step < options.maxSteps; step += 1) {
      throwIfAborted(options.abortSignal);

      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        await preflightContextBudget(messages, options, activeTools);
        response = await sendChatCompletion(client, {
          model: options.model,
          resolvedModel: options.resolvedModel,
          messages,
          tools: activeTools,
          toolChoice: "auto",
          temperature: 0.2,
          gcliGeminiCompat: options.gcliGeminiCompat,
          messageTimestampsEnabled: options.messageTimestampsEnabled,
          requestPatches: options.requestPatches,
          abortSignal: options.abortSignal,
          onReconnect: options.onReconnect,
          onUsage: (event) => {
            options.onUsage?.({
              ...event,
              source: options.usageSource ?? querySourceToUsageSource(options.querySource),
              ...(options.usageTurnId ? { turnId: options.usageTurnId } : {}),
              ...(options.usageTaskId ? { taskId: options.usageTaskId } : {}),
              ...(options.usageLabel ? { label: options.usageLabel } : {})
            });
          }
        });
        options.contextBudgetService?.recordUsage(response.usage);
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

      if (toolCalls.length === 0) {
        const reply = extractAssistantReplyText(next);
        if (!reply) {
          throw new Error("Model returned no text output");
        }

        const assistantMessage = buildAssistantHistoryMessage(next);
        messages.push(assistantMessage);
        await options.onMessagesAppended?.([assistantMessage]);
        return reply;
      }

      const assistantHistoryMessage = buildAssistantHistoryMessage(next);
      const toolMessages: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];
      const supplementalMessages: MessageParam[] = [];

      const executedToolCalls = await executeToolCalls(toolCalls, options);
      toolMessages.push(...executedToolCalls.toolMessages);
      supplementalMessages.push(...executedToolCalls.supplementalMessages);

      // 只在全部工具结果都准备好后写入上下文，避免中断时留下没有 tool 结果的 assistant tool_calls。
      const committedMessages = [assistantHistoryMessage, ...toolMessages, ...supplementalMessages];
      messages.push(...committedMessages);
      await options.onMessagesAppended?.(committedMessages);

      if (options.refreshTools && shouldRefreshToolsAfterToolCalls(executedToolCalls.toolNames)) {
        try {
          activeTools = await options.refreshTools({
            abortSignal: options.abortSignal
          });
        } catch (error) {
          if (isTurnInterruptedError(error, options.abortSignal)) {
            throw toTurnInterruptedError(error, options.abortSignal);
          }

          const refreshFailureMessage = buildToolSchemaRefreshFailureMessage(error);
          const warningMessage: MessageParam = {
            role: "system",
            content: refreshFailureMessage
          };
          messages.push(warningMessage);
          await options.onMessagesAppended?.([warningMessage]);
        }
      }
    }
  } finally {
    removeGeneratedContextMessages(messages);
  }

  throw new Error(`Max tool steps reached (${options.maxSteps})`);
}

function querySourceToUsageSource(querySource: AgentQuerySource | undefined): UsageSource {
  switch (querySource) {
    case "subagent":
      return "subagent";
    case "compact":
      return "compact";
    case "session_memory":
      return "session_memory";
    case "main":
    default:
      return "main";
  }
}

async function preflightContextBudget(
  messages: MessageParam[],
  options: AgentTurnOptions,
  tools: OpenAI.Chat.Completions.ChatCompletionTool[]
) {
  const querySource = options.querySource ?? "main";
  if (querySource === "compact" || querySource === "session_memory") {
    return;
  }

  const budgetService = options.contextBudgetService;
  if (!budgetService) {
    return;
  }

  let request = buildAgentTurnRequest(messages, options, tools);
  const beforeSnip = budgetService.estimateRequest(request, {
    resolvedModel: options.resolvedModel
  });
  let snapshot = beforeSnip;
  options.onContextBudget?.(snapshot);

  const snipResult = snipOversizedToolOutputs(messages);
  if (snipResult.changed) {
    request = buildAgentTurnRequest(messages, options, tools);
    snapshot = budgetService.estimateRequest(request, {
      resolvedModel: options.resolvedModel
    });
    options.onContextBudget?.(snapshot);
  }

  if (snapshot.state !== "auto_compact" && snapshot.state !== "blocking") {
    if (snipResult.changed) {
      options.onContextCompactionResult?.({
        compacted: false,
        before: beforeSnip,
        after: snapshot,
        snipResult
      });
    }
    budgetService.estimateRequest(request, {
      recordForUsage: true,
      resolvedModel: options.resolvedModel
    });
    return;
  }

  const beforeCompaction = snapshot;
  let compacted = false;
  if (options.preflightCompactConversation) {
    options.onContextCompactionStart?.(beforeCompaction);
    compacted = await options.preflightCompactConversation({
      abortSignal: options.abortSignal,
      querySource
    });
    request = buildAgentTurnRequest(messages, options, tools);
    snapshot = budgetService.estimateRequest(request, {
      resolvedModel: options.resolvedModel
    });
    options.onContextBudget?.(snapshot);
    options.onContextCompactionResult?.({
      compacted,
      before: snipResult.changed ? beforeSnip : beforeCompaction,
      after: snapshot,
      snipResult: snipResult.changed ? snipResult : undefined
    });
  } else if (snipResult.changed) {
    options.onContextCompactionResult?.({
      compacted: false,
      before: beforeSnip,
      after: snapshot,
      snipResult
    });
  }

  if (snapshot.state === "blocking") {
    throw new ContextOverflowError(formatContextOverflowMessage(snapshot), snapshot);
  }

  budgetService.estimateRequest(request, {
    recordForUsage: true,
    resolvedModel: options.resolvedModel
  });
}

function buildAgentTurnRequest(
  messages: MessageParam[],
  options: AgentTurnOptions,
  tools: OpenAI.Chat.Completions.ChatCompletionTool[]
) {
  return buildPatchedChatCompletionRequest({
    model: options.model,
    resolvedModel: options.resolvedModel,
    messages,
    tools,
    toolChoice: "auto",
    temperature: 0.2,
    gcliGeminiCompat: options.gcliGeminiCompat,
    messageTimestampsEnabled: options.messageTimestampsEnabled,
    requestPatches: options.requestPatches
  });
}

const PARALLEL_SAFE_TOOL_NAMES = new Set([
  "TaskList",
  "TaskGet"
]);
const TOOL_SCHEMA_REFRESH_TOOL_NAMES = new Set([
  "McpStatus",
  "ListMcpResources",
  "ReadMcpResource"
]);

async function executeToolCalls(
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
  options: AgentTurnOptions
): Promise<{
  toolMessages: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[];
  supplementalMessages: MessageParam[];
  toolNames: string[];
}> {
  const toolMessages: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];
  const supplementalMessages: MessageParam[] = [];
  const toolNames: string[] = [];
  let index = 0;

  while (index < toolCalls.length) {
    throwIfAborted(options.abortSignal);
    const toolCall = toolCalls[index];
    if (!toolCall || toolCall.type !== "function") {
      index += 1;
      continue;
    }

    if (!PARALLEL_SAFE_TOOL_NAMES.has(toolCall.function.name)) {
      const result = await executeSingleToolCall(toolCall, options);
      toolMessages.push(result.toolMessage);
      supplementalMessages.push(...result.supplementalMessages);
      toolNames.push(toolCall.function.name);
      index += 1;
      continue;
    }

    const batch: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
    while (index < toolCalls.length) {
      const candidate = toolCalls[index];
      if (
        !candidate ||
        candidate.type !== "function" ||
        !PARALLEL_SAFE_TOOL_NAMES.has(candidate.function.name)
      ) {
        break;
      }

      batch.push(candidate);
      index += 1;
    }

    const batchResults = await Promise.all(batch.map((candidate) =>
      executeSingleToolCall(candidate, options)
    ));
    for (const result of batchResults) {
      toolMessages.push(result.toolMessage);
      supplementalMessages.push(...result.supplementalMessages);
      toolNames.push(result.toolName);
    }
  }

  return {
    toolMessages,
    supplementalMessages,
    toolNames
  };
}

async function executeSingleToolCall(
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  options: AgentTurnOptions
): Promise<{
  toolMessage: OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
  supplementalMessages: MessageParam[];
  toolName: string;
}> {
  throwIfAborted(options.abortSignal);
  options.onToolCallStart?.(toolCall.function.name, toolCall.function.arguments);

  let result: Awaited<ReturnType<typeof executeToolCall>>;
  try {
    result = await executeToolCall(
      toolCall.function.name,
      toolCall.function.arguments,
      options.context
    );
  } catch (error) {
    if (isTurnInterruptedError(error, options.abortSignal)) {
      throw toTurnInterruptedError(error, options.abortSignal);
    }

    throw error;
  }

  throwIfAborted(options.abortSignal);
  options.onToolCallResult?.(
    toolCall.function.name,
    result.displayResult,
    toolCall.function.arguments
  );

  return {
    toolName: toolCall.function.name,
    toolMessage: {
      role: "tool",
      tool_call_id: toolCall.id,
      content: result.displayResult
    },
    supplementalMessages: result.supplementalMessages
  };
}

function shouldRefreshToolsAfterToolCalls(toolNames: string[]) {
  return toolNames.some((toolName) => TOOL_SCHEMA_REFRESH_TOOL_NAMES.has(toolName));
}

function buildToolSchemaRefreshFailureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "Tool schema refresh failed after an MCP status/resource tool call.",
    "Continue with the previously available tool list unless the user asks to retry MCP initialization.",
    `Failure: ${message}`
  ].join("\n");
}

function buildAssistantHistoryMessage(
  message: OpenAI.Chat.Completions.ChatCompletionMessage
): MessageParam {
  const source = message as unknown as UnknownRecord;
  // 历史里只保留干净的 assistant 文本，避免把占位符或结构化噪声继续喂回下一轮请求。
  const normalizedContent = extractAssistantTextContent(source.content);
  const historyMessage: UnknownRecord = {
    role: "assistant",
    content: normalizedContent ?? ""
  };

  if (message.tool_calls !== undefined) {
    historyMessage.tool_calls = message.tool_calls;
  }

  if (message.function_call !== undefined) {
    historyMessage.function_call = message.function_call;
  }

  for (const key of ASSISTANT_HISTORY_EXTENSION_KEYS) {
    if (source[key] !== undefined) {
      historyMessage[key] = source[key];
    }
  }

  return historyMessage as unknown as MessageParam;
}

function extractAssistantReplyText(
  message: OpenAI.Chat.Completions.ChatCompletionMessage
): string | undefined {
  return extractAssistantTextContent((message as unknown as { content?: unknown }).content)?.trim();
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
    // 兼容结构化 content block，把 reasoning/thinking block 内的文本统一抽出来。
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
