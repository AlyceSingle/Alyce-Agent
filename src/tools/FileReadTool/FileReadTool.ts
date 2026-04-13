import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath, toWorkspaceRelative } from "../internal/pathSandbox.js";
import type { ToolExecutionContext } from "../types.js";
import { truncate } from "../internal/values.js";
import { getDefaultFileReadingLimits } from "./limits.js";

export const FileReadInputSchema = z
  .object({
    file_path: z.string().describe("Absolute path or workspace-relative path to the file"),
    offset: z.number().int().positive().optional().describe("1-based start line"),
    limit: z.number().int().positive().optional().describe("Number of lines to read")
  })
  .strict();

export interface FileReadResult {
  type: "text";
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
}

// Read 工具：采用 Claude Code 风格的 file_path/offset/limit 参数与行号输出。
export async function executeFileRead(
  input: z.infer<typeof FileReadInputSchema>,
  context: ToolExecutionContext
): Promise<FileReadResult> {
  const limits = getDefaultFileReadingLimits();
  const requestedStartLine = input.offset ?? 1;
  const requestedLimit = input.limit ?? limits.maxLines;

  if (requestedLimit > limits.maxLines) {
    throw new Error(`limit exceeds max allowed lines (${limits.maxLines})`);
  }

  const absolutePath = resolveReadPath(context.workspaceRoot, input.file_path);
  const stats = await fs.stat(absolutePath);

  if (stats.isDirectory()) {
    throw new Error(`Read only supports files: ${input.file_path}`);
  }

  // 未指定 limit 时，限制总文件大小，避免一次性读取过大文本。
  if (!input.limit && stats.size > limits.maxSizeBytes) {
    throw new Error(
      `File is too large (${formatBytes(stats.size)}). Please provide offset and limit for partial reads.`
    );
  }

  const raw = await fs.readFile(absolutePath, "utf8");
  if (looksLikeBinary(raw)) {
    throw new Error("Read only supports text-like files");
  }

  const allLines = raw.length === 0 ? [] : raw.split(/\r?\n/);
  const startIndex = requestedStartLine - 1;
  const selectedLines = allLines.slice(startIndex, startIndex + requestedLimit);
  const rendered = renderWithLineNumbers(allLines.length, requestedStartLine, selectedLines);

  return {
    type: "text",
    file: {
      filePath: toWorkspaceRelative(context.workspaceRoot, absolutePath),
      content: truncate(rendered),
      numLines: selectedLines.length,
      startLine: requestedStartLine,
      totalLines: allLines.length
    }
  };
}

function resolveReadPath(workspaceRoot: string, filePath: string): string {
  const normalized = filePath.trim();
  if (!normalized) {
    throw new Error("Read requires non-empty 'file_path'");
  }

  if (!path.isAbsolute(normalized)) {
    return resolveWorkspacePath(workspaceRoot, normalized);
  }

  const absolutePath = path.resolve(normalized);
  const relativeToWorkspace = path.relative(workspaceRoot, absolutePath);
  if (relativeToWorkspace.startsWith("..") || path.isAbsolute(relativeToWorkspace)) {
    throw new Error("Path escapes workspace root");
  }

  return absolutePath;
}

function renderWithLineNumbers(totalLines: number, startLine: number, lines: string[]): string {
  if (totalLines === 0) {
    return "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>";
  }

  if (lines.length === 0) {
    return `<system-reminder>Warning: offset ${startLine} is beyond file length (${totalLines} lines).</system-reminder>`;
  }

  return lines
    .map((line, index) => `${String(startLine + index).padStart(6, " ")}\t${line}`)
    .join("\n");
}

function looksLikeBinary(content: string): boolean {
  return content.includes("\u0000");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}