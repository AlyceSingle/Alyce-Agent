import type OpenAI from "openai";
import { formatCurrentDateLabel } from "../../../core/time/systemTime.js";

export type SessionMessageLike = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function getCurrentDateLabel(now = new Date()) {
  // 不用 UTC 截日，避免本地时间接近零点时把 prompt 里的日期算错一天。
  return formatCurrentDateLabel(now);
}

export function messagesContainPrefix(
  currentMessages: readonly SessionMessageLike[],
  expectedPrefix: readonly SessionMessageLike[]
) {
  if (currentMessages.length < expectedPrefix.length) {
    return false;
  }

  for (let index = 0; index < expectedPrefix.length; index += 1) {
    const current = currentMessages[index];
    const expected = expectedPrefix[index];
    if (current === expected) {
      continue;
    }
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      return false;
    }
  }

  return true;
}
