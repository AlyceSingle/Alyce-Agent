const MAX_OUTPUT_CHARS = 12_000;

// 截断超长文本，保留前缀并标记被隐藏字符数。
export function truncate(value: string, maxChars = MAX_OUTPUT_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }

  const hiddenCount = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n...<truncated ${hiddenCount} chars>`;
}
