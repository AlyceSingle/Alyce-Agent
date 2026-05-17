export function throwIfAuthCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new Error("Provider auth flow was cancelled.");
  }
}

export async function sleepWithAbort(
  sleepImpl: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal
) {
  throwIfAuthCancelled(signal);
  if (!signal) {
    await sleepImpl(ms);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new Error("Provider auth flow was cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    sleepImpl(ms).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
  throwIfAuthCancelled(signal);
}
