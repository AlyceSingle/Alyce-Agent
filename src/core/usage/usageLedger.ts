import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseModelRef } from "../providers/resolveModel.js";
import type {
  ModelTokenUsage,
  UsageAggregate,
  UsageEvent,
  UsageRecordInput,
  UsageSessionSummary
} from "./types.js";

export interface UsageLedgerOptions {
  jsonlPath?: string;
}

export interface UsageSummaryOptions {
  recentTurnLimit?: number;
}

export class UsageLedger {
  private readonly events: UsageEvent[] = [];
  private readonly jsonlPath?: string;

  constructor(options: UsageLedgerOptions = {}) {
    this.jsonlPath = options.jsonlPath;
  }

  recordEvent(input: UsageRecordInput): UsageEvent {
    const modelRef = resolveEventModelRef(input);
    const tokens = normalizeUsageTokens(input.usage);
    const estimatedCostUsd = estimateCostUsd(input, tokens);
    const event: UsageEvent = {
      id: randomUUID(),
      requestedModel: input.requestedModel,
      usage: input.usage,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      durationMs: input.durationMs,
      retryCount: input.retryCount,
      source: input.source,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.label ? { label: input.label } : {}),
      providerId: modelRef.providerId,
      modelId: modelRef.modelId,
      providerModel: `${modelRef.providerId}/${modelRef.modelId}`,
      tokens,
      ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {})
    };

    this.events.push(event);
    this.persistEvent(event);
    return event;
  }

  getEvents(): UsageEvent[] {
    return this.events.map((event) => ({ ...event, tokens: { ...event.tokens } }));
  }

  getSummary(options: UsageSummaryOptions = {}): UsageSessionSummary {
    const recentTurnLimit = Math.max(1, Math.trunc(options.recentTurnLimit ?? 5));
    const totals = createEmptyAggregate("session", "Session total");
    const byProviderModel = new Map<string, UsageAggregate>();
    const bySource = new Map<string, UsageAggregate>();
    const byTurn = new Map<string, UsageAggregate>();
    const bySubagent = new Map<string, UsageAggregate>();

    for (const event of this.events) {
      addEventToAggregate(totals, event);
      addEventToAggregate(
        getOrCreateAggregate(byProviderModel, event.providerModel, event.providerModel, {
          providerId: event.providerId,
          modelId: event.modelId
        }),
        event
      );
      addEventToAggregate(
        getOrCreateAggregate(bySource, event.source, formatSourceLabel(event.source), {
          source: event.source
        }),
        event
      );

      if (event.turnId) {
        addEventToAggregate(
          getOrCreateAggregate(byTurn, event.turnId, event.turnId, {
            turnId: event.turnId
          }),
          event
        );
      }

      if (event.source === "subagent") {
        const subagentKey = event.taskId ?? event.label ?? event.id;
        const subagentLabel = [event.taskId, event.label].filter(Boolean).join(" ") || subagentKey;
        addEventToAggregate(
          getOrCreateAggregate(bySubagent, subagentKey, subagentLabel, {
            taskId: event.taskId,
            source: event.source
          }),
          event
        );
      }
    }

    const recentTurns = sortAggregatesByLastCompleted([...byTurn.values()])
      .slice(-recentTurnLimit)
      .reverse();

    return {
      eventCount: this.events.length,
      totals,
      byProviderModel: sortAggregatesByTokens([...byProviderModel.values()]),
      bySource: sortAggregatesByTokens([...bySource.values()]),
      recentTurns,
      subagents: sortAggregatesByLastCompleted([...bySubagent.values()]).reverse(),
      latestTurn: getLatestNonSubagentTurn([...byTurn.values()], this.events)
    };
  }

  private persistEvent(event: UsageEvent) {
    if (!this.jsonlPath) {
      return;
    }

    const line = JSON.stringify(event) + "\n";
    void fs.mkdir(path.dirname(this.jsonlPath), { recursive: true })
      .then(() => fs.appendFile(this.jsonlPath!, line, "utf8"))
      .catch(() => undefined);
  }
}

function resolveEventModelRef(input: UsageRecordInput) {
  if (input.resolvedModel) {
    return {
      providerId: input.resolvedModel.providerId,
      modelId: input.resolvedModel.modelId
    };
  }

  try {
    return parseModelRef(input.requestedModel);
  } catch {
    return {
      providerId: "unknown",
      modelId: input.requestedModel.trim() || "unknown"
    };
  }
}

function normalizeUsageTokens(usage: ModelTokenUsage | null | undefined) {
  const input = normalizeTokenCount(usage?.prompt_tokens);
  const output = normalizeTokenCount(usage?.completion_tokens);
  const total = normalizeTokenCount(usage?.total_tokens) ?? ((input ?? 0) + (output ?? 0));
  const cacheRead = normalizeTokenCount(usage?.prompt_tokens_details?.cached_tokens) ?? 0;
  const cacheCreation = normalizeTokenCount(usage?.cache_creation_tokens) ?? 0;
  const hasUsage = input !== undefined || output !== undefined || usage?.total_tokens !== undefined;

  return {
    input: input ?? 0,
    output: output ?? 0,
    total,
    cacheRead,
    cacheCreation,
    hasUsage
  };
}

