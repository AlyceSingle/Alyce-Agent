import { FILE_READ_TOOL_NAME } from "../FileReadTool/prompt.js";

export function getEditToolDescription(): string {
  return `Edit file content by replacing old_string with new_string.

Usage:
- file_path: absolute path is preferred; "~" and "~/..." resolve to the user home directory
- workspace-relative paths are also supported and resolve from workspace root
- old_string: target text to replace
- new_string: replacement text
- replace_all: optional, replace all matches when true
- You MUST use ${FILE_READ_TOOL_NAME} to fully read an existing text file before Edit. Partial reads, directory reads, notebook summaries, and binary metadata reads do not satisfy this requirement
- Edit will also fail if the file changed since that full read
- After approval, Edit rechecks that the target file did not change before writing
- Edit preserves existing text encoding and line endings when writing back
- Matching starts exact, then tries conservative fallbacks for trimmed lines, block anchors, whitespace, indentation, escaped text, and trimmed boundaries
- After writing, Edit may run a configured project formatter for the affected file type and will return TypeScript/JavaScript diagnostics when available
- If old_string appears multiple times and replace_all is false, the tool will return an error`;
}
