export const GLOB_TOOL_NAME = "Glob";

export const GLOB_TOOL_DESCRIPTION = `Find files on the local filesystem using glob patterns.

Usage:
- pattern: required glob pattern such as "**/*.ts" or "src/**/*.tsx"
- path: optional directory; absolute path is preferred and "~"/"~/" paths are supported
- workspace-relative paths are also supported and resolve from workspace root

Notes:
- Results are workspace-relative paths when inside workspace, otherwise absolute paths.
- Hidden files are included.
- Version control directories such as .git are excluded.
- Use Glob for filename and path pattern searches instead of shelling out to rg --files.`;
