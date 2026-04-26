import { promises as fs } from "node:fs";
import path from "node:path";

export interface StartupInstruction {
  path: string;
  content: string;
  truncated: boolean;
}

export interface StartupInstructionLoadResult {
  instructions: StartupInstruction[];
  warnings: string[];
}

export interface StartupInstructionLoadOptions {
  filePaths: readonly string[];
  allowedRoots: readonly string[];
  maxCharsPerFile?: number;
  maxTotalChars?: number;
}

const DEFAULT_MAX_CHARS_PER_FILE = 12_000;
const DEFAULT_MAX_TOTAL_CHARS = 24_000;

export async function loadStartupInstructions(
  options: StartupInstructionLoadOptions
): Promise<StartupInstructionLoadResult> {
  const warnings: string[] = [];
  const instructions: StartupInstruction[] = [];
  const maxCharsPerFile = options.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE;
  const maxTotalChars = options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;
  let remainingChars = maxTotalChars;

  for (const configuredPath of options.filePaths) {
    const absolutePath = path.resolve(configuredPath);
    if (!isPathWithinAllowedRoots(absolutePath, options.allowedRoots)) {
      warnings.push(`Startup instruction file is outside the allowed roots and was skipped: ${absolutePath}`);
      continue;
    }

    let stats;
    try {
      stats = await fs.stat(absolutePath);
    } catch (error) {
      warnings.push(`Failed to read startup instruction file: ${absolutePath}. ${toErrorMessage(error)}`);
      continue;
    }

    if (!stats.isFile()) {
      warnings.push(`Startup instruction path is not a file and was skipped: ${absolutePath}`);
      continue;
    }

    if (remainingChars <= 0) {
      warnings.push(`Startup instruction budget exhausted before loading: ${absolutePath}`);
      continue;
    }

    let rawContent: string;
    try {
      rawContent = await fs.readFile(absolutePath, "utf8");
    } catch (error) {
      warnings.push(`Failed to load startup instruction file: ${absolutePath}. ${toErrorMessage(error)}`);
      continue;
    }

    const normalizedContent = rawContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
    if (normalizedContent.length === 0) {
      warnings.push(`Startup instruction file is empty and was skipped: ${absolutePath}`);
      continue;
    }

    const fileBudget = Math.min(maxCharsPerFile, remainingChars);
    const truncated = normalizedContent.length > fileBudget;
    const content = truncated
      ? normalizedContent.slice(0, Math.max(1, fileBudget)).trimEnd()
      : normalizedContent;

    instructions.push({
      path: absolutePath,
      content,
      truncated
    });
    remainingChars -= content.length;
  }

  return {
    instructions,
    warnings
  };
}

function isPathWithinAllowedRoots(targetPath: string, allowedRoots: readonly string[]): boolean {
  const normalizedTarget = normalizePathForComparison(targetPath);

  return allowedRoots.some((allowedRoot) => {
    const normalizedRoot = normalizePathForComparison(allowedRoot);
    const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep;
    return (
      normalizedTarget === normalizedRoot ||
      normalizedTarget.startsWith(rootPrefix)
    );
  });
}

function normalizePathForComparison(value: string) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
