import OpenAI from "openai";
import { formatSystemDateTime } from "../time/systemTime.js";
import { applyRequestPatchOperations, type RequestPatchOperation } from "./requestPatch.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

type ChatCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
const RECONNECT_DELAY_MS = 10_000;
const MAX_RECONNECT_RETRIES = 5;

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

export interface SendChatCompletionOptions {
  model: string;
  messages: MessageParam[];
  tools: OpenAI.Chat.Completions.ChatCompletionTool[];
  temperature?: number;
  toolChoice?: ChatCreateParams["tool_choice"];
  gcliGeminiCompat?: boolean;
  messageTimestampsEnabled?: boolean;
  currentRequestTimestamp?: string;
  requestPatches?: RequestPatchOperation[];
  abortSignal?: AbortSignal;
  onReconnect?: (event: ChatCompletionReconnectEvent) => void;
}

function normalizeMessagesForApi(
  messages: MessageParam[],
  options: {
    gcliGeminiCompat: boolean;
    messageTimestampsEnabled: boolean;
    currentRequestTimestamp?: string;
  }
): MessageParam[] {
  const normalizedMessages = messages.map((message) => {
    if (
      message.role === "tool" &&
      typeof message.content === "string" &&
      message.content.trim().length === 0
    ) {
      return {
        ...message,
        content: "(tool returned empty output)"
      };
    }

    if (
      message.role === "assistant" &&
      message.tool_calls &&
      isNullishOrEmptyString(message.content)
    ) {
      return {
        ...message,
        content: options.gcliGeminiCompat ? "(assistant requested a tool call)" : ""
      };
    }

    return message;
  });

  if (!options.messageTimestampsEnabled) {
    return normalizedMessages;
  }

  const currentRequestTimestamp = options.currentRequestTimestamp ?? formatSystemDateTime(new Date());
  const timestampMessage: OpenAI.Chat.Completions.ChatCompletionSystemMessageParam = {
    role: "system",
    content: [
      "# Current System Time",
      `Authoritative local time for this request: ${currentRequestTimestamp}`,
      "Resolve words like today, yesterday, tomorrow, now, latest, currently, and recently against this timestamp.",
      "If timing is ambiguous or the user may be mistaken, state the exact date explicitly."
    ].join("\n")
  };

  let insertIndex = 0;
  while (insertIndex < normalizedMessages.length && normalizedMessages[insertIndex]?.role === "system") {
    insertIndex += 1;
  }

  return [
    ...normalizedMessages.slice(0, insertIndex),
    timestampMessage,
    ...normalizedMessages.slice(insertIndex)
  ];
}

export function buildChatCompletionRequest(
  options: Omit<SendChatCompletionOptions, "abortSignal" | "requestPatches" | "onReconnect">
): ChatCreateParams {
  return {
    model: options.model,
    messages: normalizeMessagesForApi(options.messages, {
      gcliGeminiCompat: options.gcliGeminiCompat ?? false,
      messageTimestampsEnabled: options.messageTimestampsEnabled ?? false,
      currentRequestTimestamp: options.currentRequestTimestamp
    }),
    tools: options.tools,
    tool_choice: options.toolChoice ?? "auto",
    temperature: options.temperature ?? 0.2
  };
}

// 统一模型请求发送逻辑，支持请求标准化和 JSON Patch 二次改写。
export async function sendChatCompletion(
  client: OpenAI,
  options: SendChatCompletionOptions
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const baseRequest = buildChatCompletionRequest(options);
  const patchedRequest = applyRequestPatchOperations(baseRequest, options.requestPatches ?? []);
  let retriesUsed = 0;

  while (true) {
    try {
      const response = await client.chat.completions.create(patchedRequest, {
        signal: options.abortSignal
      });

      if (retriesUsed > 0) {
        options.onReconnect?.({
          type: "recovered",
          attemptsUsed: retriesUsed
        });
      }

      return response;
    } catch (error) {
      if (isAbortLikeError(error, options.abortSignal)) {
        throw error;
      }

      if (!shouldRetryChatCompletionError(error)) {
        throw error;
      }

      if (retriesUsed >= MAX_RECONNECT_RETRIES) {
        throw error;
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

function isNullishOrEmptyString(value: unknown): boolean {
  if (value == null) {
    return true;
  }

  return typeof value === "string" && value.trim().length === 0;
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
