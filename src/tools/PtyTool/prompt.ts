import {
  PTY_CLOSE_TOOL_NAME,
  PTY_CREATE_TOOL_NAME,
  PTY_LIST_TOOL_NAME,
  PTY_READ_TOOL_NAME,
  PTY_RESIZE_TOOL_NAME,
  PTY_WRITE_TOOL_NAME
} from "./toolName.js";

export const PTY_CREATE_TOOL_DESCRIPTION = [
  "Create an interactive pseudo-terminal session for commands that need a real terminal or ongoing stdin/stdout interaction.",
  "Use this for REPLs, interactive shells, prompts, full-screen terminal programs, or commands where ProcessStart logs are not enough.",
  "This uses a native PTY backend and maintains a bounded buffer with cursor-based reads.",
  "Do not use this for ordinary one-shot commands; use Bash or PowerShell instead."
].join("\n");

export const PTY_LIST_TOOL_DESCRIPTION = [
  "List interactive PTY sessions known to the current Alyce session."
].join("\n");

export const PTY_READ_TOOL_DESCRIPTION = [
  "Read buffered output from an interactive PTY session by pty_id.",
  "Use cursor:-1 to start reading from the current end, cursor:0 to read from the oldest retained buffer, or pass the previous next_cursor to continue."
].join("\n");

export const PTY_WRITE_TOOL_DESCRIPTION = [
  "Write input to an interactive PTY session.",
  "This can execute arbitrary commands inside a shell, so it requires normal command approval."
].join("\n");

export const PTY_RESIZE_TOOL_DESCRIPTION = [
  "Resize an interactive PTY session."
].join("\n");

export const PTY_CLOSE_TOOL_DESCRIPTION = [
  "Close and terminate an interactive PTY session."
].join("\n");

export {
  PTY_CREATE_TOOL_NAME,
  PTY_LIST_TOOL_NAME,
  PTY_READ_TOOL_NAME,
  PTY_WRITE_TOOL_NAME,
  PTY_RESIZE_TOOL_NAME,
  PTY_CLOSE_TOOL_NAME
};
