import OpenAI from "openai";
import { extractAssistantTextContent } from "./assistantContent.js";
import { hasAssistantToolRequest } from "./openaiFunctionTools.js";
import {
  buildChatCompletionRequest,
  type ChatCompletionRequestOptions
} from "./chatCompletionRequest.js";
import { isContextOverflowError, toContextOverflowError } from "../context/contextBudget.js";
import { applyRequestPatchOperations, type RequestPatchOperation } from "./requestPatch.js";
import {
  isChatCompletionAdapter,
  type ChatCompletionTransport
} from "./modelAdapters.js";
import { TurnInterruptedError } from "../abort.js";
import type { ResolvedModelProfile } from "../providers/types.js";
import type { ModelUsageEvent } from "../usage/types.js";
import type { ChatCompletionStreamHandlers } from "./chatCompletionStream.js";
import { consumeOpenAIChatCompletionStream } from "./chatCompletionStream.js";

const RECONNECT_DELAY_MS = 10_000;
const MAX_RECONNECT_RETRIES = 7;
const EMPTY_MODEL_RESPONSE_ERROR_CODE = "EMPTY_MODEL_RESPONSE";
const NO_TEXT_OUTPUT_ERROR_CODE = "NO_TEXT_OUTPUT";

export type ChatCompletionReconnectEvent =
  | {
      type: "scheduled";
      attempt: number;
      maxRetries: number;
      retryDelayMs: number;
      errorMessage: string;
      statusCode?: number;
    }
  | {
      type: "recovered";
      attemptsUsed: number;
    };

export interface SendChatCompletionOptions extends ChatCompletionRequestOptions {
  resolvedModel?: ResolvedModelProfile;
  requestPatches?: RequestPatchOperation[];
  abortSignal?: AbortSignal;
  onReconnect?: (event: ChatCompletionReconnectEvent) => void;
  onUsage?: (event: ModelUsageEvent) => void;
  /** 文本/思考增量回调。传入后 OpenAI 兼容通道与原生 Anthropic/Google 通道均走 SSE 流式。 */
  streamHandlers?: ChatCompletionStreamHandlers;
}

export function buildPatchedChatCompletionRequest(
  options: ChatCompletionRequestOptions & {
    resolvedModel?: ResolvedModelProfile;
    requestPatches?: RequestPatchOperation[];
  }
) {
  const baseRequest = buildChatCompletionRequest({
    ...options,
    model: options.resolvedModel?.modelId ?? options.model
  });
  return applyRequestPatchOperations(baseRequest, options.requestPatches ?? []);
}

// 统一模型请求发送逻辑，支持请求标准化和 JSON Patch 二次改写。
export async function sendChatCompletion(
  transport: ChatCompletionTransport,
  options: SendChatCompletionOptions
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const patchedRequest = buildPatchedChatCompletionRequest(options);
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let retriesUsed = 0;

  while (true) {
    try {
      const response = await createChatCompletion(transport, patchedRequest, options);
      ensureResponseHasUsableAssistantOutput(response);

      if (retriesUsed > 0) {
        options.onReconnect?.({
          type: "recovered",
          attemptsUsed: retriesUsed
        });
      }

      notifyUsage(options, {
        requestedModel: options.model,
        resolvedModel: options.resolvedModel,
        usage: response.usage,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        retryCount: retriesUsed
      });

      return response;
    } catch (error) {
      if (isAbortLikeError(error, options.abortSignal)) {
        throw error;
      }

      if (isContextOverflowError(error)) {
        throw toContextOverflowError(error);
      }

      if (!shouldRetryChatCompletionError(error)) {
        throw error;
      }

      if (retriesUsed >= MAX_RECONNECT_RETRIES) {
        throw createReconnectExhaustedError(error, retriesUsed);
      }

      retriesUsed += 1;
      options.onReconnect?.({
        type: "scheduled",
        attempt: retriesUsed,
        maxRetries: MAX_RECONNECT_RETRIES,
        retryDelayMs: RECONNECT_DELAY_MS,
        errorMessage: getErrorMessage(error),
        statusCode: getErrorStatusCode(error)
      });
      await waitForReconnect(RECONNECT_DELAY_MS, options.abortSignal);
    }
  }
}

