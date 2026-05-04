import {
  DEFAULT_DIRECTORY_ENTRIES_TO_READ,
  DEFAULT_NOTEBOOK_CELLS_TO_READ,
  MAX_LINES_TO_READ
} from "./limits.js";

export const FILE_READ_TOOL_NAME = "Read";
export const FILE_UNCHANGED_STUB =
  "File unchanged since last Read. The content from the earlier Read tool result in this conversation is still current; refer to that instead of re-reading.";

export const DESCRIPTION = renderPromptTemplate(MAX_LINES_TO_READ);

export function renderPromptTemplate(maxLines: number): string {
  return `Read a file or directory from the local filesystem.

Usage:
- file_path: absolute path is preferred; "~" and "~/..." resolve to the user home directory
- workspace-relative paths are also supported and resolve from workspace root
- paths outside the current workspace can be requested directly; the runtime will ask the user before granting external directory access
- offset: optional 1-based start line for text files, start entry for directories, or start cell for notebooks
- limit: optional number of lines, directory entries, or notebook cells to return
- By default, text reads return at most ${maxLines} lines, directory reads return at most ${DEFAULT_DIRECTORY_ENTRIES_TO_READ} entries, and notebook reads return at most ${DEFAULT_NOTEBOOK_CELLS_TO_READ} cells
- Text output follows cat -n style, with line numbers starting at 1
- Large text windows may be capped by output size even when limit is provided; when that happens, Read returns a continuation hint for the next offset
- If the same text or notebook range is read again and the file has not changed, Read may return a file_unchanged stub instead of resending duplicate content
- Directories are listed directly by this tool, so Bash is not required just to inspect a folder
- Jupyter notebooks (.ipynb) are returned as structured cells with trimmed source and output text
- Supported image formats and PDFs can be attached as multimodal context for the current turn so the model can inspect the real asset, not just metadata
- Other binary files are still metadata-only
- This tool does not execute commands`;
}
