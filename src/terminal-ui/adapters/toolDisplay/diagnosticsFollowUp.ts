import type { TerminalUiMessage, TerminalUiMessageBlockTone } from "../../state/types.js";
import type { LspDiagnosticCompletedEvent } from "../../../services/lsp/LspDiagnosticRegistry.js";
import {
  asString,
  createBlock,
  createMessage,
  TOOL_PREVIEW_MAX_CHARS,
  TOOL_TITLE_MAX_CHARS,
  truncateInline,
  type DiagnosticsDisplayResult
} from "./common.js";
import {
  formatDiagnosticCode,
  formatDiagnosticsMetadata,
  formatDiagnosticsResult
} from "./writeDisplay.js";

// 后台 LSP diagnostics 完成消息。

export function createDiagnosticsFollowUpMessage(event: LspDiagnosticCompletedEvent) {
  const diagnostics = toDiagnosticsDisplayResult(event);

  return createMessage({
    kind: "system",
    title: `Diagnostics ${truncateInline(event.filePath, TOOL_TITLE_MAX_CHARS - "Diagnostics ".length)}`,
    blocks: [
      createBlock(formatDiagnosticsFollowUpSummary(event), {
        label: "Summary",
        tone: diagnosticsTone(diagnostics.status),
        style: "code"
      }),
      createBlock(formatDiagnosticsResult(diagnostics), {
        label: "Diagnostics",
        tone: diagnosticsTone(diagnostics.status),
        style: "code"
      })
    ],
    metadata: [
      "Diagnostics follow-up",
      "Background",
      formatDiagnosticsMetadata(diagnostics),
      `Reason: ${event.completionReason}`,
      ...(event.duplicateIssueCount > 0 ? [`Deduped: ${event.duplicateIssueCount}`] : []),
      ...(event.omittedIssueCount > 0 ? [`Omitted: ${event.omittedIssueCount}`] : []),
      ...(event.groupedFileCount > 1 ? [`Files: ${event.groupedFileCount}`] : []),
      ...(event.circuitBreakerOpen
        ? [event.circuitBreakerOpenUntil
          ? `Circuit: open until ${event.circuitBreakerOpenUntil}`
          : "Circuit: open"]
        : []),
      `${event.durationMs} ms`
    ],
    maxPreviewChars: TOOL_PREVIEW_MAX_CHARS
  });
}

export function formatDiagnosticsFollowUpForModel(event: LspDiagnosticCompletedEvent) {
  const diagnostics = toDiagnosticsDisplayResult(event);
  return [
    "# Background Diagnostics Completed",
    formatDiagnosticsFollowUpSummary(event),
    "",
    "Diagnostics:",
    formatDiagnosticsResult(diagnostics)
  ].join("\n");
}

export function toDiagnosticsDisplayResult(event: LspDiagnosticCompletedEvent): DiagnosticsDisplayResult {
  return {
    status: event.status,
    backend: event.backend,
    issues: event.issues.map((issue) => ({ ...issue })),
    totalIssueCount: event.totalIssueCount,
    truncated: event.truncated,
    message: event.message
  };
}

export function formatDiagnosticsFollowUpSummary(event: LspDiagnosticCompletedEvent) {
  const lines = [
    `File: ${event.filePath}`,
    `Status: ${event.status}`,
    `Source: ${event.source}`,
    `Completion: ${event.completionReason}`,
    `Started: ${event.startedAt}`,
    `Completed: ${event.completedAt}`,
    `Duration: ${event.durationMs} ms`
  ];
  if (event.backend) {
    lines.push(`Backend: ${event.backend}`);
  }
  lines.push(`Issues: ${event.totalIssueCount} total, ${event.issues.length} shown`);
  if (event.duplicateIssueCount > 0) {
    lines.push(`Deduped duplicates: ${event.duplicateIssueCount}`);
  }
  if (event.omittedIssueCount > 0) {
    lines.push(`Omitted after cap: ${event.omittedIssueCount}`);
  }
  if (event.groupedFileCount > 1) {
    lines.push(`Grouped files: ${event.groupedFileCount}`);
  }
  if (event.failureStreak > 0) {
    lines.push(`Failure streak: ${event.failureStreak}`);
  }
  if (event.circuitBreakerOpen) {
    lines.push(
      event.circuitBreakerOpenUntil
        ? `Circuit breaker: open until ${event.circuitBreakerOpenUntil}`
        : "Circuit breaker: open"
    );
  }
  if (event.message) {
    lines.push(`Message: ${event.message}`);
  }

  return lines.join("\n");
}

export function diagnosticsTone(status: DiagnosticsDisplayResult["status"]): TerminalUiMessageBlockTone {
  if (status === "issues" || status === "failed") {
    return "warning";
  }

  if (status === "pending") {
    return "info";
  }

  return "success";
}
