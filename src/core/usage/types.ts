import type { ResolvedModelProfile } from "../providers/types.js";

export type UsageSource =
  | "main"
  | "subagent"
  | "compact"
  | "session_memory"
  | "title";

export interface ModelTokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ModelUsageEvent {
  requestedModel: string;
  resolvedModel?: ResolvedModelProfile;
  usage?: ModelTokenUsage | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  retryCount: number;
}

export interface UsageRecordInput extends ModelUsageEvent {
  source: UsageSource;
  turnId?: string;
  taskId?: string;
  label?: string;
}

export interface UsageTokens {
  input: number;
  output: number;
  total: number;
  hasUsage: boolean;
}

export interface UsageEvent extends Omit<UsageRecordInput, "resolvedModel"> {
  id: string;
  providerId: string;
  modelId: string;
  providerModel: string;
  tokens: UsageTokens;
  estimatedCostUsd?: number;
}

export interface UsageAggregate {
  key: string;
  label: string;
  providerId?: string;
  modelId?: string;
  source?: UsageSource;
  turnId?: string;
  taskId?: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  usageEventCount: number;
  durationMs: number;
  retryCount: number;
  estimatedCostUsd?: number;
  unknownCostEventCount: number;
  firstStartedAt?: string;
  lastCompletedAt?: string;
}

export interface UsageSessionSummary {
  eventCount: number;
  totals: UsageAggregate;
  byProviderModel: UsageAggregate[];
  bySource: UsageAggregate[];
  recentTurns: UsageAggregate[];
  subagents: UsageAggregate[];
  latestTurn?: UsageAggregate;
}
