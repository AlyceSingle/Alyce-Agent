import path from "node:path";
import process from "node:process";
import type { RuntimeBootstrapReport, RuntimePaths } from "../../../config/runtime.js";
import type { FileHistoryRestoreResult } from "../../../core/file-history/fileHistoryManager.js";
import { formatDateTime } from "../../../i18n/index.js";
import type { SubagentTaskInfo } from "../../../tools/types.js";

export function formatSessionTime(value: string): string {
  return formatDateTime(value);
}

export function formatRestoreConflictLines(
  conflicts: FileHistoryRestoreResult["conflicts"],
  limit = 20
): string[] {
  const visibleConflicts = conflicts.slice(0, limit);
  const lines = visibleConflicts.map((conflict) =>
    `- ${formatRestoreConflictPath(conflict.absolutePath)}: ${formatRestoreConflictReason(conflict.reason)}`
  );
  const hiddenCount = conflicts.length - visibleConflicts.length;
  if (hiddenCount > 0) {
    lines.push(`- ... ${hiddenCount} more conflict(s)`);
  }

  return lines;
}

function formatRestoreConflictPath(absolutePath: string) {
  const relative = path.relative(process.cwd(), absolutePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, "/")
    : absolutePath;
}

function formatRestoreConflictReason(reason: FileHistoryRestoreResult["conflicts"][number]["reason"]) {
  switch (reason) {
    case "current-file-missing":
      return "current file is missing";
    case "current-file-recreated":
      return "path was recreated after the turn";
    case "current-content-changed":
      return "current content changed after the turn";
  }
}

export function formatRuntimeBootstrapSummary(
  report: RuntimeBootstrapReport,
  paths: RuntimePaths
): string | null {
  if (report.createdPaths.length === 0 && report.failedPaths.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (report.createdPaths.length > 0) {
    parts.push(
      `Runtime storage ready: ${report.createdPaths.length} path(s) initialized`,
      `state: ${paths.workspaceRuntimeDirectory}`,
      `user skills: ${paths.userSkillsDirectory}`,
      `project assets load after /trust`
    );
  }

  if (report.failedPaths.length > 0) {
    parts.push(
      `failed: ${report.failedPaths.length}`,
      `details: ${report.failedPaths
        .slice(0, 5)
        .map((failure) => `- ${failure.path}: ${failure.error}`)
        .join("; ")}`
    );
  }

  return parts.join("; ");
}

export function isNotifiableBackgroundTask(task: Pick<SubagentTaskInfo, "agentType">): boolean {
  return task.agentType !== "auto-reviewer";
}

export function isVisibleBackgroundTask(task: Pick<SubagentTaskInfo, "agentType" | "status">): boolean {
  return isNotifiableBackgroundTask(task) && task.status === "running";
}

export function isVisibleBackgroundProcess(process: { status: string }): boolean {
  return process.status === "running";
}

export async function waitForUiPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export function isFileRestoreAvailable(options: {
  hasTrackedChanges: boolean;
  canRestore: boolean;
  alreadyRestored: boolean;
}) {
  return options.hasTrackedChanges && (options.canRestore || options.alreadyRestored);
}
