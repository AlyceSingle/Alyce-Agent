export const TASK_LIST_TOOL_NAME = "TaskList";

export const TASK_LIST_TOOL_DESCRIPTION = [
  "List subagent tasks known to the current session, including background tasks launched by AgentTool.",
  "",
  "Use this after launching AgentTool with run_in_background=true to see running, completed, failed, or stopped task IDs.",
  "Use include_completed=false when you only need active or failed work that still needs attention."
].join("\n");
