import { BASH_TOOL_NAME } from "./toolName.js";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;

export const BASH_TOOL_DESCRIPTION = `Execute a shell command on the local filesystem.

Usage:
- command: shell command string to execute
- timeout_ms: optional timeout in milliseconds
- cwd: optional working directory (absolute path preferred; "~"/"~/" supported; workspace-relative also allowed)
- run_in_background: reserved compatibility field; must be false in this runtime

Notes:
- Commands run as foreground commands with PowerShell on Windows and with bash/sh on Unix-like systems, and this tool waits for them to exit.
- Do not use this foreground runner for commands that are expected to keep running, such as npm run dev, vite --host, next dev, webpack dev server, uvicorn --reload, python -m http.server, or docker compose up.
- If a background process tool such as ProcessStart is available, use it for long-running local servers and wait for a URL or readiness line.
- If a PTY tool such as PtyCreate is available, use it for interactive shells, REPLs, prompts, and full-screen terminal programs that need a real terminal and ongoing input.
- If no background process tool is available, explain that this runtime cannot keep a long-running server alive yet instead of launching it through Bash.
- Increasing timeout_ms is not a correct fix for dev servers; timeout kills the foreground command when the limit is reached.
- Prefer dedicated tools (Read/Edit/Write) for file operations when possible.
- Long outputs are truncated for context safety.`;

export function getBashToolDescription(): string {
  return BASH_TOOL_DESCRIPTION;
}

export { BASH_TOOL_NAME };
