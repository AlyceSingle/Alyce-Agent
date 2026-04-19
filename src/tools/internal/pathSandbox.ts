import os from "node:os";
import path from "node:path";

function isPathInsideRoot(rootPath: string, absolutePath: string) {
  const relative = path.relative(rootPath, absolutePath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function normalizeAllowedRoots(allowedRoots: readonly string[]): string[] {
  const deduped = new Set<string>();
  for (const root of allowedRoots) {
    const normalized = root.trim();
    if (!normalized) {
      continue;
    }

    deduped.add(path.resolve(expandHomePath(normalized)));
  }

  return [...deduped];
}

export function isPathAllowed(allowedRoots: readonly string[], absolutePath: string): boolean {
  const normalizedPath = path.resolve(absolutePath);
  const roots = normalizeAllowedRoots(allowedRoots);
  return roots.some((rootPath) => isPathInsideRoot(rootPath, normalizedPath));
}

export function resolveAllowedPath(
  allowedRoots: readonly string[],
  maybeRelative: string,
  baseDirectory: string
): string {
  void allowedRoots;
  return path.resolve(baseDirectory, expandHomePath(maybeRelative));
}

export function resolvePathFromInput(
  workspaceRoot: string,
  allowedRoots: readonly string[],
  inputPath: string
): string {
  const normalizedInput = inputPath.trim();
  if (!normalizedInput) {
    throw new Error("Path must not be empty");
  }

  const expandedInput = expandHomePath(normalizedInput);

  if (path.isAbsolute(expandedInput)) {
    void allowedRoots;
    return path.resolve(expandedInput);
  }

  return resolveAllowedPath(allowedRoots, expandedInput, workspaceRoot);
}

export function resolveWorkspacePath(workspaceRoot: string, maybeRelative: string): string {
  return resolveAllowedPath([workspaceRoot], maybeRelative, workspaceRoot);
}

export function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  const normalizedAbsolute = path.resolve(absolutePath);
  const normalizedWorkspace = path.resolve(workspaceRoot);
  if (!isPathInsideRoot(normalizedWorkspace, normalizedAbsolute)) {
    return normalizedAbsolute;
  }

  const relative = path.relative(normalizedWorkspace, normalizedAbsolute);
  return relative.length === 0 ? "." : relative;
}

function expandHomePath(inputPath: string): string {
  const trimmedPath = inputPath.trim();
  if (trimmedPath === "~") {
    return os.homedir();
  }

  if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) {
    return path.join(os.homedir(), trimmedPath.slice(2));
  }

  return trimmedPath;
}

