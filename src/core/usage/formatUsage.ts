import type { UsageAggregate, UsageSessionSummary, UsageSource } from "./types.js";

export function formatUsageReport(summary: UsageSessionSummary): string {
  if (summary.eventCount === 0) {
    return [
      "=== Usage ===",
      "No model usage has been recorded for this session yet.",
      "=== End Usage ==="
    ].join("\n");
  }

  const lines: string[] = [
    "=== Usage ===",
    `Session: ${formatAggregateInline(summary.totals)}`
  ];

  lines.push(`Estimated cost: ${formatCostSummary(summary.totals)}`);
  lines.push("");
  lines.push("By provider/model:");
  for (const aggregate of summary.byProviderModel) {
    lines.push(`- ${aggregate.label}: ${formatAggregateInline(aggregate)} | ${formatCostForAggregate(aggregate)}`);
  }

  lines.push("");
  lines.push("By source:");
  for (const aggregate of summary.bySource) {
    lines.push(`- ${aggregate.label}: ${formatAggregateInline(aggregate)}`);
  }

  lines.push("");
  lines.push("Recent turns:");
  if (summary.recentTurns.length === 0) {
    lines.push("- (none)");
  } else {
    for (const turn of summary.recentTurns) {
      lines.push(`- ${turn.label}: ${formatAggregateInline(turn)} | ${formatCostForAggregate(turn)}`);
    }
  }

  lines.push("");
  lines.push("Subagents:");
  if (summary.subagents.length === 0) {
    lines.push("- (none)");
  } else {
    for (const subagent of summary.subagents) {
      lines.push(`- ${subagent.label}: ${formatAggregateInline(subagent)} | ${formatCostForAggregate(subagent)}`);
    }
  }

  lines.push("=== End Usage ===");
  return lines.join("\n");
}

export function formatUsageSource(source: UsageSource): string {
  switch (source) {
    case "main":
      return "main";
    case "subagent":
      return "subagent";
    case "compact":
      return "compaction";
    case "session_memory":
      return "session memory";
    case "title":
      return "title";
  }
}

function formatAggregateInline(aggregate: UsageAggregate): string {
  return [
    `${formatTokenCount(aggregate.totalTokens)} tokens`,
    `${formatTokenCount(aggregate.inputTokens)} in`,
    ...(aggregate.cacheReadTokens > 0
      ? [`${formatTokenCount(aggregate.cacheReadTokens)} cached (${formatCacheHitRate(aggregate)})`]
      : []),
    `${formatTokenCount(aggregate.outputTokens)} out`,
    `${aggregate.requestCount} request${aggregate.requestCount === 1 ? "" : "s"}`,
    formatDuration(aggregate.durationMs),
    `${aggregate.retryCount} retr${aggregate.retryCount === 1 ? "y" : "ies"}`
  ].join(", ");
}

function formatCacheHitRate(aggregate: UsageAggregate): string {
  if (aggregate.inputTokens <= 0) {
    return "0%";
  }

  return `${Math.round((aggregate.cacheReadTokens / aggregate.inputTokens) * 100)}%`;
}

function formatCostSummary(aggregate: UsageAggregate): string {
  if (aggregate.estimatedCostUsd !== undefined && aggregate.unknownCostEventCount > 0) {
    return `${formatUsd(aggregate.estimatedCostUsd)} partial; tokens only for unknown pricing`;
  }

  if (aggregate.estimatedCostUsd !== undefined) {
    return formatUsd(aggregate.estimatedCostUsd);
  }

  return "tokens only; no provider/model price metadata";
}

function formatCostForAggregate(aggregate: UsageAggregate): string {
  if (aggregate.estimatedCostUsd !== undefined && aggregate.unknownCostEventCount > 0) {
    return `${formatUsd(aggregate.estimatedCostUsd)} partial; tokens only`;
  }

  if (aggregate.estimatedCostUsd !== undefined) {
    return formatUsd(aggregate.estimatedCostUsd);
  }

  return aggregate.usageEventCount > 0 ? "tokens only" : "usage unavailable";
}

function formatTokenCount(value: number): string {
  return Math.trunc(value).toLocaleString("en-US");
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  if (seconds < 10) {
    return `${trimFixed(seconds, 1)}s`;
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

function formatUsd(value: number): string {
  if (value === 0) {
    return "$0";
  }

  if (Math.abs(value) < 0.01) {
    return `$${trimFixed(value, 6)}`;
  }

  return `$${trimFixed(value, 4)}`;
}

function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, "");
}
