import path from "node:path";

// 将用户路径解析到工作区内，拒绝越界访问。
export function resolveWorkspacePath(workspaceRoot: string, maybeRelative: string): string {
  const resolved = path.resolve(workspaceRoot, maybeRelative);
  const relative = path.relative(workspaceRoot, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes workspace root");
  }

  return resolved;
}

// 将绝对路径回显为工作区相对路径，便于输出展示。
export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  return relative.length === 0 ? "." : relative;
}
