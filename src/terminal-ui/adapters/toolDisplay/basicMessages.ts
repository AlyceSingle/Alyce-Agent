import type { TerminalUiMessage } from "../../state/types.js";
import {
  createBlock,
  createMessage,
  STREAMING_MESSAGE_METADATA
} from "./common.js";

export function createSystemMessage(content: string, title = "System") {
  return createMessage({
    kind: "system",
    title,
    blocks: [createBlock(content)]
  });
}

export function createUserMessage(content: string) {
  return createMessage({
    kind: "user",
    title: "Prompt",
    blocks: [createBlock(content)]
  });
}

export function createAssistantMessage(
  content: string,
  options?: {
    id?: string;
    createdAt?: string;
    streaming?: boolean;
  }
) {
  const message = createMessage({
    kind: "assistant",
    title: "Response",
    blocks: [createBlock(content)],
    metadata: options?.streaming ? [STREAMING_MESSAGE_METADATA] : undefined
  });
  if (options?.id) {
    message.id = options.id;
  }
  if (options?.createdAt) {
    message.createdAt = options.createdAt;
  }
  return message;
}

export function isStreamingUiMessage(message: Pick<TerminalUiMessage, "metadata">): boolean {
  return message.metadata.includes(STREAMING_MESSAGE_METADATA);
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

export function shouldSkipThinkingContent(content: string) {
  return content.trim().length === 0;
}

export function shouldKeepUiMessage(message: TerminalUiMessage) {
  if (
    message.kind === "tool" &&
    (message.toolData?.phase === "start" || message.metadata.includes("Tool call"))
  ) {
    return false;
  }

  if (message.kind === "thinking" && shouldSkipThinkingContent(message.content)) {
    return false;
  }

  return true;
}

export function isEphemeralProgressMessage(message: TerminalUiMessage) {
  if (message.kind === "system" && message.title.trim().toLowerCase() === "progress") {
    return true;
  }

  return message.metadata.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized === "progress" || normalized.startsWith("progress:");
  });
}
