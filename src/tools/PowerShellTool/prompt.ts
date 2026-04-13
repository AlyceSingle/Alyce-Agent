import { POWERSHELL_TOOL_NAME } from "./toolName.js";

export const DEFAULT_POWERSHELL_TIMEOUT_MS = 120_000;
export const MAX_POWERSHELL_TIMEOUT_MS = 600_000;

export const POWERSHELL_TOOL_DESCRIPTION = `Execute a PowerShell command in the current workspace.

Usage:
- command: PowerShell command string to execute
- timeout_ms: optional timeout in milliseconds
- cwd: optional working directory (absolute path or workspace-relative path)
- run_in_background: reserved compatibility field; must be false in this runtime

Notes:
- This tool runs commands through PowerShell.
- Prefer Read/Edit/Write for direct file operations when possible.
- Output is truncated when too long to keep context stable.`;

export function getPowerShellToolDescription(): string {
  return POWERSHELL_TOOL_DESCRIPTION;
}

export { POWERSHELL_TOOL_NAME };
