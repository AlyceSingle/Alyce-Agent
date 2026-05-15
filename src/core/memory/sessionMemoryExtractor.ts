import OpenAI from "openai";
import { extractAssistantTextContent } from "../api/assistantContent.js";
import { sendChatCompletion } from "../api/sendChatCompletion.js";
import type { ChatCompletionTransport } from "../api/modelAdapters.js";
import type { RequestPatchOperation } from "../api/requestPatch.js";
import type { ResolvedModelProfile } from "../providers/types.js";
import type { UsageRecordInput } from "../usage/types.js";

type MessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type InFlightExtraction = {
  controller: AbortController;
  startedAt: number;
  failureRecorded: boolean;
  finalResult?: SessionMemoryExtractionResult;
};

export interface SessionMemoryExtractorConfig {
  enabled: boolean;
  timeoutMs: number;
  maxFailures: number;
  staleMs: number;
  maxMessagesForExtraction: number;
  maxCharsPerMessage: number;
}

export interface SessionMemoryExtractorState {
  consecutiveFailures: number;
  lastFailureAt?: string;
  disabledForSession: boolean;
}

export type SessionMemoryExtractionStatus =
  | "updated"
  | "skipped"
  | "failed"
  | "aborted";

export interface SessionMemoryExtractionResult {
  status: SessionMemoryExtractionStatus;
  reason?: string;
  markdown?: string;
}

export interface SessionMemoryExtractionOptions {
  client: ChatCompletionTransport;
  model: string;
  resolvedModel?: ResolvedModelProfile;
  messages: readonly MessageParam[];
  currentMemory: string;
  memoryPath: string;
  requestPatches?: RequestPatchOperation[];
  abortSignal?: AbortSignal;
  shouldCommit?: () => boolean;
  onUsage?: (event: UsageRecordInput) => void;
}

export const DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG: SessionMemoryExtractorConfig = {
  enabled: true,
  timeoutMs: 180_000,
  maxFailures: 3,
  staleMs: 60_000,
  maxMessagesForExtraction: 80,
  maxCharsPerMessage: 1_500
};

export class SessionMemoryExtractor {
  private config: SessionMemoryExtractorConfig;
  private state: SessionMemoryExtractorState = {
    consecutiveFailures: 0,
    disabledForSession: false
  };
  private inFlight: InFlightExtraction | null = null;

  constructor(config: Partial<SessionMemoryExtractorConfig> = {}) {
    this.config = normalizeConfig({
      ...DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG,
      ...config
    });
  }

  updateConfig(config: Partial<SessionMemoryExtractorConfig>) {
    this.config = normalizeConfig({
      ...this.config,
      ...config
    });
    this.state.disabledForSession =
      this.state.consecutiveFailures >= this.config.maxFailures;
  }

  createSnapshot(): SessionMemoryExtractorState {
    return { ...this.state };
  }

  restoreSnapshot(snapshot: SessionMemoryExtractorState | null | undefined) {
    this.cancelInFlight("Session memory extraction cancelled by conversation restore.");
    this.state = snapshot ? normalizeState(snapshot, this.config) : {
      consecutiveFailures: 0,
      disabledForSession: false
    };
  }

  clear() {
    this.cancelInFlight("Session memory extraction cancelled by session reset.");
    this.state = {
      consecutiveFailures: 0,
      disabledForSession: false
    };
  }

  cancelInFlight(reason = "Session memory extraction cancelled.") {
    if (!this.inFlight) {
      return;
    }

    this.inFlight.finalResult = {
      status: "aborted",
      reason
    };
    this.inFlight.controller.abort(new Error(reason));
    this.inFlight = null;
  }

