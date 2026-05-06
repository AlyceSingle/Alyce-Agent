import { z } from "zod";
import type { SubagentTaskInfo, ToolExecutionContext } from "../types.js";
import { TASK_LIST_TOOL_DESCRIPTION, TASK_LIST_TOOL_NAME } from "./prompt.js";

export const TaskListInputSchema = z
  .object({
    include_completed: z
      .boolean()
      .optional()
      .describe("When false, omit completed tasks. Defaults to true.")
  })
  .strict();

export interface TaskListResult {
  tasks: SubagentTaskSummary[];
}

interface SubagentTaskSummary {
  task_id: string;
  agent_type: string;
  description: string;
  status: SubagentTaskInfo["status"];
  model: string;
  max_steps: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  has_output: boolean;
  progress_count: number;
  worktree_path?: string;
  has_changes?: boolean;
  error?: string;
}

export { TASK_LIST_TOOL_DESCRIPTION, TASK_LIST_TOOL_NAME };

export async function executeTaskListTool(
  input: z.infer<typeof TaskListInputSchema>,
  context: ToolExecutionContext
): Promise<TaskListResult> {
  if (!context.listSubagentTasks) {
    throw new Error("TaskList is not available in this execution context.");
  }

  const includeCompleted = input.include_completed ?? true;
  const tasks = context
    .listSubagentTasks()
    .filter((task) => includeCompleted || task.status !== "completed")
    .map(toTaskSummary);

  return {
    tasks
  };
}

function toTaskSummary(task: SubagentTaskInfo): SubagentTaskSummary {
  return {
    task_id: task.taskId,
    agent_type: task.agentType,
    description: task.description,
    status: task.status,
    model: task.model,
    max_steps: task.maxSteps,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    ...(task.startedAt ? { started_at: task.startedAt } : {}),
    ...(task.completedAt ? { completed_at: task.completedAt } : {}),
    has_output: task.output !== undefined,
    progress_count: task.progress.length,
    ...(task.worktreePath ? { worktree_path: task.worktreePath } : {}),
    ...(task.hasChanges !== undefined ? { has_changes: task.hasChanges } : {}),
    ...(task.error !== undefined ? { error: task.error } : {})
  };
}
