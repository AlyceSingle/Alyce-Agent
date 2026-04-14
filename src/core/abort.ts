// 统一把 UI、fetch 和 SDK 产生的取消信号收敛为同一类中断错误。
export class TurnInterruptedError extends Error {
  readonly reason: string;

  constructor(reason = "aborted", message = "Request interrupted by user") {
    super(message);
    this.name = "TurnInterruptedError";
    this.reason = reason;
  }
}

export function getAbortReason(signal?: AbortSignal | null): string | undefined {
  if (!signal?.aborted) {
    return undefined;
  }

  if (typeof signal.reason === "string" && signal.reason.trim().length > 0) {
    return signal.reason;
  }

  if (signal.reason instanceof Error && signal.reason.message.trim().length > 0) {
    return signal.reason.message;
  }

  return "aborted";
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) {
    return;
  }

  throw new TurnInterruptedError(getAbortReason(signal) ?? "aborted");
}

export function isTurnInterruptedError(
  error: unknown,
  signal?: AbortSignal | null
): error is TurnInterruptedError {
  if (error instanceof TurnInterruptedError) {
    return true;
  }

  if (!signal?.aborted || !(error instanceof Error)) {
    return false;
  }

  // 上游库对取消的错误命名并不完全一致，这里按名称和消息做兼容判断。
  return (
    error.name === "AbortError" ||
    /abort|aborted|interrupt|cancelled|canceled/i.test(error.message)
  );
}

export function toTurnInterruptedError(
  error: unknown,
  signal?: AbortSignal | null
): TurnInterruptedError {
  // 对外只暴露标准化后的 TurnInterruptedError，减少调用方分支判断复杂度。
  if (error instanceof TurnInterruptedError) {
    return error;
  }

  if (error instanceof Error && isTurnInterruptedError(error, signal)) {
    return new TurnInterruptedError(getAbortReason(signal) ?? "aborted", error.message);
  }

  return new TurnInterruptedError(getAbortReason(signal) ?? "aborted");
}
