export const FILE_APPLY_PATCH_TOOL_NAME = "apply_patch";

export function getApplyPatchToolDescription(): string {
  return `Applies a multi-file patch to the local filesystem.

Patch text must use this envelope:
*** Begin Patch
[one or more file sections]
*** End Patch

This is not unified diff syntax. Do not include ---/+++ file headers, line-number range headers, or hunks like @@ -1,4 +1,4 @@. Use @@ by itself, or @@ followed by a literal line of nearby file content as a search anchor.

Supported file sections:
- *** Add File: <path> followed by lines prefixed with +
- *** Delete File: <path>
- *** Update File: <path>, optionally followed by *** Move to: <path>, then @@ hunks

Update hunks support context lines prefixed with space, removed lines prefixed with -, added lines prefixed with +, optional @@ context anchors, and optional *** End of File anchors.

Safety rules:
- Existing files touched by Update, Delete, Move, or an Add overwrite must be fully read with Read first.
- All paths must stay inside the workspace or approved additional directories.
- Alyce verifies every hunk before writing any file, requests one approval for the complete patch, then rechecks raw bytes before writing.
- Use apply_patch for coordinated multi-file edits and renames. Use Edit or MultiEdit for smaller targeted replacements.`;
}
