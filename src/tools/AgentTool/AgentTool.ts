import { z } from "zod";
import type {
  SubagentDefinitionInfo,
  SubagentRunResult,
  SubagentTaskLaunchResult,
  ToolExecutionContext
} from "../types.js";
import { isKnownToolName } from "../toolNames.js";
import { isToolSchemaAllowedByPolicy } from "../toolPolicy.js";
import { getSubagentDefinition, getSubagentTypes } from "./agents.js";
import { AGENT_TOOL_NAME, getAgentToolDescription } from "./prompt.js";

const UNKNOWN_TASK_ID_PREFIX = "Unknown subagent task_id:";
const MISMATCHED_TASK_ID_PATTERN = /^Subagent task_id (?<taskId>.+) belongs to (?<actual>.+), not (?<expected>.+)\.$/;
const MAX_BATCH_TASKS = 5;

const BaseAgentTaskSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1)
      .describe("A short 3-5 word description of the delegated task."),
    prompt: z
      .string()
      .trim()
      .min(1)
      .describe("The complete task prompt for the subagent to perform autonomously."),
    subagent_type: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("The named subagent type to use. Defaults to general."),
    task_id: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional task ID returned by a previous AgentTool result. Reuses that subagent session.")
  })
  .strict();

const SingleAgentTaskSchema = BaseAgentTaskSchema.extend({
  run_in_background: z
    .boolean()
    .optional()
    .describe("When true, start a read-only explore/review/verify subagent asynchronously and return immediately."),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional model override for this subagent run."),
  max_steps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional max tool steps override for this subagent run."),
  fork_context: z
    .boolean()
    .optional()
    .describe("When true, initialize the subagent with a read-only fork of the parent conversation context."),
  isolate_worktree: z
    .boolean()
    .optional()
    .describe("When true, run writable subagent work in a temporary git worktree and return the diff summary.")
});

const BatchAgentTaskSchema = BaseAgentTaskSchema;

export const AgentToolInputSchema = z.object({
  description: SingleAgentTaskSchema.shape.description.optional(),
  prompt: SingleAgentTaskSchema.shape.prompt.optional(),
  subagent_type: SingleAgentTaskSchema.shape.subagent_type,
  task_id: SingleAgentTaskSchema.shape.task_id,
  run_in_background: SingleAgentTaskSchema.shape.run_in_background,
  model: SingleAgentTaskSchema.shape.model,
  max_steps: SingleAgentTaskSchema.shape.max_steps,
  fork_context: SingleAgentTaskSchema.shape.fork_context,
  isolate_worktree: SingleAgentTaskSchema.shape.isolate_worktree,
  tasks: z
    .array(BatchAgentTaskSchema)
    .min(1)
    .max(MAX_BATCH_TASKS)
    .optional()
    .describe("Optional batch of 1-5 independent read-only subagent tasks to run concurrently.")
}).strict().superRefine((value, context) => {
  if (value.tasks) {
    if (
      value.description ||
      value.prompt ||
      value.subagent_type ||
      value.task_id ||
      value.run_in_background !== undefined ||
      value.model ||
      value.max_steps !== undefined ||
      value.fork_context !== undefined ||
      value.isolate_worktree !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Do not mix top-level single-task fields with tasks batch mode.",
        path: ["tasks"]
      });
    }
    return;
  }

  if (!value.description) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "description is required unless tasks batch mode is used.",
      path: ["description"]
    });
  }

  if (!value.prompt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "prompt is required unless tasks batch mode is used.",
      path: ["prompt"]
    });
  }
});

export type AgentToolInput = z.infer<typeof AgentToolInputSchema>;

export const AGENT_TOOL_DESCRIPTION = getAgentToolDescription();

type AgentToolResult = Record<string, unknown>;
type BatchItemResult = Record<string, unknown> & { status: string };
type TaskRunResult = { result: SubagentRunResult } | { error: AgentToolResult };
type RunSubagent = NonNullable<ToolExecutionContext["runSubagent"]>;
type LaunchSubagentTask = NonNullable<ToolExecutionContext["launchSubagentTask"]>;