  schedule(options: SessionMemoryExtractionOptions): Promise<SessionMemoryExtractionResult> | null {
    if (!this.config.enabled) {
      return null;
    }

    if (this.state.disabledForSession) {
      return null;
    }

    const now = Date.now();
    if (this.inFlight) {
      if (now - this.inFlight.startedAt <= this.config.staleMs) {
        return null;
      }

      const staleFlight = this.inFlight;
      // Replacing a stale background extraction is one failure event, even if
      // the aborted promise later rejects after the replacement is scheduled.
      staleFlight.failureRecorded = true;
      staleFlight.finalResult = {
        status: "failed",
        reason: `Session memory extraction considered stale after ${this.config.staleMs}ms`
      };
      staleFlight.controller.abort(
        new Error(`Session memory extraction considered stale after ${this.config.staleMs}ms`)
      );
      this.inFlight = null;
      this.recordFailure();
      if (this.state.disabledForSession) {
        return null;
      }
    }

    const scopedAbort = createScopedAbortController(
      options.abortSignal,
      this.config.timeoutMs
    );
    const flight: InFlightExtraction = {
      controller: scopedAbort.controller,
      startedAt: now,
      failureRecorded: false
    };
    const recordFlightFailure = () => {
      if (flight.failureRecorded) {
        return;
      }

      flight.failureRecorded = true;
      this.recordFailure();
    };
    const promise = this.extract(options, scopedAbort.signal)
      .then(async (result) => {
        const settledResult = flight.finalResult ?? resolveIgnoredAbortResult(
          result,
          scopedAbort.controller.signal.reason,
          options.abortSignal,
          scopedAbort.getAbortSource()
        );
        if (settledResult.status === "updated") {
          this.resetFailureTracking();
        } else if (settledResult.status === "failed") {
          recordFlightFailure();
        }

        return settledResult;
      })
      .catch((error) => {
        const result = flight.finalResult ??
          toExtractionErrorResult(
            error,
            options.abortSignal,
            scopedAbort.getAbortSource()
          );
        if (result.status === "failed") {
          recordFlightFailure();
        }

        return result;
      })
      .finally(() => {
        scopedAbort.cleanup();
        if (this.inFlight === flight) {
          this.inFlight = null;
        }
      });

    this.inFlight = flight;

    return promise;
  }

  private async extract(
    options: SessionMemoryExtractionOptions,
    abortSignal: AbortSignal
  ): Promise<SessionMemoryExtractionResult> {
    if (abortSignal.aborted) {
      return { status: "aborted", reason: "aborted" };
    }

    const response = await sendChatCompletion(options.client, {
      model: options.model,
      resolvedModel: options.resolvedModel,
      messages: buildSessionMemoryExtractionMessages(options, this.config),
      tools: [],
      temperature: 0.1,
      requestPatches: options.requestPatches,
      abortSignal,
      onUsage: (event) => {
        options.onUsage?.({
          ...event,
          source: "session_memory"
        });
      }
    });
    const markdown = normalizeSessionMemoryMarkdown(
      extractAssistantTextContent(response.choices[0]?.message?.content)
    );

    if (!markdown) {
      return {
        status: "failed",
        reason: "Session memory extraction returned empty markdown"
      };
    }

    if (options.shouldCommit && !options.shouldCommit()) {
      return {
        status: "skipped",
        reason: "Session state changed before extraction completed"
      };
    }

    return {
      status: "updated",
      markdown
    };
  }

  private recordFailure() {
    const consecutiveFailures = this.state.consecutiveFailures + 1;
    this.state = {
      consecutiveFailures,
      lastFailureAt: new Date().toISOString(),
      disabledForSession: consecutiveFailures >= this.config.maxFailures
    };
  }

  private resetFailureTracking() {
    this.state = {
      consecutiveFailures: 0,
      disabledForSession: false
    };
  }
}

function buildSessionMemoryExtractionMessages(
  options: SessionMemoryExtractionOptions,
  config: SessionMemoryExtractorConfig
): MessageParam[] {
  return [
    {
      role: "system",
      content: [
        "You maintain Alyce's session memory file for a coding-agent session.",
        "Return the complete updated markdown file content only.",
        "Do not include code fences, explanations, or tool calls.",
        "Preserve the heading '# Session Memory' and keep these sections when useful: Current State, User Goal, Key Decisions, Files and Commands, Errors and Fixes, Next Steps.",
        "Prefer durable engineering context over chatty transcript details.",
        "Do not invent facts; omit unknowns or mark them as unknown.",
        "Keep the file concise enough to inject into future prompts."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        "Update the session memory file with the latest conversation segment.",
        `Target file: ${options.memoryPath}`,
        "",
        "## Current Session Memory",
        options.currentMemory.trim() || "(empty)",
        "",
        "## Latest Conversation Segment",
        formatConversationSegment(
          options.messages,
          config.maxMessagesForExtraction,
          config.maxCharsPerMessage
        ) || "(empty)",
        "",
        "Return only the complete updated markdown for the session memory file."
      ].join("\n")
    }
  ];
}

function formatConversationSegment(
  messages: readonly MessageParam[],
  maxMessages: number,
  maxCharsPerMessage: number
) {
  return messages
    .slice(-Math.max(1, maxMessages))
    .filter((message) => message.role !== "system")
    .map((message, index) => {
      const role = message.role.toUpperCase();
      const textParts = [truncate(extractMessageText(message), maxCharsPerMessage)];
      if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
        const toolNames = message.tool_calls.map((toolCall) => toolCall.function.name).join(", ");
        textParts.push(`Requested tools: ${toolNames}`);
      }

      return `[${index + 1}] ${role}: ${textParts.filter(Boolean).join("\n") || "(empty)"}`;
    })
    .join("\n\n");
}

