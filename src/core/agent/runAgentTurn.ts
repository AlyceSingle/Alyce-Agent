import OpenAI from "openai";
import { executeToolCall, TOOL_SCHEMAS, type ToolExecutionContext } from "../../tools.js";
import { isTurnInterruptedError, throwIfAborted, toTurnInterruptedError } from "../abort.js";
import { extractAssistantTextContent } from "../api/assistantContent.js";
import { removeGeneratedContextMessages } from "../api/generatedMessages.js";
import {
  isFunctionToolCall,
  type ChatCompletionMessageFunctionToolCall
} from "../api/openaiFunctionTools.js";
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
  "reasoning",
  "reasoning_details",
  "thinking_content",
  "thinking_text",
  "thinking"
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
  /** 流式正文增量（每个 model step 可能多次调用）。 */
  onAssistantTextDelta?: (text: string) => void;
  /** 新的一轮模型请求开始前调用，便于 UI 重置流式气泡。 */
  onAssistantStreamStart?: () => void;
  /** 当前 model step 的流结束（完整 response 已组装）。 */
  onAssistantStreamEnd?: () => void;
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
        options.onAssistantStreamStart?.();
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
          // 仅在 UI 需要正文增量时开流；纯 onThinking 仍走非流式，避免测试/适配器 mock 不兼容。
          streamHandlers: options.onAssistantTextDelta
            ? {
                onTextDelta: options.onAssistantTextDelta,
                onThinkingDelta: options.onThinking
              }
            : undefined,
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
        options.onAssistantStreamEnd?.();
        options.contextBudgetService?.recordUsage(response.usage);
        // 用量校准后立刻刷新状态栏，避免一直卡在 preflight 的低估值。
        publishContextBudget(messages, options, activeTools);
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
      const thinkingChunks = extractThinkingChunks(next);
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
        // 最终回复写入后更新占用；否则状态栏会停在“本轮请求前”的百分比。
        publishContextBudget(messages, options, activeTools);
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
      // 工具结果常很大，提交后立即反映到 Context%，不要等下一轮 preflight。
      publishContextBudget(messages, options, activeTools);

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

// 仅刷新 UI 用的占用快照，不触发 snip/compact，也不改 calibration 记录点。
function publishContextBudget(
  messages: MessageParam[],
  options: AgentTurnOptions,
  tools: OpenAI.Chat.Completions.ChatCompletionTool[]
) {
  const budgetService = options.contextBudgetService;
  if (!budgetService || !options.onContextBudget) {
    return;
  }

  const querySource = options.querySource ?? "main";
  if (querySource === "compact" || querySource === "session_memory") {
    return;
  }

  const request = buildAgentTurnRequest(messages, options, tools);
  options.onContextBudget(
    budgetService.estimateRequest(request, {
      resolvedModel: options.resolvedModel
    })
  );
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
    if (!toolCall || !isFunctionToolCall(toolCall)) {
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

    const batch: ChatCompletionMessageFunctionToolCall[] = [];
    while (index < toolCalls.length) {
      const candidate = toolCalls[index];
      if (
        !candidate ||
        !isFunctionToolCall(candidate) ||
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
  toolCall: ChatCompletionMessageFunctionToolCall,
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
  message: OpenAI.Chat.Completions.ChatCompletionMessage
): string[] {
  const chunks: string[] = [];

  const extended = message as unknown as UnknownRecord;
  pushUniqueChunk(chunks, extended.reasoning_content);
  pushUniqueChunk(chunks, extended.reasoning_text);
  pushUniqueChunk(chunks, extended.thinking_content);
  pushUniqueChunk(chunks, extended.thinking_text);
  collectReasoningChunks(chunks, extended.reasoning);
  collectReasoningChunks(chunks, extended.reasoning_details);
  collectReasoningChunks(chunks, extended.thinking);

  if (Array.isArray(extended.content)) {
    // 兼容结构化 content block，只提取上游明确标记为 reasoning/thinking 的文本。
    for (const block of extended.content) {
      if (!block || typeof block !== "object") {
        continue;
      }

      const record = block as UnknownRecord;
      const type = asString(record.type)?.toLowerCase();
      if (isReasoningBlockType(type) || record.thought === true) {
        collectReasoningChunks(chunks, record);
      }
    }
  }

  return chunks;
}

function collectReasoningChunks(chunks: string[], value: unknown) {
  if (typeof value === "string") {
    pushUniqueChunk(chunks, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectReasoningChunks(chunks, item);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as UnknownRecord;
  pushUniqueChunk(chunks, record.text);
  pushUniqueChunk(chunks, record.content);
  pushUniqueChunk(chunks, record.summary);
  pushUniqueChunk(chunks, record.thinking);
  pushUniqueChunk(chunks, record.reasoning_content);
  pushUniqueChunk(chunks, record.reasoning_text);
  pushUniqueChunk(chunks, record.thinking_content);
  pushUniqueChunk(chunks, record.thinking_text);

  if (Array.isArray(record.content)) {
    collectReasoningChunks(chunks, record.content);
  }
}

function isReasoningBlockType(type: string | undefined) {
  return type === "reasoning" ||
    type === "thinking" ||
    type === "reasoning_content" ||
    type === "thinking_content" ||
    type === "reasoning_summary" ||
    type === "thinking_summary";
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
