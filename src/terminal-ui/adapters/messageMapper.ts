import { randomUUID } from "node:crypto";
import type {
  TerminalUiMessage,
  TerminalUiMessageBlock,
  TerminalUiMessageBlockStyle,
  TerminalUiMessageBlockTone
} from "../state/types.js";

const DEFAULT_PREVIEW_MAX_CHARS = 320;
const TOOL_PREVIEW_MAX_CHARS = 520;

function normalizeContent(content: string) {
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : "(empty)";
}

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

function createBlock(
  content: string,
  options: {
    label?: string;
    tone?: TerminalUiMessageBlockTone;
    style?: TerminalUiMessageBlockStyle;
  } = {}
): TerminalUiMessageBlock {
  return {
    label: options.label,
    tone: options.tone ?? "default",
    style: options.style ?? "plain",
    content: normalizeContent(content)
  };
}

function serializeBlocks(blocks: TerminalUiMessageBlock[]) {
  return blocks
    .map((block) => {
      if (!block.label) {
        return block.content;
      }

      return `${block.label}\n${block.content}`;
    })
    .join("\n\n")
    .trim();
}

function createMessage(options: {
  kind: TerminalUiMessage["kind"];
  title: string;
  blocks: TerminalUiMessageBlock[];
  metadata?: string[];
  maxPreviewChars?: number;
}): TerminalUiMessage {
  const content = serializeBlocks(options.blocks) || "(empty)";
  const preview = truncateText(content, options.maxPreviewChars ?? DEFAULT_PREVIEW_MAX_CHARS);

  return {
    id: randomUUID(),
    kind: options.kind,
    title: options.title,
    blocks: options.blocks,
    content,
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
    blocks: [createBlock(content, { tone: "warning" })]
  });
}

export function createUserMessage(content: string) {
  return createMessage({
    kind: "user",
    title: "Prompt",
    blocks: [createBlock(content)]
  });
}

export function createAssistantMessage(content: string) {
  return createMessage({
    kind: "assistant",
    title: "Response",
    blocks: [createBlock(content)]
  });
}

export function createThinkingMessage(content: string) {
  return createMessage({
    kind: "thinking",
    title: "Reasoning",
    blocks: [createBlock(content, { tone: "muted" })]
  });
}

export function createErrorMessage(content: string) {
  return createMessage({
    kind: "error",
    title: "Failure",
    blocks: [createBlock(content, { tone: "danger" })]
  });
}

export function createToolStartMessage(toolName: string, rawArguments: string) {
  return createMessage({
    kind: "tool",
    title: toolName,
    blocks: [
      createBlock(rawArguments, {
        label: "Input",
        tone: "info",
        style: "code"
      })
    ],
    metadata: ["Tool call"],
    maxPreviewChars: TOOL_PREVIEW_MAX_CHARS
  });
}

export function createToolResultMessage(toolName: string, result: string) {
  return createMessage({
    kind: "tool",
    title: toolName,
    blocks: [
      createBlock(result, {
        label: "Output",
        tone: "success",
        style: "code"
      })
    ],
    metadata: ["Tool result"],
    maxPreviewChars: TOOL_PREVIEW_MAX_CHARS
  });
}
