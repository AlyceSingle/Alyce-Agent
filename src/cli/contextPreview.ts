import OpenAI from "openai";
import {
  buildPatchedChatCompletionRequest
} from "../core/api/sendChatCompletion.js";
import {
  formatContextBudgetReport,
  type ContextBudgetService
} from "../core/context/contextBudget.js";
import type { RequestPatchOperation } from "../core/api/requestPatch.js";
import { TOOL_SCHEMAS } from "../tools/registry.js";
import type { ResolvedModelProfile } from "../core/providers/types.js";

export function buildNextTurnContextPreview(options: {
  currentModel: string;
  resolvedModel?: ResolvedModelProfile;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  nextUserInput?: string;
  gcliGeminiCompat?: boolean;
  messageTimestampsEnabled?: boolean;
  currentRequestTimestamp?: string;
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[];
  requestPatches?: RequestPatchOperation[];
  contextBudgetService?: ContextBudgetService;
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
  const payloadPreview = buildPatchedChatCompletionRequest({
    model: options.currentModel,
    resolvedModel: options.resolvedModel,
    temperature: 0.2,
    toolChoice: "auto",
    tools: options.tools ?? TOOL_SCHEMAS,
    messages: nextMessages,
    gcliGeminiCompat: options.gcliGeminiCompat,
    messageTimestampsEnabled: options.messageTimestampsEnabled,
    currentRequestTimestamp: options.currentRequestTimestamp,
    requestPatches: options.requestPatches
  });

  const payloadJson = JSON.stringify(payloadPreview, null, 2);
  if (!options.contextBudgetService) {
    return payloadJson;
  }

  return [
    formatContextBudgetReport(options.contextBudgetService.estimateRequest(payloadPreview, {
      resolvedModel: options.resolvedModel
    })),
    "",
    "=== Request Payload ===",
    payloadJson
  ].join("\n");
}
