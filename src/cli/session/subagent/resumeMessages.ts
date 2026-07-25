import OpenAI from "openai";
import { extractAssistantTextContent } from "../../../core/api/assistantContent.js";
import { cloneJson } from "../../../core/json/clone.js";

export type ResumeMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type AssistantToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;

const RESUMABLE_ROLES = new Set<ResumeMessage["role"]>(["system", "user", "assistant", "tool"]);

export function prepareResumableSubagentMessages(messages: ResumeMessage[]): ResumeMessage[] {
  const clonedMessages = messages.map((message) => cloneJson(message));
  const roleFiltered = clonedMessages.filter((message) => RESUMABLE_ROLES.has(message.role));
  const withoutOrphanedTools = filterOrphanedToolMessages(roleFiltered);
  const withoutUnresolvedToolUses = filterUnresolvedAssistantToolUses(withoutOrphanedTools);
  return withoutUnresolvedToolUses.filter(isResumableMessage);
}

function filterOrphanedToolMessages(messages: ResumeMessage[]): ResumeMessage[] {
  const declaredToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") {
      continue;
    }

    for (const toolCall of getAssistantToolCalls(message)) {
      declaredToolCallIds.add(toolCall.id);
    }
  }

  return messages.filter((message) => {
    if (message.role !== "tool") {
      return true;
    }

    const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id;
    return typeof toolCallId === "string" && declaredToolCallIds.has(toolCallId);
  });
}

function filterUnresolvedAssistantToolUses(messages: ResumeMessage[]): ResumeMessage[] {
  const resolvedToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }

    const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id;
    if (typeof toolCallId === "string") {
      resolvedToolCallIds.add(toolCallId);
    }
  }

  const filtered: ResumeMessage[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") {
      filtered.push(message);
      continue;
    }

    const toolCalls = getAssistantToolCalls(message);
    if (toolCalls.length === 0) {
      filtered.push(message);
      continue;
    }

    const resolvedToolCalls = toolCalls.filter((toolCall) => resolvedToolCallIds.has(toolCall.id));
    if (resolvedToolCalls.length === 0) {
      continue;
    }

    if (resolvedToolCalls.length === toolCalls.length) {
      filtered.push(message);
      continue;
    }

    // 只保留已配对成功的 tool_calls，避免 resume 时继续携带悬空调用。
    const patchedMessage = {
      ...message,
      tool_calls: resolvedToolCalls
    } as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    filtered.push(patchedMessage);
  }

  return filtered;
}

function isResumableMessage(message: ResumeMessage): boolean {
  if (message.role === "assistant") {
    const toolCalls = getAssistantToolCalls(message);
    if (toolCalls.length > 0) {
      return true;
    }

    // 过滤掉纯空白或只含 thinking/reasoning 的 assistant 消息。
    const text = extractAssistantTextContent((message as { content?: unknown }).content);
    return typeof text === "string" && text.trim().length > 0;
  }

  if (message.role === "tool") {
    const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id;
    return typeof toolCallId === "string" && toolCallId.length > 0;
  }

  return true;
}

function getAssistantToolCalls(message: ResumeMessage): AssistantToolCall[] {
  if (message.role !== "assistant") {
    return [];
  }

  const raw = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter(isAssistantToolCall);
}

function isAssistantToolCall(value: unknown): value is AssistantToolCall {
  if (!value || typeof value !== "object") {
    return false;
  }

  return typeof (value as { id?: unknown }).id === "string";
}
