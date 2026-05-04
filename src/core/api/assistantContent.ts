const ASSISTANT_TOOL_CALL_PLACEHOLDER = "(assistant requested a tool call)";

type UnknownRecord = Record<string, unknown>;

export { ASSISTANT_TOOL_CALL_PLACEHOLDER };

// 统一提取 assistant 的“可展示/可回填文本”，并剔除内部占位符与 reasoning block。
export function extractAssistantTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeAssistantText(value);
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const textParts = value.flatMap((part) => {
    if (!part || typeof part !== "object") {
      return [];
    }

    const record = part as UnknownRecord;
    if (isReasoningBlockType(asString(record.type))) {
      return [];
    }

    const text = asString(record.text) ?? asString(record.content);
    const normalized = normalizeAssistantText(text);
    return normalized ? [normalized] : [];
  });

  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function normalizeAssistantText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== ASSISTANT_TOOL_CALL_PLACEHOLDER)
    .join("\n")
    .trim();

  return normalized.length > 0 ? normalized : undefined;
}

function isReasoningBlockType(type: string | undefined): boolean {
  return type === "reasoning" || type === "thinking";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
