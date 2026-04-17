import { MAX_LINES_TO_READ } from "./limits.js";

export const FILE_READ_TOOL_NAME = "Read";

export const DESCRIPTION = renderPromptTemplate(MAX_LINES_TO_READ);

export function renderPromptTemplate(maxLines: number): string {
  return `Read a text file from allowed directories.

Usage:
- file_path: absolute path or workspace-relative path (must be inside allowed directories)
- offset: optional 1-based start line
- limit: optional number of lines to read
- By default, at most ${maxLines} lines are returned
- Output follows cat -n style, with line numbers starting at 1
- This tool only reads files. It does not list directories or execute commands`;
}
