import { extractChatMessageText } from "../api/messageText.js";
import type OpenAI from "openai";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type UnknownRecord = Record<string, unknown>;

export interface SessionMemoryTriggerConfig {
  enabled: boolean;
  initialTokens: number;
  updateTokens: number;
  toolCallsBetweenUpdates: number;
}

export interface SessionMemoryTriggerState {
  initialized: boolean;
  tokensAtLastExtraction: number;
  lastExtractionMessageIndex?: number;
  lastExtractionMessageMarker?: string;
  lastExtractionAt?: string;
}

export type SessionMemoryTriggerDecisionReason =
  | "should_extract"
  | "disabled"
  | "empty_conversation"
  | "below_initial_tokens"
  | "below_update_tokens"
  | "waiting_for_tool_calls_or_break";

export interface SessionMemoryTriggerDecision {
  shouldExtract: boolean;
  reason: SessionMemoryTriggerDecisionReason;
  currentTokens: number;
  tokenDelta: number;
  toolCallsSinceLastExtraction: number;
  lastAssistantTurnHasToolCalls: boolean;
  initialized: boolean;
}

export const DEFAULT_SESSION_MEMORY_TRIGGER_CONFIG: SessionMemoryTriggerConfig = {
  enabled: true,
  initialTokens: 10_000,
  updateTokens: 5_000,
  toolCallsBetweenUpdates: 3
};

export class SessionMemoryTrigger {
  private state: SessionMemoryTriggerState = createInitialState();
  private config: SessionMemoryTriggerConfig;

  constructor(config: Partial<SessionMemoryTriggerConfig> = {}) {
    this.config = normalizeConfig({
      ...DEFAULT_SESSION_MEMORY_TRIGGER_CONFIG,
      ...config
    });
  }

  updateConfig(config: Partial<SessionMemoryTriggerConfig>) {
    this.config = normalizeConfig({
      ...this.config,
      ...config
    });
  }

  clear() {
    this.state = createInitialState();
  }

  createSnapshot(): SessionMemoryTriggerState {
    return { ...this.state };
  }

  restoreSnapshot(snapshot: SessionMemoryTriggerState | null | undefined) {
    this.state = snapshot ? normalizeState(snapshot) : createInitialState();
  }

  shouldExtract(options: {
    messages: readonly MessageParam[];
    currentTokens: number;
  }): SessionMemoryTriggerDecision {
    const currentTokens = normalizePositiveInteger(options.currentTokens, 0);
    const emptyConversation = !options.messages.some((message) => message.role !== "system");
    const initialized = this.state.initialized ||
      currentTokens >= this.config.initialTokens;
    const tokenDelta = this.state.initialized
      ? currentTokens - this.state.tokensAtLastExtraction
      : currentTokens;
    const toolCallsSinceLastExtraction = countToolCallsSince(
      options.messages,
      this.state
    );
    const lastAssistantTurnHasToolCalls = hasToolCallsInLastAssistantTurn(options.messages);
    const baseDecision = {
      currentTokens,
      tokenDelta,
      toolCallsSinceLastExtraction,
      lastAssistantTurnHasToolCalls,
      initialized
    };

    if (!this.config.enabled) {
      return {
        ...baseDecision,
        shouldExtract: false,
        reason: "disabled"
      };
    }

    if (emptyConversation) {
      return {
        ...baseDecision,
        shouldExtract: false,
        reason: "empty_conversation"
      };
    }

    if (!initialized) {
      return {
        ...baseDecision,
        shouldExtract: false,
        reason: "below_initial_tokens"
      };
    }

    const metTokenThreshold = this.state.initialized
      ? tokenDelta >= this.config.updateTokens
      : currentTokens >= this.config.initialTokens;

    if (!metTokenThreshold) {
      return {
        ...baseDecision,
        shouldExtract: false,
        reason: "below_update_tokens"
      };
    }

    const metToolCallThreshold =
      toolCallsSinceLastExtraction >= this.config.toolCallsBetweenUpdates;
    const atNaturalBreak = !lastAssistantTurnHasToolCalls;

    if (!metToolCallThreshold && !atNaturalBreak) {
      return {
        ...baseDecision,
        shouldExtract: false,
        reason: "waiting_for_tool_calls_or_break"
      };
    }

    return {
      ...baseDecision,
      shouldExtract: true,
      reason: "should_extract"
    };
  }

  recordExtraction(options: {
    messages: readonly MessageParam[];
    currentTokens: number;
    now?: Date;
  }) {
    const lastIndex = options.messages.length - 1;
    const lastMessage = options.messages[lastIndex];
    this.state = {
      initialized: true,
      tokensAtLastExtraction: normalizePositiveInteger(options.currentTokens, 0),
      ...(lastIndex >= 0 ? { lastExtractionMessageIndex: lastIndex } : {}),
      ...(lastMessage ? { lastExtractionMessageMarker: createMessageMarker(lastMessage) } : {}),
      lastExtractionAt: (options.now ?? new Date()).toISOString()
    };
  }
}

