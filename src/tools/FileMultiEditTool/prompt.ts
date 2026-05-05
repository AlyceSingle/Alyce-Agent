export const FILE_MULTI_EDIT_TOOL_NAME = "MultiEdit" as const;

export function getMultiEditToolDescription() {
  return [
    "Perform multiple find-and-replace edits against one local text file in a single write.",
    "",
    "Use MultiEdit when several related replacements should be applied atomically to the same file.",
    "",
    "Requirements:",
    "- The target file must have been fully read with Read first.",
    "- Each edit is applied sequentially to the result of the previous edit.",
    "- old_string must be non-empty and different from new_string.",
    "- By default each old_string must resolve to one target; set replace_all=true for that edit to replace every occurrence.",
    "- Matching starts exact, then tries conservative fallbacks for trimmed lines, block anchors, whitespace, indentation, escaped text, and trimmed boundaries.",
    "- The tool rechecks the file after approval, preserves existing text encoding and line endings, runs configured formatters when available, and returns TypeScript/JavaScript diagnostics when available."
  ].join("\n");
}
