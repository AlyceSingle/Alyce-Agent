import React from "react";
import type { TodoItem } from "../../tools/types.js";
import { Box, Text } from "../runtime/ink.js";
import { terminalUiTheme } from "../theme/theme.js";

const MAX_VISIBLE_TODOS = 5;

export function TodoPanel(props: { todos: TodoItem[] }) {
  const sortedTodos = sortTodos(props.todos);
  const visibleTodos = sortedTodos.slice(0, MAX_VISIBLE_TODOS);
  const hiddenCount = sortedTodos.length - visibleTodos.length;
  const completedCount = props.todos.filter((todo) => todo.status === "completed").length;

  return (
    <Box flexDirection="column" width="100%">
      <Text color={terminalUiTheme.colors.info} wrap="truncate-end">
        Tasks {completedCount}/{props.todos.length}
      </Text>
      {visibleTodos.map((todo) => (
        <Text
          key={`${todo.content}:${todo.status}`}
          color={getTodoColor(todo.status)}
          wrap="truncate-end"
        >
          {getTodoPrefix(todo.status)}
          {" "}
          {todo.status === "in_progress" ? todo.activeForm : todo.content}
        </Text>
      ))}
      {hiddenCount > 0 ? (
        <Text color={terminalUiTheme.colors.subtle} wrap="truncate-end">
          +{hiddenCount} more task{hiddenCount === 1 ? "" : "s"}
        </Text>
      ) : null}
    </Box>
  );
}

function sortTodos(todos: TodoItem[]) {
  const statusOrder: Record<TodoItem["status"], number> = {
    in_progress: 0,
    pending: 1,
    completed: 2
  };

  return [...todos].sort((left, right) => {
    const orderComparison = statusOrder[left.status] - statusOrder[right.status];
    if (orderComparison !== 0) {
      return orderComparison;
    }

    return left.content.localeCompare(right.content);
  });
}

function getTodoPrefix(status: TodoItem["status"]) {
  if (status === "completed") {
    return "[x]";
  }

  if (status === "in_progress") {
    return "[>]";
  }

  return "[ ]";
}

function getTodoColor(status: TodoItem["status"]) {
  if (status === "completed") {
    return terminalUiTheme.colors.subtle;
  }

  if (status === "in_progress") {
    return terminalUiTheme.colors.warning;
  }

  return terminalUiTheme.colors.muted;
}
