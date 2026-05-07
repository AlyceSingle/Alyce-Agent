export const KNOWN_TOOL_NAMES = new Set([
  "AgentTool",
  "TaskList",
  "TaskGet",
  "TaskStop",
  "AskUserQuestion",
  "SkillTool",
  "McpStatus",
  "ListMcpResources",
  "ReadMcpResource",
  "Read",
  "Glob",
  "Grep",
  "LSP",
  "TodoWrite",
  "Edit",
  "MultiEdit",
  "apply_patch",
  "Write",
  "Bash",
  "PowerShell",
  "WebFetch",
  "WebSearch"
]);

export function isKnownToolName(toolName: string): boolean {
  return KNOWN_TOOL_NAMES.has(toolName);
}