function notifyUsage(options: SendChatCompletionOptions, event: ModelUsageEvent) {
  try {
    options.onUsage?.(event);
  } catch {
    // Usage collection must never break a successful model response.
  }
}

async function createChatCompletion(
  transport: ChatCompletionTransport,
  request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  options: SendChatCompletionOptions
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  if (isChatCompletionAdapter(transport)) {
    if (!options.resolvedModel) {
      throw new Error("Resolved model profile is required when using a model adapter.");
    }

    return transport.sendChatCompletion(request, {
      resolvedModel: options.resolvedModel,
      abortSignal: options.abortSignal,
      streamHandlers: options.streamHandlers
    });
  }

  if (options.streamHandlers) {
    const stream = await transport.chat.completions.create(
      {
        ...request,
        stream: true
      },
      {
        signal: options.abortSignal
      }
    );
    return consumeOpenAIChatCompletionStream(stream, {
      model: request.model,
      handlers: options.streamHandlers,
      abortSignal: options.abortSignal
    });
  }

  return transport.chat.completions.create(request, {
    signal: options.abortSignal
  });
}

function ensureResponseHasUsableAssistantOutput(response: OpenAI.Chat.Completions.ChatCompletion) {
  const message = response.choices[0]?.message;
  if (!message) {
    throw createSyntheticRetryableError(
      "Model returned an empty response",
      EMPTY_MODEL_RESPONSE_ERROR_CODE
    );
  }

  if (hasAssistantToolRequest(message)) {
    return;
  }

  // 某些上游会返回 200，但 assistant 文本实际为空；这里把它提升为“可重试失败”。
  if (extractAssistantTextContent((message as unknown as { content?: unknown }).content)) {
    return;
  }

  throw createSyntheticRetryableError(
    "Model returned no text output",
    NO_TEXT_OUTPUT_ERROR_CODE
  );
}


function isAbortLikeError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" || /aborted|cancelled|canceled/i.test(error.message);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  const statusCode = getErrorStatusCode(error);
  if (statusCode !== undefined) {
    return `HTTP ${statusCode}`;
  }

  return String(error);
}

function getErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const { status } = error as { status?: unknown };
  return typeof status === "number" ? status : undefined;
}

function shouldRetryChatCompletionError(error: unknown): boolean {
  const statusCode = getErrorStatusCode(error);
  if (statusCode !== undefined) {
    return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const code = getErrorCode(error);
  if (code && RETRIABLE_ERROR_CODES.has(code)) {
    return true;
  }

  const name = error.name.toLowerCase();
  if (name.includes("timeout") || name.includes("connection")) {
    return true;
  }

  return /(timed?\s*out|timeout|network|fetch failed|socket hang up|connection (?:error|reset|closed|lost))/i.test(
    error.message
  );
}

function createReconnectExhaustedError(error: unknown, retriesUsed: number): TurnInterruptedError {
  return new TurnInterruptedError(
    "reconnect-exhausted",
    `Model request interrupted after ${retriesUsed} reconnect attempts failed. Last error: ${getErrorMessage(error)}`
  );
}

function getErrorCode(error: Error): string | undefined {
  const directCode = (error as Error & { code?: unknown }).code;
  if (typeof directCode === "string" && directCode.trim().length > 0) {
    return directCode.toUpperCase();
  }

  const causeCode = (error as Error & { cause?: { code?: unknown } }).cause?.code;
  if (typeof causeCode === "string" && causeCode.trim().length > 0) {
    return causeCode.toUpperCase();
  }

  return undefined;
}

const RETRIABLE_ERROR_CODES = new Set([
  EMPTY_MODEL_RESPONSE_ERROR_CODE,
  NO_TEXT_OUTPUT_ERROR_CODE,
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT"
]);

async function waitForReconnect(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
    return;
  }

  if (signal.aborted) {
    throw toAbortError(signal.reason);
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const handleAbort = () => {
      cleanup();
      reject(toAbortError(signal.reason));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", handleAbort);
    };

    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  if (typeof reason === "string" && reason.trim().length > 0) {
    return new Error(reason);
  }

  return new Error("Request aborted");
}

function createSyntheticRetryableError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
