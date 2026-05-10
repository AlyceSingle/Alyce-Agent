import { isLspSupportedFile } from "../../services/lsp/LspRuntimeService.js";
import { executeLspRuntimeQueryAsync } from "../../services/lsp/LspRuntimeWorkerClient.js";
import { throwIfAborted } from "../../core/abort.js";
import type { ToolExecutionContext } from "../types.js";
import { DESCRIPTION, LSP_TOOL_NAME } from "./prompt.js";
import {
  LSP_OPERATION_VALUES,
  LSPToolInputSchema,
  LSPToolOutputSchema,
  type LSPToolInput,
  type LSPToolResult
} from "./schemas.js";

const MAX_OBSERVATION_ERROR_CHARS = 300;

type LspObservationOutcome = "ok" | "error";

type LspOperationObservationStats = {
  operation: LSPToolInput["operation"];
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalDurationMs: number;
  maxDurationMs: number;
};

type LspObservationStatsSnapshot = {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  totalDurationMs: number;
  averageDurationMs: number;
  maxDurationMs: number;
  operations: LspOperationObservationStats[];
  lastObservation: {
    operation: LSPToolInput["operation"];
    outcome: LspObservationOutcome;
    durationMs: number;
    timestamp: string;
    resultCount?: number;
    fileCount?: number;
    errorMessage?: string;
  } | null;
};

type LspObservationInput = {
  operation: LSPToolInput["operation"];
  outcome: LspObservationOutcome;
  durationMs: number;
  resultCount?: number;
  fileCount?: number;
  errorMessage?: string;
};

const lspObservationStats = createEmptyLspObservationStats();

export const LSPInputSchema = LSPToolInputSchema;
export const LSPOutputSchema = LSPToolOutputSchema;
export type { LSPToolInput, LSPToolResult };
export { LSP_TOOL_NAME, DESCRIPTION as LSP_TOOL_DESCRIPTION };
export const __LSP_TOOL_TESTING__ = {
  isLspSupportedFile,
  recordLspObservation,
  getLspObservationStatsSnapshot,
  resetLspObservationStats
};

export async function executeLSPTool(
  input: LSPToolInput,
  context: ToolExecutionContext
): Promise<LSPToolResult> {
  const startedAtMs = Date.now();
  throwIfAborted(context.abortSignal);

  try {
    const toolResult = await executeLspRuntimeQueryAsync({
      operation: input.operation,
      filePath: input.filePath,
      workspaceRoot: context.workspaceRoot,
      allowedRoots: context.allowedRoots,
      line: input.line,
      character: input.character,
      query: input.query,
      maxResults: input.maxResults,
      abortSignal: context.abortSignal
    });
    recordLspObservation({
      operation: input.operation,
      outcome: "ok",
      durationMs: Date.now() - startedAtMs,
      resultCount: toolResult.resultCount,
      fileCount: toolResult.fileCount
    });
    return toolResult;
  } catch (error) {
    recordLspObservation({
      operation: input.operation,
      outcome: "error",
      durationMs: Date.now() - startedAtMs,
      errorMessage: truncateObservationError(error)
    });
    throw error;
  }
}

function truncateObservationError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_OBSERVATION_ERROR_CHARS);
}

function createEmptyOperationStats(): Record<LSPToolInput["operation"], LspOperationObservationStats> {
  return Object.fromEntries(
    LSP_OPERATION_VALUES.map((operation) => [
      operation,
      {
        operation,
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        totalDurationMs: 0,
        maxDurationMs: 0
      }
    ])
  ) as Record<LSPToolInput["operation"], LspOperationObservationStats>;
}

function createEmptyLspObservationStats() {
  return {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    operationStats: createEmptyOperationStats(),
    lastObservation: null as LspObservationStatsSnapshot["lastObservation"]
  };
}

function recordLspObservation(observation: LspObservationInput) {
  const durationMs = Math.max(0, Math.trunc(observation.durationMs));
  const operationStats = lspObservationStats.operationStats[observation.operation];

  lspObservationStats.totalCalls += 1;
  lspObservationStats.totalDurationMs += durationMs;
  lspObservationStats.maxDurationMs = Math.max(lspObservationStats.maxDurationMs, durationMs);
  if (observation.outcome === "ok") {
    lspObservationStats.successfulCalls += 1;
  } else {
    lspObservationStats.failedCalls += 1;
  }

  operationStats.totalCalls += 1;
  operationStats.totalDurationMs += durationMs;
  operationStats.maxDurationMs = Math.max(operationStats.maxDurationMs, durationMs);
  if (observation.outcome === "ok") {
    operationStats.successfulCalls += 1;
  } else {
    operationStats.failedCalls += 1;
  }

  lspObservationStats.lastObservation = {
    operation: observation.operation,
    outcome: observation.outcome,
    durationMs,
    timestamp: new Date().toISOString(),
    ...(observation.resultCount !== undefined ? { resultCount: observation.resultCount } : {}),
    ...(observation.fileCount !== undefined ? { fileCount: observation.fileCount } : {}),
    ...(observation.errorMessage ? { errorMessage: observation.errorMessage } : {})
  };
}

function getLspObservationStatsSnapshot(): LspObservationStatsSnapshot {
  const operations = LSP_OPERATION_VALUES.map((operation) => {
    const stats = lspObservationStats.operationStats[operation];
    return {
      operation,
      totalCalls: stats.totalCalls,
      successfulCalls: stats.successfulCalls,
      failedCalls: stats.failedCalls,
      totalDurationMs: stats.totalDurationMs,
      maxDurationMs: stats.maxDurationMs
    };
  });

  return {
    totalCalls: lspObservationStats.totalCalls,
    successfulCalls: lspObservationStats.successfulCalls,
    failedCalls: lspObservationStats.failedCalls,
    totalDurationMs: lspObservationStats.totalDurationMs,
    averageDurationMs:
      lspObservationStats.totalCalls > 0
        ? Number((lspObservationStats.totalDurationMs / lspObservationStats.totalCalls).toFixed(2))
        : 0,
    maxDurationMs: lspObservationStats.maxDurationMs,
    operations,
    lastObservation: lspObservationStats.lastObservation
  };
}

function resetLspObservationStats() {
  const empty = createEmptyLspObservationStats();
  lspObservationStats.totalCalls = empty.totalCalls;
  lspObservationStats.successfulCalls = empty.successfulCalls;
  lspObservationStats.failedCalls = empty.failedCalls;
  lspObservationStats.totalDurationMs = empty.totalDurationMs;
  lspObservationStats.maxDurationMs = empty.maxDurationMs;
  lspObservationStats.operationStats = empty.operationStats;
  lspObservationStats.lastObservation = empty.lastObservation;
}
