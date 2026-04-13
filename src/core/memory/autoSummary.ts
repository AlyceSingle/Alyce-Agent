import OpenAI from "openai";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

type AutoSummaryOptions = {
  model: string;
  existingSummary?: string;
  messages: MessageParam[];
  windowMessages: number;
  maxCharsPerMessage: number;
};

const SUMMARY_TEMPLATE = [
  "# Current State",
  "",
  "# User Goal",
  "",
  "# Key Decisions",
  "",
  "# Files and Commands",
  "",
  "# Errors and Fixes",
  "",
  "# Next Steps",
  ""
].join("\n");

// 基于当前会话窗口生成自动摘要。
export async function buildAutoSessionSummary(
  client: OpenAI,
  options: AutoSummaryOptions
): Promise<string> {
  const conversationWindow = formatConversationWindow(
    options.messages,
    options.windowMessages,
    options.maxCharsPerMessage
  );

  const response = await client.chat.completions.create({
    model: options.model,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: [
          "You are a session memory summarizer for a coding agent.",
          "Your task is to update a concise and accurate session summary.",
          "Output markdown only.",
          "Preserve the exact section headers in the template.",
          "Do not hallucinate. If uncertain, explicitly say unknown.",
          "Focus on actionable engineering context for the next turn."
        ].join(" ")
      },
      {
        role: "user",
        content: [
          "Update the summary using the latest conversation window.",
          "Prefer concrete facts: files, commands, errors, fixes, pending work.",
          "",
          "## Existing Summary",
          options.existingSummary?.trim() || "(none)",
          "",
          "## Required Template",
          SUMMARY_TEMPLATE,
          "",
          "## Conversation Window",
          conversationWindow || "(empty)"
        ].join("\n")
      }
    ]
  });

  const content = response.choices[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Auto summary model returned empty content");
  }

  return normalizeSummaryMarkdown(content);
}

// 仅统计会话中可见消息（排除 system），用于更新阈值判断。
export function getConversationMessageCount(messages: MessageParam[]): number {
  return messages.filter((message) => message.role !== "system").length;
}

function formatConversationWindow(
  messages: MessageParam[],
  windowMessages: number,
  maxCharsPerMessage: number
): string {
  const sliced = messages.slice(-Math.max(1, windowMessages));

  return sliced
    .filter((message) => message.role !== "system")
    .map((message, index) => {
      const role = String(message.role).toUpperCase();
      const text = truncate(extractMessageText(message), maxCharsPerMessage);
      return `[${index + 1}] ${role}: ${text || "(empty)"}`;
    })
    .join("\n\n");
}

function extractMessageText(message: MessageParam): string {
  const content = (message as { content?: unknown }).content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object") {
          return "";
        }

        const record = block as Record<string, unknown>;
        const text = record.text;
        if (typeof text === "string") {
          return text;
        }

        const inline = record.content;
        return typeof inline === "string" ? inline : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function normalizeSummaryMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)} ...<truncated>`;
}
