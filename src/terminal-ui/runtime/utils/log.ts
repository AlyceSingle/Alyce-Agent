function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : JSON.stringify(error));
}

export function logError(error: unknown): void {
  const resolved = toError(error);
  const text = resolved.stack ?? resolved.message;

  try {
    process.stderr.write(`${text}\n`);
  } catch {
    // Ignore logging failures.
  }
}
