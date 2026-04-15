import { z } from "zod";
import type { TodoItem } from "../types.js";
import type { ToolExecutionContext } from "../types.js";
import { TODO_WRITE_TOOL_NAME } from "./constants.js";
import { TODO_WRITE_TOOL_DESCRIPTION } from "./prompt.js";

const TodoStatusSchema = z.enum(["pending", "in_progress", "completed"]);

export const TodoItemSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1)
      .describe("Imperative task description, for example 'Run tests'."),
    activeForm: z
      .string()
      .trim()
      .min(1)
      .describe("In-progress wording, for example 'Running tests'."),
    status: TodoStatusSchema.describe("Current task status.")
  })
  .strict();

export const TodoWriteInputSchema = z
  .object({
    todos: z.array(TodoItemSchema).describe("The full updated todo list for the current session.")
  })
  .strict()
  .superRefine((value, context) => {
    const normalizedContents = value.todos.map((todo) => todo.content.trim().toLowerCase());
    if (normalizedContents.length !== new Set(normalizedContents).size) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Todo content entries must be unique."
      });
    }

    const inProgressCount = value.todos.filter((todo) => todo.status === "in_progress").length;
    const hasUnfinishedTask = value.todos.some((todo) => todo.status !== "completed");

    if (inProgressCount > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At most one todo may be in_progress."
      });
    }

    if (hasUnfinishedTask && inProgressCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one todo must be in_progress when unfinished tasks remain."
      });
    }
  });

export const TodoWriteOutputSchema = z
  .object({
    oldTodos: z.array(TodoItemSchema),
    newTodos: z.array(TodoItemSchema)
  })
  .strict();

export type TodoWriteResult = z.infer<typeof TodoWriteOutputSchema>;

export { TODO_WRITE_TOOL_NAME, TODO_WRITE_TOOL_DESCRIPTION };

export async function executeTodoWriteTool(
  input: z.infer<typeof TodoWriteInputSchema>,
  context: ToolExecutionContext
): Promise<TodoWriteResult> {
  const oldTodos = context.getTodos();
  const normalizedTodos = normalizeTodos(input.todos);
  const allCompleted = normalizedTodos.length > 0 && normalizedTodos.every((todo) => todo.status === "completed");
  const newTodos = allCompleted ? [] : normalizedTodos;

  context.setTodos(newTodos);

  return {
    oldTodos,
    newTodos
  };
}

function normalizeTodos(todos: TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({
    content: todo.content.trim(),
    activeForm: todo.activeForm.trim(),
    status: todo.status
  }));
}
