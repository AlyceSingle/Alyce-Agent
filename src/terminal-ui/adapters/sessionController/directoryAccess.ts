import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { SessionRuntime } from "../../../cli/sessionRuntime.js";

export interface DirectoryAccessHelpers {
  resolveAdditionalDirectory: (directory: string) => Promise<string>;
  normalizePathForComparison: (directory: string) => string;
  dedupeDirectories: (directories: string[]) => string[];
  buildAccessScopeSnapshot: () => string[];
  isDirectoryAlreadyAllowed: (directory: string) => boolean;
}

export function createDirectoryAccessHelpers(deps: {
  runtime: SessionRuntime;
}): DirectoryAccessHelpers {
  const { runtime } = deps;

  const resolveAdditionalDirectory = async (directory: string): Promise<string> => {
    const normalized = directory.trim();
    if (!normalized) {
      throw new Error("Directory path is required.");
    }

    const absolutePath = resolveDirectoryInput(normalized, runtime.workspaceRoot);
    let stats;
    try {
      stats = await fs.stat(absolutePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Directory not found: ${absolutePath}. ${message}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${absolutePath}`);
    }

    return absolutePath;
  };

  const resolveDirectoryInput = (directory: string, workspaceRoot: string): string => {
    const normalized = directory.trim();
    if (normalized === "~") {
      return path.resolve(os.homedir());
    }

    if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
      return path.resolve(path.join(os.homedir(), normalized.slice(2)));
    }

    return path.resolve(workspaceRoot, normalized);
  };

  const normalizePathForComparison = (directory: string) => {
    const normalized = path.resolve(directory);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };

  const dedupeDirectories = (directories: string[]) => {
    const deduped = new Map<string, string>();
    for (const directory of directories) {
      const absolutePath = path.resolve(directory);
      const key = normalizePathForComparison(absolutePath);
      if (!deduped.has(key)) {
        deduped.set(key, absolutePath);
      }
    }

    return [...deduped.values()];
  };

  const buildAccessScopeSnapshot = () => {
    return [
      "Workspace: " + runtime.workspaceRoot
    ];
  };

  const isDirectoryAlreadyAllowed = (directory: string) => {
    const targetKey = normalizePathForComparison(directory);
    return runtime
      .getAllowedRoots()
      .some((allowedRoot) => normalizePathForComparison(allowedRoot) === targetKey);
  };

  return {
    resolveAdditionalDirectory,
    normalizePathForComparison,
    dedupeDirectories,
    buildAccessScopeSnapshot,
    isDirectoryAlreadyAllowed
  };
}