export async function executeAgentTool(
  input: AgentToolInput,
  context: ToolExecutionContext
): Promise<AgentToolResult> {
  if (!context.runSubagent && !context.launchSubagentTask) {
    throw new Error("AgentTool is not available in this execution context.");
  }

  if (input.tasks) {
    const runSubagent = context.runSubagent;
    if (!runSubagent) {
      throw new Error("AgentTool batch mode is not available in this execution context.");
    }

    return executeBatchAgentTool(input.tasks, context, runSubagent);
  }

  const normalized = await normalizeTaskInput(input, 0, { allowGeneral: true }, context);
  if ("error" in normalized) {
    return normalized.error;
  }

  const { task, agent } = normalized;
  const isBackground = input.run_in_background === true;
  if (isBackground && !isReadOnlySubagent(agent)) {
    return {
      status: "error",
      error: "non_read_only_agent_not_allowed_in_background",
      message: "Background mode only supports subagents with file writes disabled and shell set to none or read-only.",
      agent_type: agent.type,
      description: task.description
    };
  }

  if (isBackground && !context.launchSubagentTask) {
    throw new Error("AgentTool background mode is not available in this execution context.");
  }

  if (!isBackground && !context.runSubagent) {
    throw new Error("AgentTool foreground mode is not available in this execution context.");
  }

  const launchSubagentTask = context.launchSubagentTask;
  const runSubagent = context.runSubagent;

  const approved = await context.requestApproval({
    kind: "agent",
    toolName: AGENT_TOOL_NAME,
    title: `${isBackground ? "Launch background" : "Run"} ${agent.label} subagent`,
    summary: `${task.description} (${agent.type})`,
    details: [
      `Mode: ${isBackground ? "background" : "foreground"}`,
      ...buildApprovalDetails(task, agent)
    ]
  });

  if (!approved) {
    return {
      status: "rejected",
      agent_type: agent.type,
      description: task.description,
      message: "User rejected the subagent request."
    };
  }

  context.recordToolActivity?.(AGENT_TOOL_NAME);

  if (isBackground) {
    const result = await launchTask(task, agent, launchSubagentTask!);
    if (isLaunchError(result)) {
      return result.error;
    }

    return formatLaunchedResult(result.result);
  }

  const result = await runTask(task, agent, runSubagent!);
  if (isTaskError(result)) {
    return result.error;
  }

  return formatCompletedResult(result.result);
}

async function launchTask(
  task: NormalizedTask["task"],
  agent: SubagentDefinitionInfo,
  launchSubagentTask: LaunchSubagentTask
): Promise<{ result: SubagentTaskLaunchResult } | { error: AgentToolResult }> {
  let result: SubagentTaskLaunchResult;
  try {
    result = await launchSubagentTask({
      agentType: agent.type,
      description: task.description,
      prompt: task.prompt,
      taskId: task.task_id,
      model: task.model,
      maxSteps: task.max_steps,
      forkContext: task.fork_context,
      isolateWorktree: task.isolate_worktree
    });
  } catch (error) {
    const structured = toStructuredSubagentError(error);
    if (structured) {
      return { error: structured };
    }

    throw error;
  }

  return { result };
}

