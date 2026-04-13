import { BASH_TOOL_NAME } from "./toolName.js";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;

export const BASH_TOOL_DESCRIPTION = `Execute a shell command in the current workspace.

Usage:
- command: shell command string to execute
- timeout_ms: optional timeout in milliseconds
- cwd: optional working directory (absolute path or workspace-relative path)
- run_in_background: reserved compatibility field; must be false in this runtime

Notes:
- Commands run with PowerShell on Windows and with bash/sh on Unix-like systems.
- Prefer dedicated tools (Read/Edit/Write) for file operations when possible.
- Long outputs are truncated for context safety.`;

export function getBashToolDescription(): string {
  return BASH_TOOL_DESCRIPTION;
}

export { BASH_TOOL_NAME };
