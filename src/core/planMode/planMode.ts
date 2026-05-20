import type { PermissionRuleInput } from "../permissions/permissionRules.js";

export interface PlanModeState {
  enabled: boolean;
  enteredAt?: string;
}

export const PLAN_MODE_ALLOWED_TOOL_NAMES = new Set([
  "AskUserQuestion",
  "Read",
  "Glob",
  "Grep",
  "LSP",
  "TodoWrite",
  "Bash",
  "PowerShell",
  "WebFetch",
  "WebSearch",
  "McpStatus",
  "ListMcpTools",
  "ListMcpResources",
  "ReadMcpResource",
  "TaskList",
  "TaskGet",
  "ProcessList",
  "ProcessRead",
  "PtyList",
  "PtyRead"
]);

const PLAN_MODE_DENIED_TOOL_NAMES = new Set([
  "AgentTool",
  "TaskStop",
  "ProcessStart",
  "ProcessStop",
  "PtyCreate",
  "PtyWrite",
  "PtyResize",
  "PtyClose",
  "SkillTool",
  "CallMcpTool",
  "Edit",
  "MultiEdit",
  "apply_patch",
  "Write"
]);

export const PLAN_MODE_SYSTEM_INSTRUCTIONS = [
  "Plan Mode summary: inspect safely, ask clarifying questions when needed, and produce an implementation plan without mutating the workspace.",
  "",
  "# Plan Mode",
  "You are currently in Plan Mode. Your job is to understand the request, inspect safely, ask clarifying questions when needed, and produce a concrete implementation plan.",
  "",
  "Hard rules:",
  "- Do not modify files.",
  "- Do not run commands that create, delete, move, edit, install packages, update dependencies, or otherwise mutate the workspace.",
  "- Use read-only tools for exploration: Read, Glob, Grep, LSP, WebFetch, WebSearch, MCP resource listing/reading, and user questions.",
  "- You may inspect existing background processes with ProcessList and ProcessRead, but do not start or stop background processes.",
  "- You may inspect existing PTY sessions with PtyList and PtyRead, but do not create, write to, resize, or close PTY sessions.",
  "- Bash and PowerShell are only for read-only inspection commands. If a command might write files, install packages, touch git state, or execute arbitrary code, do not run it.",
  "- Do not spawn subagents or stop tasks while planning.",
  "",
  "When you present a plan, include:",
  "- assumptions and open questions",
  "- files or modules likely to change",
  "- implementation stages",
  "- risks and rollback notes",
  "- verification steps"
].join("\n");

export function createPlanModeOverlayRules(enabled: boolean): PermissionRuleInput[] {
  if (!enabled) {
    return [];
  }

  return [
    {
      permission: "file.read",
      pattern: "workspace:*",
      action: "allow",
      scope: "session",
      reason: "Plan Mode allows workspace reads for exploration."
    },
    {
      permission: "directory.external",
      pattern: "*",
      action: "ask",
      scope: "session",
      reason: "Plan Mode requires approval before reading/searching outside the allowed roots."
    },
    {
      permission: "file.write",
      pattern: "*",
      action: "deny",
      scope: "session",
      reason: "Plan Mode blocks file writes."
    },
    {
      permission: "file.edit",
      pattern: "*",
      action: "deny",
      scope: "session",
      reason: "Plan Mode blocks file edits."
    },
    {
      permission: "file.patch",
      pattern: "*",
      action: "deny",
      scope: "session",
      reason: "Plan Mode blocks patch application."
    },
    {
      permission: "shell",
      pattern: "*",
      action: "ask",
      scope: "session",
      reason: "Plan Mode only allows read-only shell inspection after approval."
    },
    {
      permission: "powershell",
      pattern: "*",
      action: "ask",
      scope: "session",
      reason: "Plan Mode only allows read-only PowerShell inspection after approval."
    },
    {
      permission: "web.fetch",
      pattern: "*",
      action: "allow",
      scope: "session",
      reason: "Plan Mode allows web fetch for research."
    },
    {
      permission: "web.search",
      pattern: "*",
      action: "allow",
      scope: "session",
      reason: "Plan Mode allows web search for research."
    },
    {
      permission: "mcp.resource",
      pattern: "*",
      action: "allow",
      scope: "session",
      reason: "Plan Mode allows MCP resource listing and reading."
    },
    {
      permission: "mcp.tool",
      pattern: "*",
      action: "deny",
      scope: "session",
      reason: "Plan Mode blocks arbitrary MCP tool calls."
    },
    {
      permission: "skill.load",
      pattern: "*",
      action: "deny",
      scope: "session",
      reason: "Plan Mode blocks skill loading in the first P0 implementation."
    },
    {
      permission: "task.spawn",
      pattern: "*",
      action: "deny",
      scope: "session",
      reason: "Plan Mode blocks subagent spawning."
    }
  ];
}

export function isToolAllowedInPlanMode(toolName: string): boolean {
  if (PLAN_MODE_DENIED_TOOL_NAMES.has(toolName)) {
    return false;
  }

  if (toolName.startsWith("mcp__")) {
    return false;
  }

  return PLAN_MODE_ALLOWED_TOOL_NAMES.has(toolName);
}

export function getPlanModeToolViolation(toolName: string): string | undefined {
  if (isToolAllowedInPlanMode(toolName)) {
    return undefined;
  }

  return `${toolName} is blocked in Plan Mode. Exit Plan Mode before modifying files, spawning agents, or using mutating tools.`;
}
