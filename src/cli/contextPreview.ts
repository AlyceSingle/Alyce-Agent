import OpenAI from "openai";
import type { SessionMessageTimestampMetadata } from "../core/conversation/messageMetadata.js";
import { buildChatCompletionRequest } from "../core/api/sendChatCompletion.js";
import { TOOL_SCHEMAS } from "../tools/registry.js";

export function buildNextTurnContextPreview(options: {
  currentModel: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  nextUserInput?: string;
  gcliGeminiCompat?: boolean;
  messageTimestampsEnabled?: boolean;
  currentRequestTimestamp?: string;
  getMessageTimestampMetadata?: (
    message: OpenAI.Chat.Completions.ChatCompletionMessageParam,
    index: number
  ) => SessionMessageTimestampMetadata | undefined;
}) {
  // 支持模拟“下一条用户输入”，用于预览模型实际收到的 messages。
  const nextMessages =
    options.nextUserInput && options.nextUserInput.trim().length > 0
      ? [
          ...options.messages,
          {
            role: "user" as const,
            content: options.nextUserInput.trim()
          }
        ]
      : options.messages;

  // 与实际调用保持字段一致，确保预览结果可直接对照请求。
  const payloadPreview = buildChatCompletionRequest({
    model: options.currentModel,
    temperature: 0.2,
    toolChoice: "auto",
    tools: TOOL_SCHEMAS,
    messages: nextMessages,
    gcliGeminiCompat: options.gcliGeminiCompat,
    messageTimestampsEnabled: options.messageTimestampsEnabled,
    currentRequestTimestamp: options.currentRequestTimestamp,
    getMessageTimestampMetadata: options.getMessageTimestampMetadata
  });

  return JSON.stringify(payloadPreview, null, 2);
}

// 打印下一轮请求 payload，便于排查上下文拼装问题。
export function printNextTurnContextPreview(options: {
  currentModel: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  nextUserInput?: string;
}) {
  console.log("\n=== Next Turn Context Preview ===");
  console.log(buildNextTurnContextPreview(options));
  console.log("=== End Context Preview ===\n");
}