async function executeBatchAgentTool(
  tasks: NonNullable<AgentToolInput["tasks"]>,
  context: ToolExecutionContext,
  runSubagent: RunSubagent
): Promise<AgentToolResult> {
  const normalizedTasks = await Promise.all(
    tasks.map((task, index) => normalizeTaskInput(task, index, { allowGeneral: false }, context))
  );
  const validationErrors = normalizedTasks
    .filter((item): item is { error: Record<string, unknown> } => "error" in item)
    .map((item) => item.error);

  const duplicateTaskIds = findDuplicateTaskIds(tasks);
  if (duplicateTaskIds.length > 0) {
    validationErrors.push({
      status: "error",
      error: "duplicate_task_id",
      message: `Duplicate task_id values in batch: ${duplicateTaskIds.join(", ")}`,
      task_ids: duplicateTaskIds
    });
  }

  if (validationErrors.length > 0) {
    return {
      status: "error",
      error: "invalid_batch",
      results: validationErrors
    };
  }

  const runnable = normalizedTasks as Array<NormalizedTask>;
  const approved = await context.requestApproval({
    kind: "agent",
    toolName: AGENT_TOOL_NAME,
    title: `Run ${runnable.length} subagents`,
    summary: runnable.map(({ task, agent }) => `${task.description} (${agent.type})`).join("; "),
    details: runnable.flatMap(({ task, agent }) => [
      `Task ${task.index + 1}: ${task.description}`,
      ...buildApprovalDetails(task, agent)
    ])
  });

  if (!approved) {
    return {
      status: "rejected",
      message: "User rejected the subagent batch request.",
      results: runnable.map(({ task, agent }) => ({
        index: task.index,
        status: "rejected",
        agent_type: agent.type,
        description: task.description
      }))
    };
  }

  context.recordToolActivity?.(AGENT_TOOL_NAME);

  const settled = await Promise.allSettled(
    runnable.map(({ task, agent }) => runTask(task, agent, runSubagent))
  );
  const results: BatchItemResult[] = settled.map((item, index) => {
    const { task, agent } = runnable[index]!;
    if (item.status === "rejected") {
      const structured = toStructuredSubagentError(item.reason);
      const error = structured ?? {
        error: "subagent_execution_error",
        message: item.reason instanceof Error ? item.reason.message : String(item.reason)
      };
      return {
        index: task.index,
        agent_type: agent.type,
        description: task.description,
        ...error,
        status: "error"
      };
    }

    if (isTaskError(item.value)) {
      const error = item.value.error;
      return {
        index: task.index,
        agent_type: agent.type,
        description: task.description,
        ...error,
        status: typeof error.status === "string" ? error.status : "error"
      };
    }

    return {
      index: task.index,
      ...formatCompletedResult(item.value.result)
    };
  });

  const hasFailures = results.some((result) => result.status !== "completed");
  return {
    status: hasFailures ? "partial_failure" : "completed",
    results
  };
}

async function runTask(
  task: NormalizedTask["task"],
  agent: SubagentDefinitionInfo,
  runSubagent: RunSubagent
): Promise<TaskRunResult> {
  let result: SubagentRunResult;
  try {
    result = await runSubagent({
      agentType: agent.type,
      description: task.description,
      prompt: task.prompt,
      taskId: task.task_id,
      model: task.model,
      maxSteps: task.max_steps,
      forkContext: task.fork_context,
      isolateWorktree: task.isolate_worktree
    });
  } catch (error) {
    const structured = toStructuredSubagentError(error);
    if (structured) {
      return { error: structured };
    }

    throw error;
  }

  return { result };
}

function isTaskError(
  value: TaskRunResult
): value is { error: AgentToolResult } {
  return "error" in value && value.error !== undefined;
}

function isLaunchError(
  value: { result: SubagentTaskLaunchResult } | { error: AgentToolResult }
): value is { error: AgentToolResult } {
  return "error" in value && value.error !== undefined;
}

function formatCompletedResult(result: SubagentRunResult) {
  return {
    status: "completed",
    task_id: result.taskId,
    agent_type: result.agentType,
    description: result.description,
    model: result.model,
    max_steps: result.maxSteps,
    output: result.output,
    ...(result.worktreePath ? { worktree_path: result.worktreePath } : {}),
    ...(result.diffSummary ? { diff_summary: result.diffSummary } : {}),
    ...(result.hasChanges !== undefined ? { has_changes: result.hasChanges } : {})
  };
}

function formatLaunchedResult(result: SubagentTaskLaunchResult) {
  return {
    status: "async_launched",
    task_id: result.taskId,
    agent_type: result.agentType,
    description: result.description,
    model: result.model,
    max_steps: result.maxSteps,
    started_at: result.startedAt,
    message: "Background subagent launched. Use TaskGet with task_id to retrieve the result, or TaskList to inspect active tasks."
  };
}

interface NormalizedTask {
  task: AgentToolInput & { index: number; description: string; prompt: string };
  agent: SubagentDefinitionInfo;
}

