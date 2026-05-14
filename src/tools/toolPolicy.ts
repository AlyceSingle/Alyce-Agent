import {
  JS_PACKAGE_MANAGER_BUILD_TEST_PATTERN,
  JS_PACKAGE_MANAGER_INSTALL_PATTERN
} from "./internal/jsPackageManagers.js";
import type { JsonRecord, ToolPermissionPolicy } from "./types.js";

const WRITE_TOOL_NAMES = new Set(["Edit", "MultiEdit", "Write", "apply_patch", "TodoWrite"]);
const NETWORK_TOOL_NAMES = new Set(["WebFetch", "WebSearch"]);
const SHELL_TOOL_NAMES = new Set(["Bash", "PowerShell"]);
const ORCHESTRATION_TOOL_NAMES = new Set(["AgentTool", "TaskList", "TaskGet", "TaskStop"]);
const MAIN_SESSION_ONLY_TOOL_NAMES = new Set([
  "SkillTool",
  "McpStatus",
  "ListMcpResources",
  "ReadMcpResource"
]);
const READ_ONLY_COMMAND_STARTS = [
  "cat",
  "cd",
  "dir",
  "echo",
  "find",
  "git branch",
  "git diff",
  "git grep",
  "git log",
  "git ls-files",
  "git rev-parse",
  "git show",
  "git status",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "tail",
  "type",
  "wc",
  "where",
  "which",
  "Get-ChildItem",
  "Get-Command",
  "Get-Content",
  "Get-Item",
  "Get-Location",
  "Get-Process",
  "Get-PSDrive",
  "Get-Service",
  "Measure-Object",
  "Resolve-Path",
  "Select-Object",
  "Select-String",
  "Test-Path"
];

const WRITE_COMMAND_PATTERNS = [
  /\b(Remove-Item|Move-Item|Copy-Item|New-Item|Set-Content|Add-Content|Out-File|Rename-Item|Set-Item|Start-Process)\b/i,
  /\b(del|erase|rd|rmdir|ren|rename|copy|xcopy|robocopy|ni|ri|mi)\b/i,
  /\b(rm|mv|cp|mkdir|touch|chmod|chown|dd|tee)\b/i,
  /\b(git\s+(add|apply|checkout|clean|commit|merge|mv|pull|rebase|reset|restore|rm|switch))\b/i,
  JS_PACKAGE_MANAGER_INSTALL_PATTERN,
  JS_PACKAGE_MANAGER_BUILD_TEST_PATTERN,
  /\b(pip|pip3)\s+install\b/i,
  /\bfind\b.*\s-delete\b/i,
  /\bfind\b.*\s-(?:exec|ok)(?:dir)?\b/i,
  /\bsed\b.*\s-i(?:\S*)?(?:\s|$)/i,
  /(?:^|\s)--output(?:=|\s+)/i,
  /(^|[^>])>(?!\s*&\d)/,
  />>/,
  /\|\s*(tee|Out-File|Set-Content|Add-Content)\b/i
];

const NETWORK_COMMAND_PATTERNS = [
  /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i,
  /\b(ssh|scp|sftp|rsync|nc|ncat|netcat|telnet)\b/i,
  /\b(gh|hub)\s+/i,
  /\b(git\s+(clone|fetch|ls-remote|pull|push|submodule\s+update))\b/i,
  JS_PACKAGE_MANAGER_INSTALL_PATTERN,
  /\b(pip|pip3)\s+install\b/i
];

const COMMAND_CHAIN_PATTERN = /(?:;|&&|\|\||\r|\n)/;

export function isToolSchemaAllowedByPolicy(
  toolName: string,
  policy: ToolPermissionPolicy
): boolean {
  if (ORCHESTRATION_TOOL_NAMES.has(toolName)) {
    return false;
  }

  if (MAIN_SESSION_ONLY_TOOL_NAMES.has(toolName)) {
    return false;
  }

  if (WRITE_TOOL_NAMES.has(toolName) && !policy.allowWrite) {
    return false;
  }

  if (NETWORK_TOOL_NAMES.has(toolName) && !policy.allowNetwork) {
    return false;
  }

  if (SHELL_TOOL_NAMES.has(toolName) && policy.shell === "none") {
    return false;
  }

  return true;
}

export function getToolPolicyViolation(
  toolName: string,
  args: JsonRecord,
  policy: ToolPermissionPolicy | undefined
): string | undefined {
  if (!policy) {
    return undefined;
  }

  if (ORCHESTRATION_TOOL_NAMES.has(toolName)) {
    return `${toolName} is blocked by the current subagent policy: parent orchestration tools are disabled inside subagents.`;
  }

  if (MAIN_SESSION_ONLY_TOOL_NAMES.has(toolName)) {
    return `${toolName} is blocked by the current subagent policy: this tool is only available in the main session.`;
  }

  if (WRITE_TOOL_NAMES.has(toolName) && !policy.allowWrite) {
    return `${toolName} is blocked by the current subagent policy: file writes are disabled.`;
  }

  if (NETWORK_TOOL_NAMES.has(toolName) && !policy.allowNetwork) {
    return `${toolName} is blocked by the current subagent policy: network access is disabled.`;
  }

  if (!SHELL_TOOL_NAMES.has(toolName)) {
    return undefined;
  }

  if (policy.shell === "none") {
    return `${toolName} is blocked by the current subagent policy: shell access is disabled.`;
  }

  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (policy.shell === "read-only" && !isReadOnlyCommand(command)) {
    return `${toolName} command is blocked by read-only shell policy.`;
  }

  if (!policy.allowWrite && isWriteCommand(command)) {
    return `${toolName} command is blocked by the current subagent policy: file writes are disabled.`;
  }

  if (!policy.allowNetwork && isNetworkCommand(command)) {
    return `${toolName} command is blocked by the current subagent policy: network access is disabled.`;
  }

  return undefined;
}

function isReadOnlyCommand(command: string): boolean {
  if (COMMAND_CHAIN_PATTERN.test(command)) {
    return false;
  }

  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  if (isWriteCommand(normalized) || isNetworkCommand(normalized)) {
    return false;
  }

  return normalized
    .split("|")
    .map((segment) => segment.trim())
    .every((segment) => segment.length > 0 && isReadOnlyCommandSegment(segment));
}

function isReadOnlyCommandSegment(command: string): boolean {
  const normalizedLower = command.toLowerCase();
  return READ_ONLY_COMMAND_STARTS.some((prefix) => {
    const prefixLower = prefix.toLowerCase();
    return normalizedLower === prefixLower || normalizedLower.startsWith(`${prefixLower} `);
  });
}

function isWriteCommand(command: string): boolean {
  return WRITE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function isNetworkCommand(command: string): boolean {
  return NETWORK_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}
