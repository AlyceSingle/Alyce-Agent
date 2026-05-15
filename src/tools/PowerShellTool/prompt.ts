import { POWERSHELL_TOOL_NAME } from "./toolName.js";

export const DEFAULT_POWERSHELL_TIMEOUT_MS = 120_000;
export const MAX_POWERSHELL_TIMEOUT_MS = 600_000;

export const POWERSHELL_TOOL_DESCRIPTION = `Execute a PowerShell command on the local filesystem.

Usage:
- command: PowerShell command string to execute
- timeout_ms: optional timeout in milliseconds
- cwd: optional working directory (absolute path preferred; "~"/"~/" supported; workspace-relative also allowed)
- run_in_background: reserved compatibility field; must be false in this runtime

Notes:
- This tool runs foreground commands through PowerShell and waits for them to exit.
- Do not use this foreground runner for commands that are expected to keep running, such as npm run dev, vite --host, next dev, webpack dev server, uvicorn --reload, python -m http.server, or docker compose up.
- If a background process tool such as ProcessStart is available, use it for long-running local servers and wait for a URL or readiness line.
- If a PTY tool such as PtyCreate is available, use it for interactive shells, REPLs, prompts, and full-screen terminal programs that need a real terminal and ongoing input.
- If no background process tool is available, explain that this runtime cannot keep a long-running server alive yet instead of launching it through PowerShell.
- Increasing timeout_ms is not a correct fix for dev servers; timeout kills the foreground command when the limit is reached.
- Prefer Read/Edit/Write for direct file operations when possible.
- Output is truncated when too long to keep context stable.`;

export function getPowerShellToolDescription(): string {
  return POWERSHELL_TOOL_DESCRIPTION;
}

export { POWERSHELL_TOOL_NAME };
