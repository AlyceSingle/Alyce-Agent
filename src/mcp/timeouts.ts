import { getAbortReason, throwIfAborted, TurnInterruptedError } from "../core/abort.js";
import type { McpServerConnectionState } from "./types.js";
import type { McpServerRuntime } from "./runtimeTypes.js";
import {
  DEFAULT_MCP_OPERATION_TIMEOUT_MS,
  DEFAULT_MCP_STARTUP_TIMEOUT_MS,
  MCP_CLOSE_TIMEOUT_MS
} from "./runtimeTypes.js";

// 超时 / abort / 操作跟踪与错误归类。

export type McpTimeoutKind = "connect" | "list" | "call" | "read" | "close";

export function resolveMcpTimeout(
  server: McpServerRuntime,
  kind: McpTimeoutKind,
  overrideMs?: number
): number {
  if (overrideMs !== undefined) {
    return Math.max(1, Math.trunc(overrideMs));
  }

  switch (kind) {
    case "connect":
      return server.config.connect_timeout_ms ??
        server.config.startup_timeout_ms ??
        DEFAULT_MCP_STARTUP_TIMEOUT_MS;
    case "list":
      return server.config.list_timeout_ms ??
        server.config.startup_timeout_ms ??
        DEFAULT_MCP_STARTUP_TIMEOUT_MS;
    case "call":
      return server.config.call_timeout_ms ?? DEFAULT_MCP_OPERATION_TIMEOUT_MS;
    case "read":
      return server.config.read_timeout_ms ?? DEFAULT_MCP_OPERATION_TIMEOUT_MS;
    case "close":
      return server.config.close_timeout_ms ?? MCP_CLOSE_TIMEOUT_MS;
  }
}

export async function trackServerOperation<T>(
  server: McpServerRuntime,
  operation: string,
  timeoutMs: number,
  execute: () => Promise<T>
): Promise<T> {
  server.lastOperation = operation;
  server.lastOperationStartedAt = new Date().toISOString();
  server.lastTimeoutMs = timeoutMs;
  try {
    const result = await execute();
    server.lastOperationCompletedAt = new Date().toISOString();
    return result;
  } catch (error) {
    server.lastErrorAt = new Date().toISOString();
    server.recentError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  options: { abortSignal?: AbortSignal; onTimeoutOrAbort?: () => void } = {}
): Promise<T> {
  throwIfAborted(options.abortSignal);
  let timer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      options.onTimeoutOrAbort?.();
      reject(new Error(message));
    }, timeoutMs);
  });
  const candidates: Array<Promise<T> | Promise<never>> = [promise, timeout];

  const abortSignal = options.abortSignal;
  if (abortSignal) {
    candidates.push(new Promise<never>((_resolve, reject) => {
      abortHandler = () => {
        options.onTimeoutOrAbort?.();
        reject(createAbortRaceError(abortSignal));
      };
      abortSignal.addEventListener("abort", abortHandler, { once: true });
    }));
  }

  return Promise.race(candidates).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
    if (abortHandler && abortSignal) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  });
}

export function withAbort<T>(promise: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  throwIfAborted(abortSignal);
  if (!abortSignal) {
    return promise;
  }

  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortHandler = () => {
      reject(createAbortRaceError(abortSignal));
    };
    abortSignal.addEventListener("abort", abortHandler, { once: true });
  });

  return Promise.race([promise, aborted]).finally(() => {
    if (abortHandler) {
      abortSignal.removeEventListener("abort", abortHandler);
    }
  });
}

export function createAbortRaceError(abortSignal: AbortSignal): Error {
  if (abortSignal.reason instanceof Error) {
    return abortSignal.reason;
  }

  return new TurnInterruptedError(getAbortReason(abortSignal) ?? "aborted");
}

export function truncate(value: string, maxChars: number) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

export function appendErrorChunk(chunks: string[], chunk: string) {
  chunks.push(chunk);
  if (chunks.join("").length > 4000) {
    chunks.splice(0, chunks.length - 8);
  }
}

export function buildRuntimeErrorMessage(error: unknown, errorChunks: string[]) {
  const message = error instanceof Error ? error.message : String(error);
  const details = errorChunks.join("").trim();
  return details ? `${message}\n${truncate(details, 1200)}` : message;
}

export function classifyErrorStatus(message: string): McpServerConnectionState {
  return /401|403|auth|unauthori[sz]ed|forbidden/i.test(message)
    ? "auth_required"
    : "failed";
}