function countToolCallsSince(
  messages: readonly MessageParam[],
  state: SessionMemoryTriggerState
) {
  const startIndex = resolveCountStartIndex(messages, state);
  let count = 0;

  for (let index = startIndex; index < messages.length; index += 1) {
    count += getAssistantToolCallCount(messages[index]);
  }

  return count;
}

function resolveCountStartIndex(
  messages: readonly MessageParam[],
  state: SessionMemoryTriggerState
) {
  if (state.lastExtractionMessageMarker) {
    const markerIndex = findMessageMarkerIndex(messages, state.lastExtractionMessageMarker);
    if (markerIndex >= 0) {
      return markerIndex + 1;
    }
  }

  if (
    state.lastExtractionMessageIndex !== undefined &&
    state.lastExtractionMessageIndex >= 0 &&
    state.lastExtractionMessageIndex < messages.length
  ) {
    return state.lastExtractionMessageIndex + 1;
  }

  return 0;
}

function findMessageMarkerIndex(messages: readonly MessageParam[], marker: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (createMessageMarker(messages[index]!) === marker) {
      return index;
    }
  }

  return -1;
}

function hasToolCallsInLastAssistantTurn(messages: readonly MessageParam[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role === "system") {
      continue;
    }

    if (message.role === "assistant") {
      return getAssistantToolCallCount(message) > 0;
    }
  }

  return false;
}

function getAssistantToolCallCount(message: MessageParam | undefined) {
  if (!message || message.role !== "assistant") {
    return 0;
  }

  const record = message as unknown as UnknownRecord;
  let count = Array.isArray(record.tool_calls) ? record.tool_calls.length : 0;
  const content = record.content;
  if (Array.isArray(content)) {
    count += content.filter((part) =>
      Boolean(
        part &&
          typeof part === "object" &&
          ((part as { type?: unknown }).type === "tool_use" ||
            (part as { type?: unknown }).type === "tool_call")
      )
    ).length;
  }

  return count;
}

function createMessageMarker(message: MessageParam) {
  const text = extractChatMessageText(message);
  return JSON.stringify({
    role: message.role,
    contentLength: text.length,
    contentHead: text.slice(0, 120),
    contentTail: text.slice(-120),
    toolCalls: extractToolCallNames(message)
  });
}

function extractToolCallNames(message: MessageParam) {
  if (message.role !== "assistant") {
    return [];
  }

  const toolCalls = (message as unknown as UnknownRecord).tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.map((toolCall) => {
    if (!toolCall || typeof toolCall !== "object") {
      return "";
    }

    const functionRecord = (toolCall as { function?: unknown }).function;
    if (!functionRecord || typeof functionRecord !== "object") {
      return "";
    }

    return typeof (functionRecord as { name?: unknown }).name === "string"
      ? (functionRecord as { name: string }).name
      : "";
  });
}


function normalizeConfig(config: SessionMemoryTriggerConfig): SessionMemoryTriggerConfig {
  return {
    enabled: config.enabled,
    initialTokens: normalizePositiveInteger(config.initialTokens, DEFAULT_SESSION_MEMORY_TRIGGER_CONFIG.initialTokens),
    updateTokens: normalizePositiveInteger(config.updateTokens, DEFAULT_SESSION_MEMORY_TRIGGER_CONFIG.updateTokens),
    toolCallsBetweenUpdates: normalizePositiveInteger(
      config.toolCallsBetweenUpdates,
      DEFAULT_SESSION_MEMORY_TRIGGER_CONFIG.toolCallsBetweenUpdates
    )
  };
}

function normalizeState(state: SessionMemoryTriggerState): SessionMemoryTriggerState {
  return {
    initialized: state.initialized === true,
    tokensAtLastExtraction: normalizePositiveInteger(state.tokensAtLastExtraction, 0),
    ...(typeof state.lastExtractionMessageIndex === "number"
      ? { lastExtractionMessageIndex: Math.max(0, Math.trunc(state.lastExtractionMessageIndex)) }
      : {}),
    ...(typeof state.lastExtractionMessageMarker === "string"
      ? { lastExtractionMessageMarker: state.lastExtractionMessageMarker }
      : {}),
    ...(typeof state.lastExtractionAt === "string" ? { lastExtractionAt: state.lastExtractionAt } : {})
  };
}

function createInitialState(): SessionMemoryTriggerState {
  return {
    initialized: false,
    tokensAtLastExtraction: 0
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value!));
}
