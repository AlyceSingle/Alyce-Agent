import type {
  SubagentTaskInfo,
  SubagentTaskStatus,
  SubagentTaskStopResult
} from "../tools/types.js";

const DETAIL_OUTPUT_MAX_CHARS = 4000;
const DETAIL_PROGRESS_LIMIT = 12;
const COMPLETION_OUTPUT_MAX_CHARS = 900;

export interface TaskCounts {
  running: number;
  completedUnread: number;
  failed: number;
}

export function summarizeTaskCounts(tasks: readonly SubagentTaskInfo[], unreadTaskIds = new Set<string>()): TaskCounts {
  return tasks.reduce<TaskCounts>(
    (counts, task) => {
      if (task.status === "running") {
        counts.running += 1;
      } else if (task.status === "completed" && unreadTaskIds.has(task.taskId)) {
        counts.completedUnread += 1;
      } else if (task.status === "failed") {
        counts.failed += 1;
      }

      return counts;
    },
    { running: 0, completedUnread: 0, failed: 0 }
  );
}

export function formatTaskCounts(counts: TaskCounts): string {
  const parts = [
    counts.running > 0 ? `${counts.running} running` : null,
    counts.completedUnread > 0 ? `${counts.completedUnread} unread` : null,
    counts.failed > 0 ? `${counts.failed} failed` : null
  ].filter((value): value is string => value !== null);

  return parts.length > 0 ? parts.join(", ") : "";
}

export function formatTaskList(tasks: readonly SubagentTaskInfo[], unreadTaskIds = new Set<string>()): string {
  if (tasks.length === 0) {
    return "No background subagent tasks in this session.";
  }

  const counts = summarizeTaskCounts(tasks, unreadTaskIds);
  const lines = [
    "Background Tasks",
    `Summary: ${formatTaskCounts(counts) || "none active"}`,
    "",
    ...tasks.map((task) => formatTaskLine(task, unreadTaskIds.has(task.taskId))),
    "",
    "Use /tasks get <id> for details, /tasks stop <id> to stop a running task, or /tasks cleanup to inspect stale task storage."
  ];

  return lines.join("\n");
}

export function formatTaskDetails(task: SubagentTaskInfo | undefined, taskId: string): string {
  if (!task) {
    return `Unknown subagent task_id: ${taskId}`;
  }

  const lines = [
    `Task ${task.taskId}`,
    `Status: ${task.status}`,
    `Agent: ${task.agentType}`,
    `Description: ${task.description}`,
    `Model: ${task.model}`,
    `Max steps: ${task.maxSteps}`,
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`,
    ...(task.startedAt ? [`Started: ${task.startedAt}`] : []),
    ...(task.completedAt ? [`Completed: ${task.completedAt}`] : []),
    ...(task.worktreePath ? [`Worktree: ${task.worktreePath}`] : []),
    ...(task.transcriptPath ? [`Transcript: ${task.transcriptPath}`] : []),
    ...(task.outputPath ? [`Output file: ${task.outputPath}`] : []),
    ...(task.hasChanges !== undefined ? [`Worktree changes: ${task.hasChanges ? "yes" : "no"}`] : []),
    ...(task.diffSummary ? ["", "Diff summary:", task.diffSummary] : []),
    ...(task.error ? ["", "Error:", task.error] : []),
    "",
    "Progress:",
    ...formatProgress(task),
    "",
    "Output:",
    formatOptionalBlock(task.output, DETAIL_OUTPUT_MAX_CHARS)
  ];

  return lines.join("\n");
}

export function formatTaskStopResult(result: SubagentTaskStopResult): string {
  if (result.status === "not_found" || !result.task) {
    return [
      "Task stop result",
      `Task: ${result.taskId}`,
      `Status: ${result.status}`,
      result.message
    ].join("\n");
  }

  return [
    "Task stop result",
    `Task: ${result.taskId}`,
    `Status: ${result.status}`,
    result.message,
    "",
    formatTaskLine(result.task, false)
  ].join("\n");
}

export function formatTaskCompletionNotification(task: SubagentTaskInfo): string {
  const lines = [
    `Background task ${task.status}.`,
    `Task: ${task.taskId}`,
    `Agent: ${task.agentType}`,
    `Description: ${task.description}`,
    ...(task.worktreePath ? [`Worktree: ${task.worktreePath}`] : []),
    ...(task.hasChanges !== undefined ? [`Worktree changes: ${task.hasChanges ? "yes" : "no"}`] : []),
    ...(task.diffSummary ? ["", "Diff summary:", task.diffSummary] : []),
    ...(task.error ? ["", "Error:", task.error] : []),
    ...(task.output ? ["", "Result:", formatOptionalBlock(task.output, COMPLETION_OUTPUT_MAX_CHARS)] : []),
    "",
    `Use /tasks get ${task.taskId} for full details.`
  ];

  return lines.join("\n");
}

export function isTerminalTaskStatus(status: SubagentTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

function formatTaskLine(task: SubagentTaskInfo, unread: boolean): string {
  const flags = [
    unread ? "unread" : null,
    task.hasChanges === true ? "changes" : null,
    task.hasChanges === false ? "no changes" : null,
    task.worktreePath ? "worktree" : null
  ].filter((value): value is string => value !== null);
  const suffix = flags.length > 0 ? ` [${flags.join(", ")}]` : "";

  return `- ${task.taskId.slice(0, 8)} | ${task.status} | ${task.agentType} | ${task.description}${suffix}`;
}

function formatProgress(task: SubagentTaskInfo): string[] {
  if (task.progress.length === 0) {
    return ["(no progress events loaded)"];
  }

  const visible = task.progress.slice(-DETAIL_PROGRESS_LIMIT);
  const hiddenCount = task.progress.length - visible.length;
  const lines = visible.map((event) => {
    const detail = event.message ?? event.toolName ?? event.type;
    return `- ${event.timestamp} | ${event.type} | ${detail}`;
  });

  if (hiddenCount > 0) {
    lines.unshift(`... ${hiddenCount} older event(s) omitted`);
  }

  return lines;
}

function formatOptionalBlock(value: string | undefined, maxChars: number): string {
  if (!value?.trim()) {
    return "(empty)";
  }

  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars).trimEnd()}\n... truncated; use the output/transcript path above for full logs.`;
}
