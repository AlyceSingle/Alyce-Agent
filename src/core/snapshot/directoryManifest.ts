import { promises as fs } from "node:fs";
import path from "node:path";

const EXCLUDED_DIRECTORY_SEGMENTS = new Set([
  ".git",
  ".alyce",
  "node_modules",
  "dist"
]);

export interface DirectoryManifest {
  relativePaths: string[];
}

export async function captureDirectoryManifest(workspaceRoot: string): Promise<DirectoryManifest> {
  const root = path.resolve(workspaceRoot);
  const relativePaths: string[] = [];

  await walkDirectory(root, "");
  return {
    relativePaths: relativePaths.sort((left, right) => left.localeCompare(right))
  };

  async function walkDirectory(absoluteDirectory: string, relativeDirectory: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error) || isAccessDeniedError(error)) {
        return;
      }

      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const relativePath = normalizeRelativePath(path.join(relativeDirectory, entry.name));
      if (shouldExcludeDirectory(relativePath)) {
        continue;
      }

      relativePaths.push(relativePath);
      await walkDirectory(path.join(absoluteDirectory, entry.name), relativePath);
    }
  }
}

export function getCreatedDirectoryPaths(
  workspaceRoot: string,
  before: DirectoryManifest | undefined,
  after: DirectoryManifest | undefined
): string[] {
  if (!before || !after) {
    return [];
  }

  const beforePaths = new Set(before.relativePaths);
  return after.relativePaths
    .filter((relativePath) => !beforePaths.has(relativePath))
    .map((relativePath) => resolveWorkspaceDirectory(workspaceRoot, relativePath))
    .sort((left, right) => getPathDepth(right) - getPathDepth(left));
}

function shouldExcludeDirectory(relativePath: string) {
  return relativePath
    .split("/")
    .some((segment) => EXCLUDED_DIRECTORY_SEGMENTS.has(segment));
}

function resolveWorkspaceDirectory(workspaceRoot: string, relativePath: string) {
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Directory manifest path escapes workspace: ${relativePath}`);
  }

  return absolutePath;
}

function getPathDepth(absolutePath: string) {
  return path.resolve(absolutePath).split(path.sep).filter(Boolean).length;
}

function normalizeRelativePath(value: string) {
  return value.replace(/\\/g, "/");
}

function isMissingFileError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}

function isAccessDeniedError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ["EACCES", "EPERM"].includes((error as { code?: string }).code ?? "")
  );
}
