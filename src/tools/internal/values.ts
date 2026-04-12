const MAX_OUTPUT_CHARS = 12_000;

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
}

export function truncate(value: string, maxChars = MAX_OUTPUT_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }

  const hiddenCount = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...<truncated ${hiddenCount} chars>`;
}
