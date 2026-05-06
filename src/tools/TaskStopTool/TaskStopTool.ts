import { z } from "zod";
import type { SubagentTaskInfo, ToolExecutionContext } from "../types.js";
import { TASK_STOP_TOOL_DESCRIPTION, TASK_STOP_TOOL_NAME } from "./prompt.js";

export const TaskStopInputSchema = z
  .object({
    task_id: z
      .string()
      .trim()
      .min(1)
      .describe("The running task_id returned by AgentTool or TaskList.")
  })
  .strict();

export type TaskStopResult =
  | {
      status: "not_found";
      task_id: string;
      message: string;
    }
  | {
      status: SubagentTaskInfo["status"];
      task_id: string;
      message: string;
      task: {
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
        error?: string;
      };
    };

export { TASK_STOP_TOOL_DESCRIPTION, TASK_STOP_TOOL_NAME };

export async function executeTaskStopTool(
  input: z.infer<typeof TaskStopInputSchema>,
  context: ToolExecutionContext
): Promise<TaskStopResult> {
  if (!context.stopSubagentTask) {
    throw new Error("TaskStop is not available in this execution context.");
  }

  const result = await context.stopSubagentTask(input.task_id);
  if (result.stopRequested) {
    context.recordToolActivity?.(TASK_STOP_TOOL_NAME);
  }

  if (result.status === "not_found" || !result.task) {
    return {
      status: "not_found",
      task_id: input.task_id,
      message: result.message
    };
  }

  return {
    status: result.status,
    task_id: result.taskId,
    message: result.message,
    task: toTaskSummary(result.task)
  };
}

function toTaskSummary(task: SubagentTaskInfo) {
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
    ...(task.error !== undefined ? { error: task.error } : {})
  };
}
