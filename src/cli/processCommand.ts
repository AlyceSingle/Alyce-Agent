import type {
  BackgroundProcessRecord,
  BackgroundProcessStatus,
  BackgroundProcessStopResult
} from "../core/background-process/backgroundProcessTypes.js";

export interface BackgroundProcessCounts {
  running: number;
  starting: number;
  failed: number;
}

export function summarizeBackgroundProcessCounts(
  processes: readonly BackgroundProcessRecord[]
): BackgroundProcessCounts {
  return processes.reduce<BackgroundProcessCounts>(
    (counts, process) => {
      if (process.status === "running") {
        counts.running += 1;
      } else if (process.status === "starting") {
        counts.starting += 1;
      } else if (process.status === "failed") {
        counts.failed += 1;
      }

      return counts;
    },
    { running: 0, starting: 0, failed: 0 }
  );
}

export function formatBackgroundProcessCounts(counts: BackgroundProcessCounts): string {
  const parts = [
    counts.running > 0 ? `${counts.running} running` : null,
    counts.starting > 0 ? `${counts.starting} starting` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null
  ].filter((value): value is string => value !== null);

  return parts.length > 0 ? parts.join(", ") : "";
}

export function formatBackgroundProcessList(
  processes: readonly BackgroundProcessRecord[]
): string {
  if (processes.length === 0) {
    return "No managed background processes are running.";
  }

  const counts = summarizeBackgroundProcessCounts(processes);
  return [
    "Background Processes",
    `Summary: ${formatBackgroundProcessCounts(counts) || "none active"}`,
    "",
    ...processes.map(formatBackgroundProcessLine),
    "",
    "Use /stop <id> to stop a running process."
  ].join("\n");
}

export function formatBackgroundProcessStopResult(result: BackgroundProcessStopResult): string {
  if (result.status === "not_found" || !result.record) {
    return [
      "Background process stop result",
      `Process: ${result.processId}`,
      `Status: ${result.status}`,
      result.message
    ].join("\n");
  }

  return [
    "Background process stop result",
    `Process: ${result.processId}`,
    `Status: ${result.status}`,
    result.message,
    "",
    formatBackgroundProcessLine(result.record)
  ].join("\n");
}

export function isTerminalBackgroundProcessStatus(status: BackgroundProcessStatus): boolean {
  return status === "exited" || status === "failed" || status === "stopped";
}

function formatBackgroundProcessLine(process: BackgroundProcessRecord): string {
  const pid = process.pid === null ? "pid ?" : `pid ${process.pid}`;
  const url = process.detectedUrls[0] ? ` | ${process.detectedUrls[0]}` : "";
  const label = process.label ? ` | ${process.label}` : "";
  const warning = process.warnings[0] ? ` | warning: ${process.warnings[0]}` : "";
  const error = process.lastError ? ` | error: ${process.lastError}` : "";

  return `- ${process.id} | ${process.status} | ${pid} | ${process.command}${label}${url}${warning}${error}`;
}
