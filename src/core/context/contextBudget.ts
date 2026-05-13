import type OpenAI from "openai";
import {
  ALYCE_READ_ATTACHMENT_MESSAGE_NAME,
  ALYCE_SKILL_CONTEXT_MESSAGE_NAME,
  isGeneratedContextMessage
} from "../api/generatedMessages.js";
import {
  resolveModelContextWindow,
  type ContextWindowSource,
  type ModelContextWindowOverrides
} from "./modelContextWindows.js";

export type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatCreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
export type ChatCompletionTool = OpenAI.Chat.Completions.ChatCompletionTool;

export type ContextBudgetState = "normal" | "warning" | "auto_compact" | "blocking";

export type ContextBudgetCategoryName =
  | "system"
  | "tools"
  | "history"
  | "toolOutputs"
  | "memory"
  | "attachments"
  | "skills"
  | "buffer";

export type ContextBudgetBreakdown = Record<ContextBudgetCategoryName, number>;

export interface ContextBudgetSnapshot {
  model: string;
  contextWindow: number;
  contextWindowSource: ContextWindowSource;
  contextWindowLabel: string;
  contextWindowMatchedPattern?: string;
  estimatedInputTokens: number;
  rawEstimatedInputTokens: number;
  reservedOutputTokens: number;
  autoCompactBufferTokens: number;
  autoCompactThreshold: number;
  hardLimitTokens: number;
  usedPercent: number;
  untilAutoCompactPercent: number;
  remainingTokens: number;
  state: ContextBudgetState;
  breakdown: ContextBudgetBreakdown;
  calibrationScale: number;
}

export interface ToolOutputSnipResult {
  changed: boolean;
  snippedMessages: number;
  originalChars: number;
  retainedChars: number;
  estimatedTokensSaved: number;
}

export interface ContextBudgetUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ContextBudgetEstimateOptions {
  recordForUsage?: boolean;
}

export interface ContextBudgetServiceOptions {
  modelContextWindowOverrides?: ModelContextWindowOverrides;
}

export class ContextOverflowError extends Error {
  readonly code = "CONTEXT_OVERFLOW";

