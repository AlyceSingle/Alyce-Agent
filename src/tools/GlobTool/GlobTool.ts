import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { resolveWorkspacePath } from "../internal/pathSandbox.js";
import {
  runRipgrep,
  sortWorkspaceRelativePathsByModifiedTime,
  splitRipgrepLines
} from "../internal/ripgrep.js";
import type { ToolExecutionContext } from "../types.js";
import { GLOB_TOOL_DESCRIPTION, GLOB_TOOL_NAME } from "./prompt.js";

const DEFAULT_GLOB_LIMIT = 100;
const VCS_DIRECTORIES_TO_EXCLUDE = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const;

export const GlobInputSchema = z
  .object({
    pattern: z.string().min(1).describe("Glob pattern to match files against."),
    path: z
      .string()
      .optional()
      .describe("Optional directory to search in. Defaults to the workspace root.")
  })
  .strict();

export interface GlobResult {
  durationMs: number;
  numFiles: number;
  filenames: string[];
  truncated: boolean;
}

export { GLOB_TOOL_NAME, GLOB_TOOL_DESCRIPTION };

export async function executeGlobTool(
  input: z.infer<typeof GlobInputSchema>,
  context: ToolExecutionContext
): Promise<GlobResult> {
  throwIfAborted(context.abortSignal);

  const searchRoot = await resolveDirectoryTarget(context.workspaceRoot, input.path);
  const args = ["--files", "--hidden", "--glob", input.pattern];
  for (const excludedDirectory of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${excludedDirectory}`);
  }
  args.push(searchRoot.ripgrepPath);

  const outcome = await runRipgrep(
    args,
    context.workspaceRoot,
    context.commandTimeoutMs,
    context.abortSignal
  );

  if (outcome.timedOut) {
    throw new Error(`Glob timed out after ${context.commandTimeoutMs} ms`);
  }

  if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
    throw new Error(buildRipgrepErrorMessage("Glob", outcome.exitCode, outcome.stderr));
  }

  const matches = splitRipgrepLines(outcome.stdout).map(normalizeRelativePath);
  const sortedMatches = await sortWorkspaceRelativePathsByModifiedTime(context.workspaceRoot, matches);
  const truncated = sortedMatches.length > DEFAULT_GLOB_LIMIT;
  const filenames = sortedMatches.slice(0, DEFAULT_GLOB_LIMIT);

  return {
    durationMs: outcome.durationMs,
    numFiles: filenames.length,
    filenames,
    truncated
  };
}

async function resolveDirectoryTarget(workspaceRoot: string, requestedPath: string | undefined) {
  if (!requestedPath || requestedPath.trim().length === 0) {
    return {
      absolutePath: workspaceRoot,
      ripgrepPath: "."
    };
  }

  const normalizedPath = requestedPath.trim();
  const absolutePath = resolvePathWithinWorkspace(workspaceRoot, normalizedPath);
  const stats = await fs.stat(absolutePath);

  if (!stats.isDirectory()) {
    throw new Error(`Glob requires a directory path: ${requestedPath}`);
  }

  const relativePath = path.relative(workspaceRoot, absolutePath);
  return {
    absolutePath,
    ripgrepPath: relativePath.length > 0 ? relativePath : "."
  };
}

function resolvePathWithinWorkspace(workspaceRoot: string, requestedPath: string) {
  if (!path.isAbsolute(requestedPath)) {
    return resolveWorkspacePath(workspaceRoot, requestedPath);
  }

  const absolutePath = path.resolve(requestedPath);
  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Path escapes workspace root");
  }

  return absolutePath;
}

function normalizeRelativePath(relativePath: string) {
  return path.normalize(relativePath.replace(/^[.][\\/]/, ""));
}

function buildRipgrepErrorMessage(toolName: string, exitCode: number | null, stderr: string) {
  const normalizedStderr = stderr.trim();
  if (normalizedStderr.length > 0) {
    return `${toolName} failed: ${normalizedStderr}`;
  }

  return `${toolName} failed with exit code ${exitCode ?? "unknown"}`;
}
