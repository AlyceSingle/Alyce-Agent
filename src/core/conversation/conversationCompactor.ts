import OpenAI from "openai";
import { isTurnInterruptedError, toTurnInterruptedError } from "../abort.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface ConversationCompactionConfig {
  triggerMessageCount: number;
  keepRecentTurns: number;
  maxMessagesForSummary: number;
  maxCharsPerMessage: number;
}

export interface ConversationCompactionState {
  markdown: string;
  updatedAt: string;
}

export const DEFAULT_CONVERSATION_COMPACTION_CONFIG: ConversationCompactionConfig = {
  triggerMessageCount: 24,
  keepRecentTurns: 3,
  maxMessagesForSummary: 40,
  maxCharsPerMessage: 1_200
};

const COMPACTION_SUMMARY_TEMPLATE = [
  "# Current State",
  "",
  "# User Goal",
  "",
  "# Decisions",
  "",
  "# Active Files and Commands",
  "",
  "# Open Risks and Next Steps",
  ""
].join("\n");

export class ConversationCompactor {
  private state: ConversationCompactionState | null = null;

  constructor(private readonly config: ConversationCompactionConfig) {}

  clear() {
    this.state = null;
  }

  async maybeCompact(options: {
    client: OpenAI;
    model: string;
    messages: MessageParam[];
    abortSignal?: AbortSignal;
  }): Promise<boolean> {
    const firstConversationIndex = getFirstConversationMessageIndex(options.messages);
    const conversationMessages = options.messages.slice(firstConversationIndex);
    if (conversationMessages.length < this.config.triggerMessageCount) {
      return false;
    }

    const keepStartIndex = getKeepStartIndex(
      options.messages,
      firstConversationIndex,
      this.config.keepRecentTurns
    );
    if (keepStartIndex <= firstConversationIndex) {
      return false;
    }

    const archivedMessages = options.messages.slice(firstConversationIndex, keepStartIndex);
    if (archivedMessages.length === 0) {
      return false;
    }

    let markdown: string;
    try {
      markdown = await buildConversationCompactionSummary(options.client, {
        model: options.model,
        existingSummary: this.state?.markdown,
        messages: archivedMessages,
        maxMessagesForSummary: this.config.maxMessagesForSummary,
        maxCharsPerMessage: this.config.maxCharsPerMessage,
        abortSignal: options.abortSignal
      });
    } catch (error) {
      if (isTurnInterruptedError(error, options.abortSignal)) {
        throw toTurnInterruptedError(error, options.abortSignal);
      }

      return false;
    }

    this.state = {
      markdown,
      updatedAt: new Date().toISOString()
    };

    const rebuiltMessages: MessageParam[] = [
      options.messages[0]!,
      createCompactionSummaryMessage(this.state),
      ...options.messages.slice(keepStartIndex)
    ];
    options.messages.splice(0, options.messages.length, ...rebuiltMessages);

    return true;
  }
}

function getFirstConversationMessageIndex(messages: MessageParam[]) {
  let index = 0;
  while (index < messages.length && messages[index]?.role === "system") {
    index += 1;
  }

  return index;
}

function getKeepStartIndex(
  messages: MessageParam[],
  firstConversationIndex: number,
  keepRecentTurns: number
) {
  const userMessageIndexes: number[] = [];
  for (let index = firstConversationIndex; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") {
      userMessageIndexes.push(index);
    }
  }

  if (userMessageIndexes.length <= keepRecentTurns) {
    return firstConversationIndex;
  }

  return userMessageIndexes[userMessageIndexes.length - keepRecentTurns] ?? firstConversationIndex;
}

function createCompactionSummaryMessage(
  state: ConversationCompactionState
): OpenAI.Chat.Completions.ChatCompletionSystemMessageParam {
  return {
    role: "system",
    content: [
      "# Compacted Conversation Summary",
      `Updated at: ${state.updatedAt}`,
      "",
      state.markdown
    ].join("\n")
  };
}

async function buildConversationCompactionSummary(
  client: OpenAI,
  options: {
    model: string;
    existingSummary?: string;
    messages: MessageParam[];
    maxMessagesForSummary: number;
    maxCharsPerMessage: number;
    abortSignal?: AbortSignal;
  }
) {
  const conversationWindow = formatConversationWindow(
    options.messages,
    options.maxMessagesForSummary,
    options.maxCharsPerMessage
  );
  const response = await client.chat.completions.create(
    {
      model: options.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: [
            "You summarize older coding-agent conversation during context compaction.",
            "Merge the existing summary with the archived conversation segment.",
            "Output markdown only.",
            "Preserve the exact section headers in the template.",
            "Prefer durable engineering context over chatter.",
            "Do not hallucinate; say unknown when necessary."
          ].join(" ")
        },
        {
          role: "user",
          content: [
            "Update the compacted conversation summary with the archived conversation segment.",
            "",
            "## Existing Summary",
            options.existingSummary?.trim() || "(none)",
            "",
            "## Required Template",
            COMPACTION_SUMMARY_TEMPLATE,
            "",
            "## Archived Conversation Segment",
            conversationWindow || "(empty)"
          ].join("\n")
        }
      ]
    },
    {
      signal: options.abortSignal
    }
  );

  const content = response.choices[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("Conversation compaction returned empty content");
  }

  return content.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function formatConversationWindow(
  messages: MessageParam[],
  maxMessagesForSummary: number,
  maxCharsPerMessage: number
) {
  const sliced = messages.slice(-Math.max(1, maxMessagesForSummary));
  return sliced
    .map((message, index) => {
      const role = message.role.toUpperCase();
      const text = truncate(extractMessageText(message), maxCharsPerMessage);
      return `[${index + 1}] ${role}: ${text || "(empty)"}`;
    })
    .join("\n\n");
}

function extractMessageText(message: MessageParam) {
  if (message.role === "tool") {
    return typeof message.content === "string" ? message.content : "";
  }

  const content = (message as { content?: unknown }).content;
  const textParts: string[] = [];

  if (typeof content === "string") {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }

      const record = part as Record<string, unknown>;
      const text = record.text;
      if (typeof text === "string" && text.trim().length > 0) {
        textParts.push(text);
      }
    }
  }

  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    const toolNames = message.tool_calls.map((toolCall) => toolCall.function.name).join(", ");
    textParts.push(`Requested tools: ${toolNames}`);
  }

  return textParts.join("\n").trim();
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)} ...<truncated>`;
}
