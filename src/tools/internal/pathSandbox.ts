import path from "node:path";

export function resolveWorkspacePath(workspaceRoot: string, maybeRelative: string): string {
  const resolved = path.resolve(workspaceRoot, maybeRelative);
  const relative = path.relative(workspaceRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes workspace root");
  }

  return resolved;
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative.length === 0 ? "." : relative;
}
