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

    deduped.add(path.resolve(normalized));
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
  const resolvedPath = path.resolve(baseDirectory, maybeRelative);
  if (isPathAllowed(allowedRoots, resolvedPath)) {
    return resolvedPath;
  }

  throw new Error(`Path escapes allowed roots: ${formatAllowedRoots(allowedRoots)}`);
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

  if (path.isAbsolute(normalizedInput)) {
    const absolutePath = path.resolve(normalizedInput);
    if (isPathAllowed(allowedRoots, absolutePath)) {
      return absolutePath;
    }

    throw new Error(`Path escapes allowed roots: ${formatAllowedRoots(allowedRoots)}`);
  }

  return resolveAllowedPath(allowedRoots, normalizedInput, workspaceRoot);
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

function formatAllowedRoots(allowedRoots: readonly string[]) {
  const normalizedRoots = normalizeAllowedRoots(allowedRoots);
  if (normalizedRoots.length === 0) {
    return "(none)";
  }

  return normalizedRoots.join(", ");
}
