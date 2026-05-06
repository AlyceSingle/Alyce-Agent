export const TASK_STOP_TOOL_NAME = "TaskStop";

export const TASK_STOP_TOOL_DESCRIPTION = [
  "Stop a running background subagent task by task_id.",
  "",
  "Use this when a background AgentTool task is no longer needed, is taking too long, or should be cancelled before retrieving a result.",
  "TaskStop returns the latest task snapshot after the stop request."
].join("\n");
