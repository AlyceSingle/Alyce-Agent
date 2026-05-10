import type OpenAI from "openai";

export const ALYCE_READ_ATTACHMENT_MESSAGE_NAME = "alyce_read_attachment";
export const ALYCE_SKILL_CONTEXT_MESSAGE_NAME = "alyce_skill_context";
export const ALYCE_BACKGROUND_DIAGNOSTICS_MESSAGE_NAME = "alyce_background_diagnostics";

type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type UserMessageParam = OpenAI.Chat.Completions.ChatCompletionUserMessageParam;
type GeneratedContextContent = string | ContentPart[];

const ALYCE_GENERATED_CONTEXT_MESSAGE_NAMES = new Set([
  ALYCE_READ_ATTACHMENT_MESSAGE_NAME,
  ALYCE_SKILL_CONTEXT_MESSAGE_NAME,
  ALYCE_BACKGROUND_DIAGNOSTICS_MESSAGE_NAME
]);

export function createGeneratedContextMessage(
  name: string,
  content: GeneratedContextContent
): UserMessageParam {
  return {
    role: "user",
    name,
    content
  };
}

export function createReadAttachmentMessage(
  content: ContentPart[]
): UserMessageParam {
  return createGeneratedContextMessage(ALYCE_READ_ATTACHMENT_MESSAGE_NAME, content);
}

export function createSkillContextMessage(content: string): UserMessageParam {
  return createGeneratedContextMessage(ALYCE_SKILL_CONTEXT_MESSAGE_NAME, content);
}

export function createBackgroundDiagnosticsMessage(content: string): UserMessageParam {
  return createGeneratedContextMessage(ALYCE_BACKGROUND_DIAGNOSTICS_MESSAGE_NAME, content);
}

export function isGeneratedContextMessage(message: MessageParam): boolean {
  return message.role === "user" &&
    typeof message.name === "string" &&
    ALYCE_GENERATED_CONTEXT_MESSAGE_NAMES.has(message.name);
}

export function removeGeneratedContextMessages(messages: MessageParam[]) {
  const retained = messages.filter((message) => !isGeneratedContextMessage(message));
  if (retained.length === messages.length) {
    return;
  }

  messages.splice(0, messages.length, ...retained);
}
