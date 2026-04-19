import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { truncate } from "../internal/values.js";
import { resolvePathFromInput } from "../internal/pathSandbox.js";
import {
  runRipgrep,
  sortWorkspaceRelativePathsByModifiedTime,
  splitRipgrepLines
} from "../internal/ripgrep.js";
import type { ToolExecutionContext } from "../types.js";
import { GREP_TOOL_DESCRIPTION, GREP_TOOL_NAME } from "./prompt.js";

const DEFAULT_HEAD_LIMIT = 250;
const VCS_DIRECTORIES_TO_EXCLUDE = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] as const;

const OutputModeSchema = z.enum(["content", "files_with_matches", "count"]);

export const GrepInputSchema = z
  .object({
    pattern: z.string().min(1).describe("Regular expression pattern to search for."),
    path: z
      .string()
      .optional()
      .describe(
        "Optional file or directory. Absolute path preferred; supports ~ and ~/..., plus workspace-relative paths on the local filesystem."
      ),
    glob: z
      .string()
      .optional()
      .describe("Optional glob filter such as *.ts or *.{ts,tsx}."),
    output_mode: OutputModeSchema.optional().describe("Search output mode."),
    "-B": z.number().int().nonnegative().optional().describe("Lines of context before each match."),
    "-A": z.number().int().nonnegative().optional().describe("Lines of context after each match."),
    "-C": z.number().int().nonnegative().optional().describe("Lines of context before and after each match."),
    context: z.number().int().nonnegative().optional().describe("Alias for symmetric context output."),
    "-n": z.boolean().optional().describe("Show line numbers in content mode."),
    "-i": z.boolean().optional().describe("Case-insensitive search."),
    type: z.string().optional().describe("ripgrep file type filter, for example ts or rust."),
    head_limit: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Maximum number of output entries. Use 0 for unlimited."),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Skip the first N output entries before applying head_limit."),
    multiline: z
      .boolean()
      .optional()
      .describe("Enable multiline regex mode so matches may span lines.")
  })
  .strict();

export const GrepOutputSchema = z
  .object({
    mode: OutputModeSchema.optional(),
    numFiles: z.number(),
    filenames: z.array(z.string()),
    content: z.string().optional(),
    numLines: z.number().optional(),
    numMatches: z.number().optional(),
    appliedLimit: z.number().optional(),
    appliedOffset: z.number().optional()
  })
  .strict();

export type GrepResult = z.infer<typeof GrepOutputSchema>;

export { GREP_TOOL_NAME, GREP_TOOL_DESCRIPTION };