function normalizeTokenCount(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.trunc(value!));
}

// 未显式配置缓存单价时的默认折扣（相对 input 价）。
const CACHE_READ_DISCOUNT_ANTHROPIC = 0.1;
const CACHE_READ_DISCOUNT_DEFAULT = 0.5;
// Anthropic 缓存写入按 1.25 倍 input 价计费。
const CACHE_WRITE_MULTIPLIER_ANTHROPIC = 1.25;

function estimateCostUsd(
  input: UsageRecordInput,
  tokens: ReturnType<typeof normalizeUsageTokens>
): number | undefined {
  const inputPrice = input.resolvedModel?.inputCostPerMillionTokens;
  const outputPrice = input.resolvedModel?.outputCostPerMillionTokens;
  if (
    !tokens.hasUsage ||
    inputPrice === undefined ||
    outputPrice === undefined ||
    normalizeTokenCount(input.usage?.prompt_tokens) === undefined ||
    normalizeTokenCount(input.usage?.completion_tokens) === undefined
  ) {
    return undefined;
  }

  const isAnthropic = input.resolvedModel?.kind === "anthropic";
  const cacheReadPrice = input.resolvedModel?.cachedInputCostPerMillionTokens ??
    inputPrice * (isAnthropic ? CACHE_READ_DISCOUNT_ANTHROPIC : CACHE_READ_DISCOUNT_DEFAULT);
  const cacheWritePrice = isAnthropic
    ? inputPrice * CACHE_WRITE_MULTIPLIER_ANTHROPIC
    : inputPrice;
  const cacheRead = Math.min(tokens.cacheRead, tokens.input);
  const cacheCreation = Math.min(tokens.cacheCreation, tokens.input - cacheRead);
  const uncachedInput = Math.max(0, tokens.input - cacheRead - cacheCreation);

  return (
    (uncachedInput / 1_000_000) * inputPrice +
    (cacheRead / 1_000_000) * cacheReadPrice +
    (cacheCreation / 1_000_000) * cacheWritePrice +
    (tokens.output / 1_000_000) * outputPrice
  );
}

function createEmptyAggregate(
  key: string,
  label: string,
  patch: Partial<UsageAggregate> = {}
): UsageAggregate {
  return {
    key,
    label,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usageEventCount: 0,
    durationMs: 0,
    retryCount: 0,
    unknownCostEventCount: 0,
    ...patch
  };
}

function getOrCreateAggregate(
  map: Map<string, UsageAggregate>,
  key: string,
  label: string,
  patch: Partial<UsageAggregate> = {}
): UsageAggregate {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }

  const created = createEmptyAggregate(key, label, patch);
  map.set(key, created);
  return created;
}

function addEventToAggregate(aggregate: UsageAggregate, event: UsageEvent) {
  aggregate.requestCount += 1;
  aggregate.inputTokens += event.tokens.input;
  aggregate.outputTokens += event.tokens.output;
  aggregate.totalTokens += event.tokens.total;
  aggregate.cacheReadTokens += event.tokens.cacheRead;
  aggregate.cacheCreationTokens += event.tokens.cacheCreation;
  aggregate.durationMs += Math.max(0, Math.trunc(event.durationMs));
  aggregate.retryCount += Math.max(0, Math.trunc(event.retryCount));
  if (event.tokens.hasUsage) {
    aggregate.usageEventCount += 1;
  }
  if (event.estimatedCostUsd !== undefined) {
    aggregate.estimatedCostUsd = (aggregate.estimatedCostUsd ?? 0) + event.estimatedCostUsd;
  } else if (event.tokens.hasUsage) {
    aggregate.unknownCostEventCount += 1;
  }

  if (!aggregate.firstStartedAt || event.startedAt < aggregate.firstStartedAt) {
    aggregate.firstStartedAt = event.startedAt;
  }
  if (!aggregate.lastCompletedAt || event.completedAt > aggregate.lastCompletedAt) {
    aggregate.lastCompletedAt = event.completedAt;
  }
}

function sortAggregatesByTokens(aggregates: UsageAggregate[]) {
  return aggregates.sort((left, right) => {
    const tokenDelta = right.totalTokens - left.totalTokens;
    return tokenDelta !== 0 ? tokenDelta : left.label.localeCompare(right.label);
  });
}

function sortAggregatesByLastCompleted(aggregates: UsageAggregate[]) {
  return aggregates.sort((left, right) =>
    (left.lastCompletedAt ?? "").localeCompare(right.lastCompletedAt ?? "")
  );
}

function getLatestNonSubagentTurn(
  turns: UsageAggregate[],
  events: UsageEvent[]
): UsageAggregate | undefined {
  for (const event of [...events].reverse()) {
    if (!event.turnId || event.source === "subagent") {
      continue;
    }

    return turns.find((turn) => turn.turnId === event.turnId);
  }

  return undefined;
}

function formatSourceLabel(source: string) {
  switch (source) {
    case "main":
      return "Main agent";
    case "subagent":
      return "Subagents";
    case "compact":
      return "Compaction";
    case "session_memory":
      return "Session memory";
    case "title":
      return "Title";
    default:
      return source;
  }
}
