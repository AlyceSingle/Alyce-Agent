import { asString } from "../util/unknown.js";
type UnknownRecord = Record<string, unknown>;

// 统一提取 assistant 的“可展示/可回填文本”，并剔除 reasoning block。
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
    if (isReasoningBlockType(asString(record.type)) || record.thought === true) {
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

  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function isReasoningBlockType(type: string | undefined): boolean {
  const normalized = type?.toLowerCase();
  return normalized === "reasoning" ||
    normalized === "thinking" ||
    normalized === "reasoning_content" ||
    normalized === "thinking_content" ||
    normalized === "reasoning_summary" ||
    normalized === "thinking_summary";
}