export async function executeGrepTool(
  input: z.infer<typeof GrepInputSchema>,
  context: ToolExecutionContext
): Promise<GrepResult> {
  throwIfAborted(context.abortSignal);

  const searchTarget = await resolveSearchTarget(
    context.workspaceRoot,
    context.allowedRoots,
    input.path
  );
  const outputMode = input.output_mode ?? "files_with_matches";
  const offset = input.offset ?? 0;
  const headLimit = input.head_limit;
  const showLineNumbers = input["-n"] ?? true;
  const args = ["--hidden", "--color", "never", "--no-heading", "--max-columns", "500", "-H"];

  for (const excludedDirectory of VCS_DIRECTORIES_TO_EXCLUDE) {
    args.push("--glob", `!${excludedDirectory}`);
  }

  if (input.multiline) {
    args.push("-U", "--multiline-dotall");
  }

  if (input["-i"]) {
    args.push("-i");
  }

  if (outputMode === "files_with_matches") {
    args.push("-l");
  } else if (outputMode === "count") {
    args.push("-c");
  } else if (showLineNumbers) {
    args.push("-n");
  }

  if (outputMode === "content") {
    applyContextOptions(args, input);
  }

  if (input.type?.trim()) {
    args.push("--type", input.type.trim());
  }

  for (const globPattern of parseGlobPatterns(input.glob)) {
    args.push("--glob", globPattern);
  }

  if (input.pattern.startsWith("-")) {
    args.push("-e", input.pattern);
  } else {
    args.push(input.pattern);
  }

  args.push(searchTarget.ripgrepPath);

  const outcome = await runRipgrep(
    args,
    context.workspaceRoot,
    context.commandTimeoutMs,
    context.abortSignal
  );

  if (outcome.timedOut) {
    throw new Error(`Grep timed out after ${context.commandTimeoutMs} ms`);
  }

  if (outcome.exitCode !== 0 && outcome.exitCode !== 1) {
    throw new Error(buildRipgrepErrorMessage("Grep", outcome.exitCode, outcome.stderr));
  }

  const rawResults = splitRipgrepLines(outcome.stdout);

  if (outputMode === "content") {
    const pagedResults = applyHeadLimit(rawResults, headLimit, offset);
    return {
      mode: "content",
      numFiles: 0,
      filenames: [],
      content: truncate(pagedResults.items.join("\n")),
      numLines: pagedResults.items.length,
      ...(pagedResults.appliedLimit !== undefined ? { appliedLimit: pagedResults.appliedLimit } : {}),
      ...(offset > 0 ? { appliedOffset: offset } : {})
    };
  }

  if (outputMode === "count") {
    const pagedResults = applyHeadLimit(rawResults, headLimit, offset);
    let totalMatches = 0;
    let fileCount = 0;

    for (const line of pagedResults.items) {
      const colonIndex = line.lastIndexOf(":");
      if (colonIndex <= 0) {
        continue;
      }

      const countValue = Number.parseInt(line.slice(colonIndex + 1), 10);
      if (Number.isNaN(countValue)) {
        continue;
      }

      totalMatches += countValue;
      fileCount += 1;
    }

    return {
      mode: "count",
      numFiles: fileCount,
      filenames: [],
      content: truncate(pagedResults.items.join("\n")),
      numMatches: totalMatches,
      ...(pagedResults.appliedLimit !== undefined ? { appliedLimit: pagedResults.appliedLimit } : {}),
      ...(offset > 0 ? { appliedOffset: offset } : {})
    };
  }

  const normalizedMatches = rawResults.map(normalizeRelativePath);
  const sortedMatches = await sortWorkspaceRelativePathsByModifiedTime(
    context.workspaceRoot,
    normalizedMatches,
    context.allowedRoots
  );
  const pagedMatches = applyHeadLimit(sortedMatches, headLimit, offset);

  return {
    mode: "files_with_matches",
    numFiles: pagedMatches.items.length,
    filenames: pagedMatches.items,
    ...(pagedMatches.appliedLimit !== undefined ? { appliedLimit: pagedMatches.appliedLimit } : {}),
    ...(offset > 0 ? { appliedOffset: offset } : {})
  };
}

function applyContextOptions(
  args: string[],
  input: Pick<z.infer<typeof GrepInputSchema>, "-A" | "-B" | "-C" | "context">
) {
  if (input.context !== undefined) {
    args.push("-C", String(input.context));
    return;
  }

  if (input["-C"] !== undefined) {
    args.push("-C", String(input["-C"]));
    return;
  }

  if (input["-B"] !== undefined) {
    args.push("-B", String(input["-B"]));
  }

  if (input["-A"] !== undefined) {
    args.push("-A", String(input["-A"]));
  }
}

function applyHeadLimit<T>(items: T[], limit: number | undefined, offset: number) {
  if (limit === 0) {
    return {
      items: items.slice(offset),
      appliedLimit: undefined as number | undefined
    };
  }

  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT;
  const pagedItems = items.slice(offset, offset + effectiveLimit);
  const appliedLimit = items.length - offset > effectiveLimit ? effectiveLimit : undefined;

  return {
    items: pagedItems,
    appliedLimit
  };
}

async function resolveSearchTarget(
  workspaceRoot: string,
  allowedRoots: readonly string[],
  requestedPath: string | undefined
) {
  if (!requestedPath || requestedPath.trim().length === 0) {
    return {
      absolutePath: workspaceRoot,
      ripgrepPath: "."
    };
  }

  const normalizedPath = requestedPath.trim();
  const absolutePath = resolvePathFromInput(workspaceRoot, allowedRoots, normalizedPath);
  await fs.stat(absolutePath);

  const relativePath = path.relative(workspaceRoot, absolutePath);
  const isInsideWorkspace = !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  return {
    absolutePath,
    ripgrepPath: isInsideWorkspace ? (relativePath.length > 0 ? relativePath : ".") : absolutePath
  };
}

function parseGlobPatterns(rawGlob: string | undefined) {
  if (!rawGlob || rawGlob.trim().length === 0) {
    return [] as string[];
  }

  const parsedPatterns: string[] = [];
  const rawPatterns = rawGlob.trim().split(/\s+/);

  for (const rawPattern of rawPatterns) {
    if (rawPattern.includes("{") && rawPattern.includes("}")) {
      parsedPatterns.push(rawPattern);
      continue;
    }

    for (const splitPattern of rawPattern.split(",")) {
      if (splitPattern.length > 0) {
        parsedPatterns.push(splitPattern);
      }
    }
  }

  return parsedPatterns;
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
