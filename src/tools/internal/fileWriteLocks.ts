import path from "node:path";

const locks = new Map<string, Promise<void>>();

export async function withFileWriteLock<T>(
  absolutePath: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = normalizeLockKey(absolutePath);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  locks.set(key, queued);

  await previous.catch(() => undefined);

  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) {
      locks.delete(key);
    }
  }
}

function normalizeLockKey(absolutePath: string) {
  const resolved = path.resolve(absolutePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
