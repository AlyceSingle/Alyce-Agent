import { FILE_READ_TOOL_NAME } from "../FileReadTool/prompt.js";

export function getEditToolDescription(): string {
  return `Edit file content by replacing old_string with new_string.

Usage:
- file_path: absolute path is preferred; "~" and "~/..." resolve to the user home directory
- workspace-relative paths are also supported and resolve from workspace root
- old_string: target text to replace
- new_string: replacement text
- replace_all: optional, replace all matches when true
- Prefer ${FILE_READ_TOOL_NAME} before Edit to get exact context
- If old_string appears multiple times and replace_all is false, the tool will return an error`;
}
