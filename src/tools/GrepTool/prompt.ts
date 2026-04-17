export const GREP_TOOL_NAME = "Grep";

export const GREP_TOOL_DESCRIPTION = `Search file contents in allowed directories with ripgrep.

Usage:
- pattern: required regular expression pattern
- path: optional file or directory inside allowed directories
- glob: optional file glob filter such as "*.ts" or "*.{ts,tsx}"
- output_mode: "files_with_matches" (default), "content", or "count"

Notes:
- Supports case-insensitive search via "-i".
- Supports line numbers and context flags in content mode.
- Supports file type filters through ripgrep's --type option.
- Supports multiline regex matching with multiline: true.
- Use Grep for content searches instead of shelling out to grep or rg.`;
