import { z } from "zod";
import type { SubagentTaskInfo, ToolExecutionContext } from "../types.js";
import { TASK_GET_TOOL_DESCRIPTION, TASK_GET_TOOL_NAME } from "./prompt.js";

export const TaskGetInputSchema = z
  .object({
    task_id: z
      .string()
      .trim()
      .min(1)
      .describe("The task_id returned by AgentTool or TaskList.")
  })
  .strict();

export type TaskGetResult =
  | {
      status: "not_found";
      task_id: string;
      message: string;
    }
  | {
      status: SubagentTaskInfo["status"];
      task_id: string;
      agent_type: string;
      description: string;
      model: string;
      max_steps: number;
      created_at: string;
      updated_at: string;
      started_at?: string;
      completed_at?: string;
      output?: string;
      error?: string;
      progress: Array<{
        timestamp: string;
        type: string;
        message?: string;
        tool_name?: string;
        raw_arguments?: string;
        result?: string;
      }>;
      worktree_path?: string;
      diff_summary?: string;
      has_changes?: boolean;
    };

export { TASK_GET_TOOL_DESCRIPTION, TASK_GET_TOOL_NAME };

export async function executeTaskGetTool(
  input: z.infer<typeof TaskGetInputSchema>,
  context: ToolExecutionContext
): Promise<TaskGetResult> {
  if (!context.getSubagentTask) {
    throw new Error("TaskGet is not available in this execution context.");
  }

  const task = await context.getSubagentTask(input.task_id);
  if (!task) {
    return {
      status: "not_found",
      task_id: input.task_id,
      message: `Unknown subagent task_id: ${input.task_id}`
    };
  }
  await context.recordSubagentTaskRetrieved?.(input.task_id, task);

  return {
    status: task.status,
    task_id: task.taskId,
    agent_type: task.agentType,
    description: task.description,
    model: task.model,
    max_steps: task.maxSteps,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    ...(task.startedAt ? { started_at: task.startedAt } : {}),
    ...(task.completedAt ? { completed_at: task.completedAt } : {}),
    ...(task.output !== undefined ? { output: task.output } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    progress: task.progress.map((event) => ({
      timestamp: event.timestamp,
      type: event.type,
      ...(event.message ? { message: event.message } : {}),
      ...(event.toolName ? { tool_name: event.toolName } : {}),
      ...(event.rawArguments ? { raw_arguments: event.rawArguments } : {}),
      ...(event.result ? { result: event.result } : {})
    })),
    ...(task.worktreePath ? { worktree_path: task.worktreePath } : {}),
    ...(task.diffSummary ? { diff_summary: task.diffSummary } : {}),
    ...(task.hasChanges !== undefined ? { has_changes: task.hasChanges } : {})
  };
}
