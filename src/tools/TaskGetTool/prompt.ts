export const TASK_GET_TOOL_NAME = "TaskGet";

export const TASK_GET_TOOL_DESCRIPTION = [
  "Get the current status and final output for one subagent task by task_id.",
  "",
  "Use this after AgentTool returns status=async_launched for a background task. If status is running, wait for later work before checking again.",
  "TaskGet includes progress events, final output, and worktree diff metadata when available.",
  "When status is completed, summarize the output back to the user or use it to continue the current task."
].join("\n");
