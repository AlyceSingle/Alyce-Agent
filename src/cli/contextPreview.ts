import OpenAI from "openai";
import { TOOL_SCHEMAS } from "../tools/registry.js";

export function printNextTurnContextPreview(options: {
  currentModel: string;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  nextUserInput?: string;
}) {
  const nextMessages =
    options.nextUserInput && options.nextUserInput.trim().length > 0
      ? [
          ...options.messages,
          {
            role: "user" as const,
            content: options.nextUserInput.trim()
          }
        ]
      : options.messages;

  const payloadPreview = {
    model: options.currentModel,
    temperature: 0.2,
    tool_choice: "auto" as const,
    tools: TOOL_SCHEMAS,
    messages: nextMessages
  };

  console.log("\n=== Next Turn Context Preview ===");
  console.log(JSON.stringify(payloadPreview, null, 2));
  console.log("=== End Context Preview ===\n");
}
