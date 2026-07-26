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
  extractMessageParts,
  extractMessageText,
  parseJsonObject,
  parseJsonResponse,
  type JsonRecord
} from "./nativeAdapterUtils.js";
import { asRecord as asRecordOrNull } from "../util/unknown.js";
import { readServerSentEvents } from "./sseStream.js";
import type { ChatCompletionStreamHandlers } from "./chatCompletionStream.js";

type GeminiPart =
  | { text: string; thought?: boolean }
  | { inlineData: { mimeType: string; data: string } }
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
      const streaming = Boolean(options.streamHandlers);
      const endpoint = buildGoogleGenerateContentUrl(
        options.resolvedModel.modelId,
        options.resolvedModel.apiKey ?? "",
        streaming
      );
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(googleRequest),
        signal: options.abortSignal
      });
      if (streaming && response.ok) {
        return consumeGoogleGenerateContentStream(response, {
          modelId: options.resolvedModel.modelId,
          handlers: options.streamHandlers,
          abortSignal: options.abortSignal
        });
      }
      return convertGoogleResponse(
        await parseJsonResponse(response),
        options.resolvedModel.modelId
      );
    }
  };
}

export function buildGoogleGenerateContentUrl(modelId: string, apiKey: string, streaming = false): string {
  const normalizedModelId = modelId.replace(/^models\//, "");
  const method = streaming ? "streamGenerateContent" : "generateContent";
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizedModelId)}:${method}`
  );
  if (streaming) {
    url.searchParams.set("alt", "sse");
  }
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
      const parts = toGeminiUserParts(message.content);
      appendGeminiContent(contents, "user", parts.length > 0 ? parts : [
        { text: "(empty user message)" }
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

export async function consumeGoogleGenerateContentStream(
  response: Response,
  options: {
    modelId: string;
    handlers?: ChatCompletionStreamHandlers;
    abortSignal?: AbortSignal;
  }
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  let content = "";
  let reasoningContent = "";
  let finishReason: unknown;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

  for await (const event of readServerSentEvents(response, options.abortSignal)) {
    const payload = asRecord(parseLooseJson(event.data));
    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    const firstCandidate = asRecord(candidates[0]);
    if (firstCandidate.finishReason !== undefined) {
      finishReason = firstCandidate.finishReason;
    }

    const usage = asRecord(payload.usageMetadata);
    if (numberValue(usage.promptTokenCount) > 0) {
      inputTokens = numberValue(usage.promptTokenCount);
    }
    if (numberValue(usage.candidatesTokenCount) > 0) {
      outputTokens = numberValue(usage.candidatesTokenCount);
    }
    if (numberValue(usage.totalTokenCount) > 0) {
      totalTokens = numberValue(usage.totalTokenCount);
    }

    const candidateContent = asRecord(firstCandidate.content);
    const parts = Array.isArray(candidateContent.parts) ? candidateContent.parts : [];
    for (const part of parts) {
      const partRecord = asRecord(part);
      if (typeof partRecord.text === "string" && partRecord.text.length > 0) {
        if (partRecord.thought === true) {
          reasoningContent += partRecord.text;
          options.handlers?.onThinkingDelta?.(partRecord.text);
        } else {
          content += partRecord.text;
          options.handlers?.onTextDelta?.(partRecord.text);
        }
        continue;
      }

      const functionCall = asRecord(partRecord.functionCall);
      if (typeof functionCall.name === "string") {
        toolCalls.push({
          id: `gemini_${toolCalls.length}_${functionCall.name}`,
          type: "function",
          function: {
            name: functionCall.name,
            arguments: JSON.stringify(functionCall.args ?? {})
          }
        });
      }
    }
  }

  return createChatCompletionResponse({
    id: "gemini-generate-content",
    model: options.modelId,
    content,
    reasoningContent,
    finishReason: mapGoogleFinishReason(finishReason),
    toolCalls,
    ...(inputTokens > 0 || outputTokens > 0 || totalTokens > 0
      ? {
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: totalTokens || inputTokens + outputTokens
          }
        }
      : {})
  });
}

function parseLooseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function toGeminiUserParts(content: unknown): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const part of extractMessageParts(content)) {
    if (part.kind === "text") {
      parts.push({ text: part.text });
      continue;
    }
    if (part.kind === "image" || part.kind === "file") {
      parts.push({ inlineData: { mimeType: part.mediaType, data: part.base64Data } });
      continue;
    }
    // Gemini inline requests cannot reference remote image URLs.
    parts.push({ text: `(image at ${part.url} was not inlined; this provider only accepts embedded image data)` });
  }

  return parts;
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
