const MAX_OUTPUT_CHARS = 12_000;

// 安全地提取字符串参数，非字符串统一返回 undefined。
export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// 仅接受有限数字，并约束为不小于 1 的整数。
export function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
}

// 截断超长文本，保留前缀并标记被隐藏字符数。
export function truncate(value: string, maxChars = MAX_OUTPUT_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }

  const hiddenCount = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...<truncated ${hiddenCount} chars>`;
}
