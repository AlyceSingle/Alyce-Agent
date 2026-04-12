import OpenAI from "openai";
import { executeToolCall, TOOL_SCHEMAS, type ToolExecutionContext } from "../../tools.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface AgentTurnOptions {
  model: string;
  maxSteps: number;
  context: ToolExecutionContext;
}

export async function runAgentTurn(
  client: OpenAI,
  messages: MessageParam[],
  options: AgentTurnOptions
): Promise<string> {
  for (let step = 0; step < options.maxSteps; step += 1) {
    const response = await client.chat.completions.create({
      model: options.model,
      messages,
      tools: TOOL_SCHEMAS,
      tool_choice: "auto",
      temperature: 0.2
    });

    const next = response.choices[0]?.message;
    if (!next) {
      throw new Error("Model returned an empty response");
    }

    messages.push({
      role: "assistant",
      content: next.content ?? "",
      tool_calls: next.tool_calls
    });

    const toolCalls = next.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return (next.content ?? "").trim() || "(No text output from model)";
    }

    for (const toolCall of toolCalls) {
      if (toolCall.type !== "function") {
        continue;
      }

      const result = await executeToolCall(toolCall.function.name, toolCall.function.arguments, options.context);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result
      });
    }
  }

  throw new Error(`Max tool steps reached (${options.maxSteps})`);
}