  constructor(
    message: string,
    readonly snapshot?: ContextBudgetSnapshot,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

const DEFAULT_AUTO_COMPACT_BUFFER_TOKENS = 13_000;
const TOOL_OUTPUT_SNIP_MARKER = "[Alyce context snip]";
const TOOL_OUTPUT_MAX_CHARS = 72_000;
const TOOL_OUTPUT_HEAD_CHARS = 28_000;
const TOOL_OUTPUT_TAIL_CHARS = 20_000;

export class ContextBudgetService {
  private calibrationScale = 1;
  private lastRawEstimateForUsage = 0;
  private modelContextWindowOverrides: ModelContextWindowOverrides;

  constructor(options: ContextBudgetServiceOptions = {}) {
    this.modelContextWindowOverrides = options.modelContextWindowOverrides ?? {};
  }

  setModelContextWindowOverrides(overrides: ModelContextWindowOverrides | undefined) {
    this.modelContextWindowOverrides = overrides ?? {};
  }

  estimateRequest(
    request: ChatCreateParams,
    options: ContextBudgetEstimateOptions = {}
  ): ContextBudgetSnapshot {
    const contextWindowResolution = resolveModelContextWindow(
      request.model,
      this.modelContextWindowOverrides
    );
    const contextWindow = contextWindowResolution.contextWindow;
    const reservedOutputTokens = resolveReservedOutputTokens(contextWindow);
    const autoCompactBufferTokens = resolveAutoCompactBufferTokens(contextWindow);
    const hardLimitTokens = Math.max(1, contextWindow - reservedOutputTokens);
    const autoCompactThreshold = Math.max(1, hardLimitTokens - autoCompactBufferTokens);
    const breakdown = estimateBreakdown(request);
    const rawEstimatedInputTokens = sumBreakdownWithoutBuffer(breakdown);
    if (options.recordForUsage) {
      this.lastRawEstimateForUsage = rawEstimatedInputTokens;
    }
    const estimatedInputTokens = Math.ceil(rawEstimatedInputTokens * this.calibrationScale);
    const calibratedBreakdown = scaleBreakdown(breakdown, this.calibrationScale);
    calibratedBreakdown.buffer = reservedOutputTokens + autoCompactBufferTokens;
    const usedPercent = percentage(estimatedInputTokens, contextWindow);
    const untilAutoCompactPercent = percentage(
      Math.max(0, autoCompactThreshold - estimatedInputTokens),
      contextWindow
    );
    const remainingTokens = Math.max(0, hardLimitTokens - estimatedInputTokens);

    return {
      model: request.model,
      contextWindow,
      contextWindowSource: contextWindowResolution.source,
      contextWindowLabel: contextWindowResolution.label,
      contextWindowMatchedPattern: contextWindowResolution.matchedPattern,
      estimatedInputTokens,
      rawEstimatedInputTokens,
      reservedOutputTokens,
      autoCompactBufferTokens,
      autoCompactThreshold,
      hardLimitTokens,
      usedPercent,
      untilAutoCompactPercent,
      remainingTokens,
      state: resolveBudgetState(estimatedInputTokens, autoCompactThreshold, hardLimitTokens),
      breakdown: calibratedBreakdown,
      calibrationScale: this.calibrationScale
    };
  }

  recordUsage(usage: ContextBudgetUsage | null | undefined) {
    if (!usage?.prompt_tokens || usage.prompt_tokens <= 0 || this.lastRawEstimateForUsage <= 0) {
      return;
    }

    const nextScale = usage.prompt_tokens / this.lastRawEstimateForUsage;
    if (!Number.isFinite(nextScale) || nextScale <= 0) {
      return;
    }

    this.calibrationScale = clamp(nextScale, 0.75, 2.5);
  }
}

export function snipOversizedToolOutputs(
  messages: MessageParam[],
  maxChars = TOOL_OUTPUT_MAX_CHARS
): ToolOutputSnipResult {
  const protectedToolCallIds = getLatestUnansweredToolCallIds(messages);
  let snippedMessages = 0;
  let originalChars = 0;
  let retainedChars = 0;

  for (const message of messages) {
    if (message.role !== "tool" || typeof message.content !== "string") {
      continue;
    }

    const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id;
    if (typeof toolCallId === "string" && protectedToolCallIds.has(toolCallId)) {
      continue;
    }

    if (message.content.length <= maxChars || message.content.startsWith(TOOL_OUTPUT_SNIP_MARKER)) {
      continue;
    }

    const original = message.content;
    const head = original.slice(0, TOOL_OUTPUT_HEAD_CHARS).trimEnd();
    const tail = original.slice(-TOOL_OUTPUT_TAIL_CHARS).trimStart();
    const nextContent = [
      TOOL_OUTPUT_SNIP_MARKER,
      `Original tool output length: ${original.length} chars.`,
      "The middle of this older tool output was removed before the next model request to keep context within budget.",
      "",
      "## Head",
      head,
      "",
      "## Tail",
      tail
    ].join("\n");

    message.content = nextContent;
    snippedMessages += 1;
    originalChars += original.length;
    retainedChars += nextContent.length;
  }

  return {
    changed: snippedMessages > 0,
    snippedMessages,
    originalChars,
    retainedChars,
    estimatedTokensSaved: estimateTextTokens("x".repeat(Math.max(0, originalChars - retainedChars)))
  };
}

function getLatestUnansweredToolCallIds(messages: MessageParam[]): Set<string> {
  const protectedIds = new Set<string>();
  let index = messages.length - 1;

  while (index >= 0 && isGeneratedContextMessage(messages[index]!)) {
    index -= 1;
  }

  while (index >= 0 && messages[index]?.role === "tool") {
    const toolCallId = (messages[index] as { tool_call_id?: unknown }).tool_call_id;
    if (typeof toolCallId === "string") {
      protectedIds.add(toolCallId);
    }
    index -= 1;
  }

  if (protectedIds.size === 0) {
    return protectedIds;
  }

  const assistant = messages[index];
  if (assistant?.role !== "assistant" || !assistant.tool_calls || assistant.tool_calls.length === 0) {
    protectedIds.clear();
    return protectedIds;
  }

  const requestedIds = new Set(assistant.tool_calls.map((toolCall) => toolCall.id));
  for (const id of [...protectedIds]) {
    if (!requestedIds.has(id)) {
      protectedIds.delete(id);
    }
  }

  return protectedIds;
}

export function formatContextBudgetReport(snapshot: ContextBudgetSnapshot): string {
  const lines = [
    "=== Context Budget ===",
    `Model: ${snapshot.model}`,
    `Context window: ${formatTokenCount(snapshot.contextWindow)} (${formatContextWindowSource(snapshot)})`,
    `State: ${snapshot.state}`,
    `Estimated input: ${formatTokenCount(snapshot.estimatedInputTokens)} / ${formatTokenCount(snapshot.contextWindow)} (${snapshot.usedPercent.toFixed(1)}%)`,
    `Hard limit: ${formatTokenCount(snapshot.hardLimitTokens)} (reserved output ${formatTokenCount(snapshot.reservedOutputTokens)})`,
    `Auto-compact threshold: ${formatTokenCount(snapshot.autoCompactThreshold)} (buffer ${formatTokenCount(snapshot.autoCompactBufferTokens)})`,
    `Remaining before hard limit: ${formatTokenCount(snapshot.remainingTokens)}`,
    `Calibration scale: ${snapshot.calibrationScale.toFixed(2)}x`,
    "",
    "Breakdown:"
  ];

  for (const [name, value] of sortedBreakdownEntries(snapshot.breakdown)) {
    lines.push(`- ${formatCategoryName(name)}: ${formatTokenCount(value)} (${percentage(value, snapshot.contextWindow).toFixed(1)}%)`);
  }

  return lines.join("\n");
}

export function formatContextOverflowMessage(snapshot: ContextBudgetSnapshot): string {
  return [
    "Context overflow blocked locally before sending the model request.",
    `Estimated input: ${formatTokenCount(snapshot.estimatedInputTokens)} tokens.`,
    `Local hard limit: ${formatTokenCount(snapshot.hardLimitTokens)} tokens for model ${snapshot.model}.`,
    "Alyce did not send this request upstream. Compact the conversation, remove large attachments, or reduce tool/MCP output before retrying."
  ].join("\n");
}

export function isContextOverflowError(error: unknown): boolean {
  if (error instanceof ContextOverflowError) {
    return true;
  }

  const text = collectErrorText(error).toLowerCase();
  return (
    text.includes("context_length_exceeded") ||
    text.includes("input token count exceeds") ||
    text.includes("maximum number of tokens allowed") ||
    text.includes("maximum context length") ||
    text.includes("context window") ||
    text.includes("prompt is too long") ||
    /token(?:s)?\s+(?:count\s+)?exceed/.test(text) ||
    /too many\s+(?:input\s+)?tokens/.test(text)
  );
}

export function toContextOverflowError(error: unknown): ContextOverflowError {
  if (error instanceof ContextOverflowError) {
    return error;
  }

  return new ContextOverflowError(
    `Context overflow: ${collectErrorText(error) || "provider rejected the request as too large"}`,
    undefined,
    error
  );
}

function estimateBreakdown(request: ChatCreateParams): ContextBudgetBreakdown {
  const breakdown = createEmptyBreakdown();
  for (const message of request.messages) {
    addMessageEstimate(breakdown, message);
  }

  if (request.tools && request.tools.length > 0) {
    breakdown.tools += estimateJsonTokens(request.tools);
  }

  return breakdown;
}

function addMessageEstimate(breakdown: ContextBudgetBreakdown, message: MessageParam) {
  const messageOverhead = 8;
  if (message.role === "system") {
    const systemText = extractContentText((message as { content?: unknown }).content);
    const memoryTokens = estimateMemorySectionTokens(systemText);
    breakdown.memory += memoryTokens;
    breakdown.system += Math.max(0, estimateTextTokens(systemText) - memoryTokens) + messageOverhead;
    return;
  }

  if (message.role === "tool") {
    breakdown.toolOutputs += estimateValueTokens(message.content) + messageOverhead;
    return;
  }

  if (message.role === "user") {
    const name = (message as { name?: unknown }).name;
    if (name === ALYCE_READ_ATTACHMENT_MESSAGE_NAME || hasAttachmentContent((message as { content?: unknown }).content)) {
      breakdown.attachments += estimateValueTokens((message as { content?: unknown }).content) + messageOverhead;
      return;
    }

    if (name === ALYCE_SKILL_CONTEXT_MESSAGE_NAME) {
      breakdown.skills += estimateValueTokens((message as { content?: unknown }).content) + messageOverhead;
      return;
    }
  }

  breakdown.history += estimateValueTokens((message as { content?: unknown }).content) + messageOverhead;
  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    breakdown.history += estimateJsonTokens(message.tool_calls);
  }
}

function estimateMemorySectionTokens(systemText: string): number {
  if (!systemText.trim()) {
    return 0;
  }

  const memoryStart = systemText.indexOf("# Memory");
  const compactedStart = systemText.indexOf("# Compacted Conversation Summary");
  const starts = [memoryStart, compactedStart].filter((index) => index >= 0);
  if (starts.length === 0) {
    return 0;
  }

  let total = 0;
  for (const start of starts) {
    const nextSection = systemText.slice(start + 1).search(/\n# [^\n]+/);
    const end = nextSection >= 0 ? start + 1 + nextSection : systemText.length;
    total += estimateTextTokens(systemText.slice(start, end));
  }

  return Math.min(total, estimateTextTokens(systemText));
}

function hasAttachmentContent(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((part) => {
    if (!part || typeof part !== "object") {
      return false;
    }

    const type = (part as { type?: unknown }).type;
    return type === "image_url" || type === "input_image" || type === "file" || type === "input_file";
  });
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }

      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function estimateValueTokens(value: unknown): number {
  if (typeof value === "string") {
    return estimateTextTokens(value);
  }

  if (Array.isArray(value)) {
    return value.reduce((total, item) => {
      if (!item || typeof item !== "object") {
        return total + estimateValueTokens(item);
      }

      const record = item as Record<string, unknown>;
      const type = typeof record.type === "string" ? record.type : "";
      if (type.includes("image")) {
        return total + 1_100 + estimateJsonTokens(record);
      }

      if (type.includes("file")) {
        return total + 2_000 + estimateJsonTokens(record);
      }

      return total + estimateValueTokens(record.text ?? record.content ?? record);
    }, 0);
  }

  return estimateJsonTokens(value);
}

function estimateTextTokens(value: string): number {
  if (!value) {
    return 0;
  }

  let ascii = 0;
  let nonAscii = 0;
  for (const char of value) {
    if (char.charCodeAt(0) <= 0x7f) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }

  return Math.ceil(ascii / 3.7 + nonAscii / 1.4);
}

function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTextTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function resolveReservedOutputTokens(contextWindow: number): number {
  if (contextWindow <= 16_000) {
    return 2_000;
  }

  if (contextWindow <= 64_000) {
    return 4_000;
  }

  return Math.min(16_000, Math.max(8_000, Math.floor(contextWindow * 0.02)));
}

function resolveAutoCompactBufferTokens(contextWindow: number): number {
  if (contextWindow <= 32_000) {
    return Math.max(2_000, Math.floor(contextWindow * 0.08));
  }

  return Math.min(DEFAULT_AUTO_COMPACT_BUFFER_TOKENS, Math.max(4_000, Math.floor(contextWindow * 0.03)));
}

function resolveBudgetState(
  estimatedInputTokens: number,
  autoCompactThreshold: number,
  hardLimitTokens: number
): ContextBudgetState {
  if (estimatedInputTokens > hardLimitTokens) {
    return "blocking";
  }

  if (estimatedInputTokens >= autoCompactThreshold) {
    return "auto_compact";
  }

  if (estimatedInputTokens >= Math.floor(autoCompactThreshold * 0.9)) {
    return "warning";
  }

  return "normal";
}

function createEmptyBreakdown(): ContextBudgetBreakdown {
  return {
    system: 0,
    tools: 0,
    history: 0,
    toolOutputs: 0,
    memory: 0,
    attachments: 0,
    skills: 0,
    buffer: 0
  };
}

function sumBreakdownWithoutBuffer(breakdown: ContextBudgetBreakdown): number {
  return Object.entries(breakdown)
    .filter(([name]) => name !== "buffer")
    .reduce((total, [, value]) => total + value, 0);
}

function scaleBreakdown(
  breakdown: ContextBudgetBreakdown,
  scale: number
): ContextBudgetBreakdown {
  const next = createEmptyBreakdown();
  for (const [name, value] of Object.entries(breakdown) as Array<[ContextBudgetCategoryName, number]>) {
    next[name] = Math.ceil(value * scale);
  }

  return next;
}

function sortedBreakdownEntries(
  breakdown: ContextBudgetBreakdown
): Array<[ContextBudgetCategoryName, number]> {
  return (Object.entries(breakdown) as Array<[ContextBudgetCategoryName, number]>)
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1]);
}

function formatCategoryName(name: ContextBudgetCategoryName): string {
  switch (name) {
    case "toolOutputs":
      return "Tool outputs";
    default:
      return name.slice(0, 1).toUpperCase() + name.slice(1);
  }
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }

  return String(value);
}

function formatContextWindowSource(snapshot: ContextBudgetSnapshot): string {
  const matched = snapshot.contextWindowMatchedPattern
    ? `, matched "${snapshot.contextWindowMatchedPattern}"`
    : "";
  return `${snapshot.contextWindowSource}: ${snapshot.contextWindowLabel}${matched}`;
}

function percentage(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return clamp((value / total) * 100, 0, 999);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function collectErrorText(error: unknown): string {
  if (error instanceof Error) {
    return [error.name, error.message, collectErrorObjectText(error)].filter(Boolean).join(" ");
  }

  if (typeof error === "string") {
    return error;
  }

  return collectErrorObjectText(error) || String(error);
}

function collectErrorObjectText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }

  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["code", "type", "status", "message"]) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
    }
  }

  const nestedError = record.error;
  if (nestedError && nestedError !== error) {
    parts.push(collectErrorObjectText(nestedError));
  }

  return parts.filter(Boolean).join(" ");
}
