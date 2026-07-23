import type OpenAI from "openai";

export type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;
export type ChatCompletionFunctionTool = OpenAI.Chat.Completions.ChatCompletionFunctionTool;
export type ChatCompletionMessageToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
export type ChatCompletionMessageFunctionToolCall =
  OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;
export type FunctionParameters = NonNullable<ChatCompletionFunctionTool["function"]["parameters"]>;

export function isFunctionTool(
  tool: ChatCompletionTool
): tool is ChatCompletionFunctionTool {
  return tool.type === "function";
}

export function getFunctionTools(
  tools: readonly ChatCompletionTool[] | undefined
): ChatCompletionFunctionTool[] {
  return (tools ?? []).filter(isFunctionTool);
}

export function getFunctionToolName(tool: ChatCompletionTool | undefined): string | undefined {
  return tool && isFunctionTool(tool) ? tool.function.name : undefined;
}

export function getFunctionToolNames(
  tools: readonly ChatCompletionTool[] | undefined
): string[] {
  return getFunctionTools(tools).map((tool) => tool.function.name);
}

export function isFunctionToolCall(
  toolCall: ChatCompletionMessageToolCall
): toolCall is ChatCompletionMessageFunctionToolCall {
  return toolCall.type === "function";
}

export function getFunctionToolCalls(
  toolCalls: readonly ChatCompletionMessageToolCall[] | undefined
): ChatCompletionMessageFunctionToolCall[] {
  return (toolCalls ?? []).filter(isFunctionToolCall);
}

export function getFunctionToolCallName(
  toolCall: ChatCompletionMessageToolCall | undefined
): string | undefined {
  return toolCall && isFunctionToolCall(toolCall) ? toolCall.function.name : undefined;
}

export function getFunctionToolCallNames(
  toolCalls: readonly ChatCompletionMessageToolCall[] | undefined
): string[] {
  return getFunctionToolCalls(toolCalls).map((toolCall) => toolCall.function.name);
}

export function hasAssistantToolRequest(message: {
  tool_calls?: unknown;
  function_call?: unknown;
}): boolean {
  return (
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
    message.function_call !== undefined
  );
}

