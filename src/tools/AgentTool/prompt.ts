import { formatSubagentList } from "./agents.js";

export const AGENT_TOOL_NAME = "AgentTool";

export function getAgentToolDescription() {
  return [
    "Launch a named subagent to handle a complex, multi-step task and return its final report.",
    "",
    "Available subagent types:",
    formatSubagentList(),
    "",
    "Use AgentTool when the task benefits from an isolated worker context: broad codebase research, independent review, or a bounded implementation subtask.",
    "Do not use AgentTool for reading a known file, searching for a specific string in one or two files, or other simple tasks that direct tools can handle faster.",
    "",
    "For multiple independent read-only investigations, use tasks batch mode with 1-5 explore/review tasks. Batch mode runs those subagents concurrently and returns one result per task.",
    "Do not put general implementation tasks in batch mode; run those one at a time so write safety and review remain clear.",
    "For long-running read-only exploration or review work, set run_in_background=true on a single explore/review task. AgentTool returns immediately with a task_id; use TaskList to inspect tasks and TaskGet to retrieve the final output.",
    "A background launch returns status=async_launched. Use TaskStop to interrupt a running background task.",
    "Do not run general implementation tasks in background mode; foreground execution keeps write safety, approvals, and rewind behavior clear.",
    "Use model or max_steps when a subagent needs a different model or tool-step budget.",
    "Use fork_context=true when the subagent needs recent parent conversation context. Otherwise each subagent starts from a fresh isolated context.",
    "Writable subagents use git worktree isolation when requested with isolate_worktree=true, and writable built-in agents attempt isolation by default when the workspace is a git repository.",
    "Custom agents can be defined in .alyce/agents/*.json or .alyce/agents/*.md with name/type, description, tools, prompt/systemPrompt, maxSteps, model, and permissions.",
    "Each invocation starts with a fresh subagent context. Write a complete prompt with the goal, relevant context, scope boundaries, expected output, and verification instructions.",
    "To continue a previous subagent session, pass the task_id returned by an earlier AgentTool result. Reuse task_id for follow-up investigation, refinement, or continuing the same worker's context.",
    "Do not reuse task_id for an independent second opinion, unrelated work, or when a fresh context is desired.",
    "The subagent result is only returned to you as a tool result. Summarize anything important back to the user yourself."
  ].join("\n");
}
