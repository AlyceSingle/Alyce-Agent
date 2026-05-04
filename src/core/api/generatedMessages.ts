import type OpenAI from "openai";

export const ALYCE_READ_ATTACHMENT_MESSAGE_NAME = "alyce_read_attachment";

type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type UserMessageParam = OpenAI.Chat.Completions.ChatCompletionUserMessageParam;

export function createReadAttachmentMessage(
  content: ContentPart[]
): UserMessageParam {
  return {
    role: "user",
    name: ALYCE_READ_ATTACHMENT_MESSAGE_NAME,
    content
  };
}

export function isReadAttachmentMessage(message: MessageParam): boolean {
  return message.role === "user" && message.name === ALYCE_READ_ATTACHMENT_MESSAGE_NAME;
}

export function removeReadAttachmentMessages(messages: MessageParam[]) {
  const retained = messages.filter((message) => !isReadAttachmentMessage(message));
  if (retained.length === messages.length) {
    return;
  }

  messages.splice(0, messages.length, ...retained);
}
