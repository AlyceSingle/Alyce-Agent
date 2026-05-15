import type { TerminalUiTaskSummary } from "../state/types.js";
import { Box, Text } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";

const MAX_VISIBLE_TASKS = 4;

export function TaskPanel(props: { tasks: TerminalUiTaskSummary[] }) {
  const visibleTasks = props.tasks.slice(0, MAX_VISIBLE_TASKS);
  const hiddenCount = props.tasks.length - visibleTasks.length;
  const runningCount = props.tasks.filter((task) => task.status === "running").length;
  const unreadCount = props.tasks.filter((task) => task.status === "completed" && task.unread).length;
  const failedCount = props.tasks.filter((task) => task.status === "failed").length;

  return (
    <Box flexDirection="column" width="100%">
      <Text color={terminalUiTheme.colors.info} wrap="truncate-end">
        Background Tasks {formatCounts(runningCount, unreadCount, failedCount)}
      </Text>
      {visibleTasks.map((task) => (
        <Text
          key={task.taskId}
          color={getTaskColor(task)}
          wrap="truncate-end"
        >
          {getTaskPrefix(task)}
          {" "}
          {task.taskId.slice(0, 8)} {task.agentType} {task.description}
        </Text>
      ))}
      {hiddenCount > 0 ? (
        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          +{hiddenCount} more background task{hiddenCount === 1 ? "" : "s"}
        </Text>
      ) : null}
    </Box>
  );
}

function formatCounts(runningCount: number, unreadCount: number, failedCount: number) {
  const parts = [
    runningCount > 0 ? `${runningCount} running` : null,
    unreadCount > 0 ? `${unreadCount} unread` : null,
    failedCount > 0 ? `${failedCount} failed` : null
  ].filter((value): value is string => value !== null);

  return parts.length > 0 ? `(${parts.join(", ")})` : "(idle)";
}

function getTaskPrefix(task: TerminalUiTaskSummary) {
  if (task.status === "running") {
    return "[>]";
  }

  if (task.status === "completed") {
    return task.unread ? "[!]" : "[x]";
  }

  if (task.status === "failed") {
    return "[!]";
  }

  return "[-]";
}

function getTaskColor(task: TerminalUiTaskSummary) {
  if (task.status === "running") {
    return terminalUiTheme.colors.warning;
  }

  if (task.status === "failed") {
    return terminalUiTheme.colors.danger;
  }

  if (task.status === "completed" && task.unread) {
    return terminalUiTheme.colors.success;
  }

  return terminalUiTheme.colors.subtle;
}