async function normalizeTaskInput(
  input: AgentToolInput,
  index: number,
  options: { allowGeneral: boolean },
  context: ToolExecutionContext
): Promise<NormalizedTask | { error: Record<string, unknown> }> {
  const agentType = input.subagent_type ?? "general";
  const agent = await resolveSubagentDefinition(agentType, context);
  if (!agent || agent.internal === true) {
    return {
      error: {
        index,
        status: "error",
        error: "unknown_subagent_type",
        message: `Unknown subagent type: ${agentType}`,
        available_subagent_types: await resolveSubagentTypes(context)
      }
    };
  }

  if (!options.allowGeneral && !isReadOnlySubagent(agent)) {
    return {
      error: {
        index,
        status: "error",
        error: "non_read_only_agent_not_allowed_in_batch",
        message: "Batch mode only supports subagents with file writes disabled and shell set to none or read-only.",
        agent_type: agent.type,
        description: input.description
      }
    };
  }

  return {
    task: {
      ...input,
      index,
      description: input.description!,
      prompt: input.prompt!
    },
    agent
  };
}

function buildApprovalDetails(
  task: Pick<AgentToolInput, "description" | "prompt" | "task_id" | "model" | "max_steps" | "fork_context" | "isolate_worktree">,
  agent: SubagentDefinitionInfo
) {
  return [
    `Subagent type: ${agent.type}`,
    task.task_id ? `Task ID: ${task.task_id}` : "Task ID: fresh session",
    `Description: ${task.description}`,
    `Prompt length: ${task.prompt?.length ?? 0} characters`,
    `Allowed tools: ${getEffectiveAllowedTools(agent).join(", ")}`,
    `Model: ${task.model ?? agent.model ?? "default"}`,
    `Max steps: ${task.max_steps ?? agent.maxSteps ?? "default"}`,
    `Fork context: ${task.fork_context === true ? "yes" : "no"}`,
    `Isolated worktree: ${formatWorktreeMode(task.isolate_worktree)}`
  ];
}

function formatWorktreeMode(value: boolean | undefined) {
  if (value === true) {
    return "yes";
  }

  if (value === false) {
    return "no";
  }

  return "auto";
}

function isReadOnlySubagent(agent: SubagentDefinitionInfo) {
  return !agent.policy.allowWrite && agent.policy.shell !== "any";
}

function getEffectiveAllowedTools(agent: SubagentDefinitionInfo) {
  return agent.allowedTools.filter((toolName) =>
    isKnownToolName(toolName) && isToolSchemaAllowedByPolicy(toolName, agent.policy)
  );
}

async function resolveSubagentDefinition(
  agentType: string,
  context: ToolExecutionContext
): Promise<SubagentDefinitionInfo | undefined> {
  if (context.getSubagentDefinition) {
    return context.getSubagentDefinition(agentType);
  }

  return getSubagentDefinition(agentType);
}

async function resolveSubagentTypes(context: ToolExecutionContext) {
  if (context.listSubagentDefinitions) {
    return (await context.listSubagentDefinitions())
      .filter((agent) => agent.internal !== true)
      .map((agent) => agent.type);
  }

  return getSubagentTypes();
}

function findDuplicateTaskIds(tasks: NonNullable<AgentToolInput["tasks"]>) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of tasks) {
    if (!task.task_id) {
      continue;
    }

    if (seen.has(task.task_id)) {
      duplicates.add(task.task_id);
    } else {
      seen.add(task.task_id);
    }
  }

  return [...duplicates];
}

function toStructuredSubagentError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(UNKNOWN_TASK_ID_PREFIX)) {
    return {
      status: "error",
      error: "unknown_task_id",
      message,
      task_id: message.slice(UNKNOWN_TASK_ID_PREFIX.length).trim()
    };
  }

  const mismatch = message.match(MISMATCHED_TASK_ID_PATTERN);
  if (mismatch?.groups) {
    return {
      status: "error",
      error: "mismatched_task_id",
      message,
      task_id: mismatch.groups.taskId,
      actual_subagent_type: mismatch.groups.actual,
      requested_subagent_type: mismatch.groups.expected
    };
  }

  return undefined;
}
