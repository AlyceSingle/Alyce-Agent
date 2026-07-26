import type OpenAI from "openai";
import { asRecord, asString } from "../util/unknown.js";

export type JsonRecord = Record<string, unknown>;

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      const record = asRecord(part);
      if (!record) {
        return "";
      }

      return asString(record.text) ?? asString(record.content) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

export type NativeMessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; mediaType: string; base64Data: string }
  | { kind: "image-url"; url: string }
  | { kind: "file"; mediaType: string; base64Data: string; filename?: string };

export function extractMessageParts(content: unknown): NativeMessagePart[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const parts: NativeMessagePart[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record) {
      continue;
    }

    if (record.type === "image_url") {
      const imageUrl = asRecord(record.image_url);
      const url = imageUrl ? asString(imageUrl.url) : undefined;
      if (!url) {
        continue;
      }
      const parsed = parseBase64DataUrl(url);
      if (parsed) {
        parts.push({ kind: "image", mediaType: parsed.mediaType, base64Data: parsed.base64Data });
      } else {
        parts.push({ kind: "image-url", url });
      }
      continue;
    }

    if (record.type === "file") {
      const file = asRecord(record.file);
      const fileData = file ? asString(file.file_data) : undefined;
      const parsed = fileData ? parseBase64DataUrl(fileData) : undefined;
      if (parsed) {
        const filename = file ? asString(file.filename) : undefined;
        parts.push({
          kind: "file",
          mediaType: parsed.mediaType,
          base64Data: parsed.base64Data,
          ...(filename ? { filename } : {})
        });
      }
      continue;
    }

    const text = asString(record.text) ?? asString(record.content);
    if (text) {
      parts.push({ kind: "text", text });
    }
  }

  return parts;
}

export function parseBase64DataUrl(value: string): { mediaType: string; base64Data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
  if (!match?.[1] || match[2] === undefined) {
    return undefined;
  }

  return { mediaType: match[1], base64Data: match[2] };
}

export function parseJsonObject(value: string): JsonRecord {
  try {
    return asRecord(JSON.parse(value) as unknown) ?? {};
  } catch {
    return {};
  }
}

export function createChatCompletionResponse(options: {
  id: string;
  model: string;
  content: string;
  reasoningContent?: string;
  finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"];
  toolCalls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  usage?: OpenAI.Completions.CompletionUsage;
}): OpenAI.Chat.Completions.ChatCompletion {
  const message: OpenAI.Chat.Completions.ChatCompletionMessage & Record<string, unknown> = {
    role: "assistant",
    content: options.content,
    refusal: null,
    ...(options.toolCalls && options.toolCalls.length > 0
      ? { tool_calls: options.toolCalls }
      : {})
  };
  const reasoningContent = options.reasoningContent?.trim();
  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  return {
    id: options.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [
      {
        index: 0,
        finish_reason: options.finishReason,
        logprobs: null,
        message
      }
    ],
    ...(options.usage ? { usage: options.usage } : {})
  };
}

export function toOpenAIUsage(
  inputTokens: number,
  outputTokens: number,
  cacheTokens?: { cacheReadTokens?: number; cacheCreationTokens?: number }
): OpenAI.Completions.CompletionUsage {
  const cacheRead = cacheTokens?.cacheReadTokens ?? 0;
  const cacheCreation = cacheTokens?.cacheCreationTokens ?? 0;
  const usage: OpenAI.Completions.CompletionUsage & { cache_creation_tokens?: number } = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens
  };
  if (cacheRead > 0) {
    usage.prompt_tokens_details = { cached_tokens: cacheRead };
  }
  if (cacheCreation > 0) {
    usage.cache_creation_tokens = cacheCreation;
  }

  return usage;
}

export async function parseJsonResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) as unknown : {};
  if (!response.ok) {
    const message = extractProviderErrorMessage(parsed) ?? (raw || `HTTP ${response.status}`);
    const error = new Error(message) as Error & { status?: number; headers?: Headers };
    error.status = response.status;
    // 保留响应头，让重试逻辑能读取 Retry-After。
    error.headers = response.headers;
    throw error;
  }

  return parsed;
}

export const NATIVE_FETCH_HEADERS_TIMEOUT_MS = 120_000;

// 带"响应头超时"的 fetch：超过 timeoutMs 仍未收到响应头则失败（错误可重试）。
// 响应头到达后计时器解除，正文/SSE 读取只受外部 abortSignal 控制。
export async function fetchWithHeadersTimeout(
  url: string,
  init: Omit<RequestInit, "signal">,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? NATIVE_FETCH_HEADERS_TIMEOUT_MS;
  const outerSignal = options?.signal;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const timeoutError = new Error(
      `No response headers received within ${Math.round(timeoutMs / 1000)}s (connection timed out)`
    );
    timeoutError.name = "ConnectionTimeoutError";
    controller.abort(timeoutError);
  }, timeoutMs);

  const forwardAbort = () => {
    controller.abort(outerSignal?.reason);
  };
  if (outerSignal) {
    if (outerSignal.aborted) {
      forwardAbort();
    } else {
      outerSignal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", forwardAbort);
  }
}

export function extractProviderErrorMessage(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const error = record.error;
  if (typeof error === "string") {
    return error;
  }

  const errorRecord = asRecord(error);
  if (errorRecord) {
    const message = asString(errorRecord.message);
    if (message) {
      return message;
    }
    const type = asString(errorRecord.type);
    if (type) {
      return type;
    }
  }

  return asString(record.message);
}
