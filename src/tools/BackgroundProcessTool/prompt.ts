import {
  PROCESS_LIST_TOOL_NAME,
  PROCESS_READ_TOOL_NAME,
  PROCESS_START_TOOL_NAME,
  PROCESS_STOP_TOOL_NAME
} from "./toolName.js";

export const PROCESS_START_TOOL_DESCRIPTION = [
  "Start a long-running local process in the background, primarily for development servers.",
  "Use this instead of Bash or PowerShell foreground execution for commands such as npm run dev, vite --host, next dev, webpack dev server, uvicorn --reload, python -m http.server, or docker compose up.",
  "The startup timeout is only an observation window; a still-running process is returned as running instead of being killed.",
  "When a URL is detected, report it to the user with the process id; do not open a browser unless the user explicitly asks.",
  "The command still requires normal command approval, command safety analysis, and external working-directory approval."
].join("\n");

export const PROCESS_LIST_TOOL_DESCRIPTION = [
  "List background processes known to the current Alyce session.",
  "By default, returns running/starting processes and omits exited, failed, or stopped processes unless include_exited is true."
].join("\n");

export const PROCESS_READ_TOOL_DESCRIPTION = [
  "Read stdout, stderr, or combined logs from a background process by process_id.",
  "Use this after ProcessStart to inspect server startup logs, URLs, errors, and readiness output."
].join("\n");

export const PROCESS_STOP_TOOL_DESCRIPTION = [
  "Stop a background process by process_id.",
  "Use this when a dev server or other long-running process is no longer needed."
].join("\n");

export {
  PROCESS_START_TOOL_NAME,
  PROCESS_LIST_TOOL_NAME,
  PROCESS_READ_TOOL_NAME,
  PROCESS_STOP_TOOL_NAME
};