function extractMessageText(message: MessageParam) {
  if (message.role === "tool") {
    return typeof message.content === "string" ? message.content : "";
  }

  const content = (message as { content?: unknown }).content;
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
      if (typeof record.text === "string") {
        return record.text;
      }

      return typeof record.content === "string" ? record.content : "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeSessionMemoryMarkdown(value: string | undefined) {
  const normalized = value?.replace(/\r\n/g, "\n").trim();
  const unwrapped = normalized?.match(/^```[a-z0-9_-]*[ \t]*\n?([\s\S]*?)\n?```\s*$/i)?.[1] ?? normalized;
  const markdown = unwrapped
    ?.replace(/\n{4,}/g, "\n\n\n")
    .trim();

  if (!markdown) {
    return undefined;
  }

  if (markdown.startsWith("# Session Memory")) {
    return markdown;
  }

  return ["# Session Memory", "", markdown].join("\n");
}

function truncate(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)} ...<truncated>`;
}

function createScopedAbortController(parentSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortSource: "parent" | "timeout" | undefined;
  const clearAbortTimeout = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const abortFromParent = () => {
    if (controller.signal.aborted) {
      return;
    }

    // User/session cancellation should stay "aborted"; clear the timeout so it
    // cannot later be counted as a model-side extraction failure.
    clearAbortTimeout();
    abortSource = "parent";
    controller.abort(parentSignal?.reason ?? new Error("Session memory extraction aborted"));
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  if (timeoutMs > 0 && !controller.signal.aborted) {
    timeout = setTimeout(() => {
      if (controller.signal.aborted) {
        return;
      }

      abortSource = "timeout";
      controller.abort(new Error(`Session memory extraction timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  return {
    controller,
    signal: controller.signal,
    getAbortSource: () => abortSource,
    cleanup: () => {
      clearAbortTimeout();
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

function toExtractionErrorResult(
  error: unknown,
  parentSignal: AbortSignal | undefined,
  abortSource: "parent" | "timeout" | undefined
): SessionMemoryExtractionResult {
  if (abortSource === "timeout") {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  if (parentSignal?.aborted || abortSource === "parent" || isAbortLikeError(error)) {
    return {
      status: "aborted",
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  return {
    status: "failed",
    reason: error instanceof Error ? error.message : String(error)
  };
}

function isAbortLikeError(error: unknown) {
  return error instanceof Error &&
    (error.name === "AbortError" || /aborted|cancelled|canceled/i.test(error.message));
}

function resolveIgnoredAbortResult(
  result: SessionMemoryExtractionResult,
  reason: unknown,
  parentSignal: AbortSignal | undefined,
  abortSource: "parent" | "timeout" | undefined
): SessionMemoryExtractionResult {
  if (!abortSource) {
    return result;
  }

  return toExtractionErrorResult(
    reason instanceof Error ? reason : new Error(String(reason || "aborted")),
    parentSignal,
    abortSource
  );
}

function normalizeConfig(config: SessionMemoryExtractorConfig): SessionMemoryExtractorConfig {
  return {
    enabled: config.enabled,
    timeoutMs: normalizePositiveInteger(config.timeoutMs, DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG.timeoutMs),
    maxFailures: normalizePositiveInteger(config.maxFailures, DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG.maxFailures),
    staleMs: normalizePositiveInteger(config.staleMs, DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG.staleMs),
    maxMessagesForExtraction: normalizePositiveInteger(
      config.maxMessagesForExtraction,
      DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG.maxMessagesForExtraction
    ),
    maxCharsPerMessage: normalizePositiveInteger(
      config.maxCharsPerMessage,
      DEFAULT_SESSION_MEMORY_EXTRACTOR_CONFIG.maxCharsPerMessage
    )
  };
}

function normalizeState(
  state: SessionMemoryExtractorState,
  config: SessionMemoryExtractorConfig
): SessionMemoryExtractorState {
  const consecutiveFailures = normalizePositiveInteger(state.consecutiveFailures, 0);
  return {
    consecutiveFailures,
    ...(typeof state.lastFailureAt === "string" ? { lastFailureAt: state.lastFailureAt } : {}),
    disabledForSession:
      state.disabledForSession === true || consecutiveFailures >= config.maxFailures
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value) || value! <= 0) {
    return fallback;
  }

  return Math.trunc(value!);
}
