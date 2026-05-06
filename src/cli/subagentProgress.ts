import type { SubagentProgressEvent } from "../tools/types.js";

export const MAX_SUBAGENT_PROGRESS_EVENTS = 100;
export const MAX_SUBAGENT_PROGRESS_MESSAGE_CHARS = 4_000;
export const MAX_SUBAGENT_PROGRESS_DETAIL_CHARS = 8_000;

export function normalizePersistedSubagentProgress(value: unknown): SubagentProgressEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(-MAX_SUBAGENT_PROGRESS_EVENTS)
    .flatMap((event) => {
      const normalized = normalizePersistedSubagentProgressEvent(event);
      return normalized ? [normalized] : [];
    });
}

export function truncateProgressText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function normalizePersistedSubagentProgressEvent(value: unknown): SubagentProgressEvent | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Partial<Record<keyof SubagentProgressEvent, unknown>>;
  if (typeof record.timestamp !== "string" || !isPersistedSubagentProgressEventType(record.type)) {
    return undefined;
  }

  return {
    timestamp: truncateProgressText(record.timestamp, MAX_SUBAGENT_PROGRESS_DETAIL_CHARS),
    type: record.type,
    ...(typeof record.message === "string"
      ? { message: truncateProgressText(record.message, MAX_SUBAGENT_PROGRESS_MESSAGE_CHARS) }
      : {}),
    ...(typeof record.toolName === "string"
      ? { toolName: truncateProgressText(record.toolName, MAX_SUBAGENT_PROGRESS_DETAIL_CHARS) }
      : {}),
    ...(typeof record.rawArguments === "string"
      ? { rawArguments: truncateProgressText(record.rawArguments, MAX_SUBAGENT_PROGRESS_DETAIL_CHARS) }
      : {}),
    ...(typeof record.result === "string"
      ? { result: truncateProgressText(record.result, MAX_SUBAGENT_PROGRESS_DETAIL_CHARS) }
      : {})
  };
}

function isPersistedSubagentProgressEventType(value: unknown): value is SubagentProgressEvent["type"] {
  return value === "thinking" ||
    value === "tool_start" ||
    value === "tool_result" ||
    value === "status";
}
