import assert from "node:assert/strict";
import { formatUsageReport } from "./formatUsage.js";
import { UsageLedger } from "./usageLedger.js";
import type { ResolvedModelProfile } from "../providers/types.js";

function runTests() {
  testUsageLedgerAggregatesByProviderModel();
  testUnknownPricingDisplaysTokensOnly();
  testMissingInputOutputSplitDoesNotEstimateCost();
  testSubagentUsageIsGrouped();
  testCachedTokensDiscountCost();
  console.log("usageLedger tests passed");
}

function testCachedTokensDiscountCost() {
  const ledger = new UsageLedger();
  const event = ledger.recordEvent({
    source: "main",
    requestedModel: "anthropic/claude-sonnet-4.6",
    resolvedModel: createResolvedModel({
      providerId: "anthropic",
      modelId: "claude-sonnet-4.6",
      kind: "anthropic",
      inputCostPerMillionTokens: 3,
      outputCostPerMillionTokens: 15
    }),
    usage: {
      prompt_tokens: 2_000_000,
      completion_tokens: 0,
      total_tokens: 2_000_000,
      prompt_tokens_details: { cached_tokens: 1_000_000 },
      cache_creation_tokens: 1_000_000
    },
    startedAt: "2026-07-26T00:00:00.000Z",
    completedAt: "2026-07-26T00:00:01.000Z",
    durationMs: 1_000,
    retryCount: 0
  });

  // 全价 $6；缓存读 1M @ 0.3 + 缓存写 1M @ 3.75 = $4.05。
  assert.equal(event.estimatedCostUsd?.toFixed(2), "4.05");
  assert.equal(event.tokens.cacheRead, 1_000_000);
  assert.equal(event.tokens.cacheCreation, 1_000_000);

  const summary = ledger.getSummary();
  assert.equal(summary.totals.cacheReadTokens, 1_000_000);
  assert.equal(summary.totals.cacheCreationTokens, 1_000_000);
}

function testUsageLedgerAggregatesByProviderModel() {
  const ledger = new UsageLedger();
  ledger.recordEvent({
    source: "main",
    turnId: "turn-a",
    requestedModel: "openai/gpt-test",
    resolvedModel: createResolvedModel({
      providerId: "openai",
      modelId: "gpt-test",
      inputCostPerMillionTokens: 2,
      outputCostPerMillionTokens: 8
    }),
    usage: {
      prompt_tokens: 1_000,
      completion_tokens: 250,
      total_tokens: 1_250
    },
    startedAt: "2026-05-14T00:00:00.000Z",
    completedAt: "2026-05-14T00:00:02.000Z",
    durationMs: 2_000,
    retryCount: 1
  });
  ledger.recordEvent({
    source: "main",
    turnId: "turn-b",
    requestedModel: "local/qwen",
    resolvedModel: createResolvedModel({
      providerId: "local",
      modelId: "qwen"
    }),
    usage: {
      prompt_tokens: 500,
      completion_tokens: 100,
      total_tokens: 600
    },
    startedAt: "2026-05-14T00:01:00.000Z",
    completedAt: "2026-05-14T00:01:01.000Z",
    durationMs: 1_000,
    retryCount: 0
  });

  const summary = ledger.getSummary();
  assert.equal(summary.totals.totalTokens, 1_850);
  assert.deepEqual(summary.byProviderModel.map((item) => item.label), [
    "openai/gpt-test",
    "local/qwen"
  ]);
  assert.equal(summary.byProviderModel[0]?.estimatedCostUsd, 0.004);
  assert.equal(summary.latestTurn?.totalTokens, 600);
}

function testUnknownPricingDisplaysTokensOnly() {
  const ledger = new UsageLedger();
  ledger.recordEvent({
    source: "main",
    requestedModel: "local/qwen",
    resolvedModel: createResolvedModel({
      providerId: "local",
      modelId: "qwen"
    }),
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150
    },
    startedAt: "2026-05-14T00:00:00.000Z",
    completedAt: "2026-05-14T00:00:01.000Z",
    durationMs: 1_000,
    retryCount: 0
  });

  const report = formatUsageReport(ledger.getSummary());
  assert.match(report, /tokens only; no provider\/model price metadata/);
  assert.doesNotMatch(report, /\$0(?:\.0+)?\b/);
}

function testMissingInputOutputSplitDoesNotEstimateCost() {
  const ledger = new UsageLedger();
  ledger.recordEvent({
    source: "main",
    requestedModel: "openai/gpt-test",
    resolvedModel: createResolvedModel({
      providerId: "openai",
      modelId: "gpt-test",
      inputCostPerMillionTokens: 2,
      outputCostPerMillionTokens: 8
    }),
    usage: {
      total_tokens: 150
    },
    startedAt: "2026-05-14T00:00:00.000Z",
    completedAt: "2026-05-14T00:00:01.000Z",
    durationMs: 1_000,
    retryCount: 0
  });

  const summary = ledger.getSummary();
  assert.equal(summary.totals.estimatedCostUsd, undefined);
  assert.match(formatUsageReport(summary), /tokens only/);
}

function testSubagentUsageIsGrouped() {
  const ledger = new UsageLedger();
  ledger.recordEvent({
    source: "subagent",
    turnId: "turn-a",
    taskId: "task-1",
    label: "review",
    requestedModel: "openai/gpt-test",
    resolvedModel: createResolvedModel({
      providerId: "openai",
      modelId: "gpt-test"
    }),
    usage: {
      prompt_tokens: 300,
      completion_tokens: 200,
      total_tokens: 500
    },
    startedAt: "2026-05-14T00:00:00.000Z",
    completedAt: "2026-05-14T00:00:03.000Z",
    durationMs: 3_000,
    retryCount: 0
  });

  const summary = ledger.getSummary();
  assert.equal(summary.subagents.length, 1);
  assert.equal(summary.subagents[0]?.taskId, "task-1");
  assert.equal(summary.subagents[0]?.totalTokens, 500);
}

function createResolvedModel(
  input: Pick<ResolvedModelProfile, "providerId" | "modelId"> &
    Partial<ResolvedModelProfile>
): ResolvedModelProfile {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    modelRef: {
      providerId: input.providerId,
      modelId: input.modelId
    },
    label: input.label ?? input.modelId,
    provider: input.provider ?? {
      id: input.providerId,
      label: input.providerId,
      kind: input.kind ?? "openai-compatible"
    },
    kind: input.kind ?? "openai-compatible",
    contextWindow: input.contextWindow ?? 128_000,
    contextWindowSource: input.contextWindowSource ?? "fallback",
    contextWindowLabel: input.contextWindowLabel ?? "fallback default",
    ...(input.inputCostPerMillionTokens !== undefined
      ? { inputCostPerMillionTokens: input.inputCostPerMillionTokens }
      : {}),
    ...(input.outputCostPerMillionTokens !== undefined
      ? { outputCostPerMillionTokens: input.outputCostPerMillionTokens }
      : {})
  };
}

runTests();
