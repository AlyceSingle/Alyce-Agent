import type OpenAI from "openai";
import type { ResolvedModelProfile } from "../providers/types.js";
import type { ChatCompletionAdapter, ChatCreateParams } from "./modelAdapters.js";
import {
  getFunctionTools,
  isFunctionToolCall,
  type ChatCompletionFunctionTool
} from "./openaiFunctionTools.js";
import {
  createChatCompletionResponse,
  extractMessageText,
  parseJsonObject,
  parseJsonResponse,
  type JsonRecord
} from "./nativeAdapterUtils.js";
import { asRecord as asRecordOrNull } from "../util/unknown.js";

type GeminiPart =
  | { text: string; thought?: boolean }
  | { functionCall: { name: string; args: JsonRecord } }
  | { functionResponse: { name: string; response: JsonRecord } };

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiRequest = {
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description?: string;
      parameters?: unknown;
    }>;
  }>;
  toolConfig?: unknown;
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
};

export function createGoogleAdapter(
  resolvedModel: ResolvedModelProfile
): ChatCompletionAdapter {
  return {
    providerId: resolvedModel.providerId,
    modelId: resolvedModel.modelId,
    kind: resolvedModel.kind,
    sendChatCompletion: async (request, options) => {
      const googleRequest = buildGoogleRequest(request, options.resolvedModel);
      const endpoint = buildGoogleGenerateContentUrl(
        options.resolvedModel.modelId,
        options.resolvedModel.apiKey ?? ""
      );
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(googleRequest),
        signal: options.abortSignal
      });
      return convertGoogleResponse(
        await parseJsonResponse(response),
        options.resolvedModel.modelId
      );
    }
  };
}

export function buildGoogleGenerateContentUrl(modelId: string, apiKey: string): string {
  const normalizedModelId = modelId.replace(/^models\//, "");
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizedModelId)}:generateContent`
  );
  url.searchParams.set("key", apiKey);
  return url.toString();
}

export function buildGoogleRequest(
  request: ChatCreateParams,
  resolvedModel: ResolvedModelProfile
): GeminiRequest {
  const systemParts: Array<{ text: string }> = [];
  const contents: GeminiContent[] = [];
  const toolNameById = new Map<string, string>();

  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = extractMessageText(message.content);
      if (text) {
        systemParts.push({ text });
      }
      continue;
    }

    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];
      const text = extractMessageText(message.content);
      if (text) {
        parts.push({ text });
      }

      for (const toolCall of message.tool_calls ?? []) {
        if (!isFunctionToolCall(toolCall)) {
          continue;
        }

        toolNameById.set(toolCall.id, toolCall.function.name);
        parts.push({
          functionCall: {
            name: toolCall.function.name,
            args: parseJsonObject(toolCall.function.arguments)
          }
        });
      }

      appendGeminiContent(contents, "model", parts.length > 0 ? parts : [{ text: "" }]);
      continue;
    }

    if (message.role === "tool") {
      const toolName = toolNameById.get(message.tool_call_id) ?? "tool_result";
      appendGeminiContent(contents, "user", [
        {
          functionResponse: {
            name: toolName,
            response: {
              content: extractMessageText(message.content) || "(tool returned empty output)"
            }
          }
        }
      ]);
      continue;
    }

    if (message.role === "user") {
      appendGeminiContent(contents, "user", [
        { text: extractMessageText(message.content) || "(empty user message)" }
      ]);
      continue;
    }

    if (message.role === "function") {
      appendGeminiContent(contents, "user", [
        {
          text: `Function result (${message.name ?? "function"}): ${extractMessageText(message.content)}`
        }
      ]);
    }
  }

  return {
    contents,
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
    ...(getFunctionTools(request.tools).length > 0
      ? { tools: [{ functionDeclarations: getFunctionTools(request.tools).map(convertGoogleFunctionDeclaration) }] }
      : {}),
    ...(request.tool_choice ? { toolConfig: convertGoogleToolConfig(request.tool_choice) } : {}),
    generationConfig: {
      ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
      ...(resolvedModel.maxOutputTokens ? { maxOutputTokens: resolvedModel.maxOutputTokens } : {})
    }
  };
}

export function convertGoogleResponse(
  value: unknown,
  modelId: string
): OpenAI.Chat.Completions.ChatCompletion {
  const record = asRecord(value);
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  const firstCandidate = asRecord(candidates[0]);
  const content = asRecord(firstCandidate.content);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

  for (const [index, part] of parts.entries()) {
    const partRecord = asRecord(part);
    if (typeof partRecord.text === "string") {
      if (partRecord.thought === true) {
        reasoningParts.push(partRecord.text);
      } else {
        textParts.push(partRecord.text);
      }
      continue;
    }

    const functionCall = asRecord(partRecord.functionCall);
    if (typeof functionCall.name === "string") {
      toolCalls.push({
        id: `gemini_${index}_${functionCall.name}`,
        type: "function",
        function: {
          name: functionCall.name,
          arguments: JSON.stringify(functionCall.args ?? {})
        }
      });
    }
  }

  const usage = asRecord(record.usageMetadata);
  const inputTokens = numberValue(usage.promptTokenCount);
  const outputTokens = numberValue(usage.candidatesTokenCount);
  const totalTokens = numberValue(usage.totalTokenCount) || inputTokens + outputTokens;
  return createChatCompletionResponse({
    id: "gemini-generate-content",
    model: modelId,
    content: textParts.join("\n"),
    reasoningContent: reasoningParts.join("\n"),
    finishReason: mapGoogleFinishReason(firstCandidate.finishReason),
    toolCalls,
    ...(inputTokens > 0 || outputTokens > 0 || totalTokens > 0
      ? {
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: totalTokens
          }
        }
      : {})
  });
}

function appendGeminiContent(
  contents: GeminiContent[],
  role: "user" | "model",
  parts: GeminiPart[]
) {
  const previous = contents[contents.length - 1];
  if (previous?.role === role) {
    previous.parts.push(...parts);
    return;
  }

  contents.push({ role, parts });
}

function convertGoogleFunctionDeclaration(tool: ChatCompletionFunctionTool) {
  return {
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    ...(tool.function.parameters ? { parameters: sanitizeGoogleSchema(tool.function.parameters) } : {})
  };
}

function sanitizeGoogleSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeGoogleSchema);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const sanitized: JsonRecord = {};
  for (const [key, entryValue] of Object.entries(value as JsonRecord)) {
    if (key === "$schema" || key === "additionalProperties") {
      continue;
    }
    sanitized[key] = sanitizeGoogleSchema(entryValue);
  }

  return sanitized;
}

function convertGoogleToolConfig(toolChoice: ChatCreateParams["tool_choice"]) {
  if (toolChoice === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  if (toolChoice === "required") {
    return { functionCallingConfig: { mode: "ANY" } };
  }
  if (typeof toolChoice === "object" && toolChoice?.type === "function") {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolChoice.function.name]
      }
    };
  }

  return { functionCallingConfig: { mode: "AUTO" } };
}

function mapGoogleFinishReason(value: unknown): OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"] {
  switch (value) {
    case "MAX_TOKENS":
      return "length";
    case "STOP":
    case "SAFETY":
    case "RECITATION":
    case "OTHER":
    default:
      return "stop";
  }
}

function asRecord(value: unknown): JsonRecord {
  return asRecordOrNull(value) ?? {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
