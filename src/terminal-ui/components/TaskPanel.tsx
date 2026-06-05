import type { TerminalUiTaskSummary } from "../state/types.js";
import Box from "../runtime/ink-runtime/components/Box.js";
import Text from "../runtime/ink-runtime/components/Text.js";
import { terminalUiTheme } from "../theme/theme.js";

const MAX_VISIBLE_TASKS = 4;

export function TaskPanel(props: { tasks: TerminalUiTaskSummary[] }) {
  const visibleTasks = props.tasks.slice(0, MAX_VISIBLE_TASKS);
  const hiddenCount = props.tasks.length - visibleTasks.length;

  return (
    <Box flexDirection="column" width="100%">
      <Text color={terminalUiTheme.colors.info} wrap="truncate-end">
        Background Tasks ({props.tasks.length} running)
      </Text>
      {visibleTasks.map((task) => (
        <Text
          key={task.taskId}
          color={terminalUiTheme.colors.warning}
          wrap="truncate-end"
        >
          {"[>]"}
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
