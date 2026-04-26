import fs from "node:fs";
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
  const checkedPath = resolvePathForSandboxCheck(normalizedPath);
  const roots = normalizeAllowedRoots(allowedRoots);
  return roots.some((rootPath) =>
    isPathInsideRoot(resolvePathForSandboxCheck(rootPath), checkedPath)
  );
}

export function resolveAllowedPath(
  allowedRoots: readonly string[],
  maybeRelative: string,
  baseDirectory: string
): string {
  const resolvedPath = path.resolve(baseDirectory, expandHomePath(maybeRelative));
  assertPathAllowed(allowedRoots, resolvedPath);
  return resolvedPath;
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
    const resolvedPath = path.resolve(expandedInput);
    assertPathAllowed(allowedRoots, resolvedPath);
    return resolvedPath;
  }

  return resolveAllowedPath(allowedRoots, expandedInput, workspaceRoot);
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

function resolvePathForSandboxCheck(absolutePath: string): string {
  const normalizedPath = path.resolve(absolutePath);
  const existingPath = findNearestExistingPath(normalizedPath);
  if (!existingPath) {
    return normalizedPath;
  }

  const realExistingPath = realpathOrResolved(existingPath);
  const remainingPath = path.relative(existingPath, normalizedPath);
  return remainingPath ? path.resolve(realExistingPath, remainingPath) : realExistingPath;
}

function findNearestExistingPath(absolutePath: string): string | null {
  let currentPath = path.resolve(absolutePath);

  while (!fs.existsSync(currentPath)) {
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }

  return currentPath;
}

function realpathOrResolved(existingPath: string): string {
  try {
    return fs.realpathSync.native(existingPath);
  } catch {
    return path.resolve(existingPath);
  }
}

function assertPathAllowed(allowedRoots: readonly string[], absolutePath: string) {
  if (isPathAllowed(allowedRoots, absolutePath)) {
    return;
  }

  const normalizedRoots = normalizeAllowedRoots(allowedRoots);
  const rootsLabel =
    normalizedRoots.length > 0 ? normalizedRoots.join(", ") : "(no allowed roots configured)";
  throw new Error(`Path is outside the allowed roots: ${absolutePath}. Allowed roots: ${rootsLabel}`);
}

