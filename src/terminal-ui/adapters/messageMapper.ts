import { randomUUID } from "node:crypto";
import type { TerminalUiMessage } from "../state/types.js";

const DEFAULT_PREVIEW_MAX_CHARS = 360;
const TOOL_PREVIEW_MAX_CHARS = 560;

function truncateText(content: string, maxChars: number) {
  if (content.length <= maxChars) {
    return {
      preview: content,
      isTruncated: false
    };
  }

  return {
    preview: content.slice(0, maxChars).trimEnd() + " ...",
    isTruncated: true
  };
}

function createMessage(options: {
  kind: TerminalUiMessage["kind"];
  title: string;
  content: string;
  metadata?: string[];
  maxPreviewChars?: number;
}): TerminalUiMessage {
  const normalizedContent = options.content.trim() || "(empty)";
  const preview = truncateText(normalizedContent, options.maxPreviewChars ?? DEFAULT_PREVIEW_MAX_CHARS);

  return {
    id: randomUUID(),
    kind: options.kind,
    title: options.title,
    content: normalizedContent,
    preview: preview.preview,
    metadata: options.metadata ?? [],
    createdAt: new Date().toISOString(),
    isTruncated: preview.isTruncated
  };
}

export function createSystemMessage(content: string, title = "System") {
  return createMessage({
    kind: "system",
    title,
    content
  });
}

export function createUserMessage(content: string) {
  return createMessage({
    kind: "user",
    title: "You",
    content
  });
}

export function createAssistantMessage(content: string) {
  return createMessage({
    kind: "assistant",
    title: "Alyce",
    content
  });
}

export function createThinkingMessage(content: string) {
  return createMessage({
    kind: "thinking",
    title: "Thinking",
    content
  });
}

export function createErrorMessage(content: string) {
  return createMessage({
    kind: "error",
    title: "Error",
    content
  });
}

export function createToolStartMessage(toolName: string, rawArguments: string) {
  return createMessage({
    kind: "tool",
    title: `Tool · ${toolName}`,
    content: rawArguments.trim() || "{}",
    metadata: ["Request payload"],
    maxPreviewChars: TOOL_PREVIEW_MAX_CHARS
  });
}

export function createToolResultMessage(toolName: string, result: string) {
  return createMessage({
    kind: "tool",
    title: `Result · ${toolName}`,
    content: result,
    metadata: ["Tool response"],
    maxPreviewChars: TOOL_PREVIEW_MAX_CHARS
  });
}
