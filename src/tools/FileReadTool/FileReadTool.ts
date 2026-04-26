import { createReadStream, promises as fs } from "node:fs";
import { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { resolvePathFromInput, toWorkspaceRelative } from "../internal/pathSandbox.js";
import type { ToolExecutionContext } from "../types.js";
import { truncate } from "../internal/values.js";
import { getDefaultFileReadingLimits } from "./limits.js";

export const FileReadInputSchema = z
  .object({
    file_path: z
      .string()
      .describe(
        "Absolute path preferred; supports ~ and ~/..., plus workspace-relative paths, on the local filesystem"
      ),
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
  const hasExplicitLimit = input.limit !== undefined;

  if (requestedLimit > limits.maxLines) {
    throw new Error(`limit exceeds max allowed lines (${limits.maxLines})`);
  }

  const absolutePath = resolveReadPath(context.workspaceRoot, context.allowedRoots, input.file_path);
  const stats = await fs.stat(absolutePath);

  if (stats.isDirectory()) {
    throw new Error(`Read only supports files: ${input.file_path}`);
  }

  // 未指定 limit 时，限制总文件大小；指定 limit 时走流式读取，避免整文件进内存。
  if (!hasExplicitLimit && stats.size > limits.maxSizeBytes) {
    throw new Error(
      `File is too large (${formatBytes(stats.size)}). Please provide offset and limit for partial reads.`
    );
  }

  const { selectedLines, totalLines } = await readLineWindow(
    absolutePath,
    requestedStartLine,
    requestedLimit,
    context.abortSignal
  );
  const rendered = renderWithLineNumbers(totalLines, requestedStartLine, selectedLines);

  return {
    type: "text",
    file: {
      filePath: toWorkspaceRelative(context.workspaceRoot, absolutePath),
      content: truncate(rendered),
      numLines: selectedLines.length,
      startLine: requestedStartLine,
      totalLines
    }
  };
}

async function readLineWindow(
  absolutePath: string,
  startLine: number,
  limit: number,
  abortSignal?: AbortSignal
) {
  throwIfAborted(abortSignal);

  const selectedLines: string[] = [];
  const endLineExclusive = startLine + limit;
  const stream = createReadStream(absolutePath, {
    encoding: "utf8"
  });
  let totalLines = 0;
  let pending = "";
  let endedWithLineBreak = false;

  const handleAbort = () => {
    stream.destroy(new Error("File read interrupted by user"));
  };

  if (abortSignal?.aborted) {
    handleAbort();
  } else {
    abortSignal?.addEventListener("abort", handleAbort, { once: true });
  }

  const pushLine = (line: string) => {
    totalLines += 1;
    if (totalLines >= startLine && totalLines < endLineExclusive) {
      selectedLines.push(line);
    }
  };

  try {
    for await (const chunk of stream) {
      throwIfAborted(abortSignal);

      if (chunk.includes("\u0000")) {
        throw new Error("Read only supports text-like files");
      }

      pending += chunk;
      let lineBreakIndex = pending.indexOf("\n");
      while (lineBreakIndex !== -1) {
        const line = pending.slice(0, lineBreakIndex).replace(/\r$/, "");
        pushLine(line);
        pending = pending.slice(lineBreakIndex + 1);
        endedWithLineBreak = true;
        lineBreakIndex = pending.indexOf("\n");
      }

      if (pending.length > 0) {
        endedWithLineBreak = false;
      }
    }

    if (pending.length > 0) {
      pushLine(pending);
    } else if (endedWithLineBreak) {
      pushLine("");
    }
  } finally {
    abortSignal?.removeEventListener("abort", handleAbort);
  }

  return {
    selectedLines,
    totalLines
  };
}

function resolveReadPath(
  workspaceRoot: string,
  allowedRoots: readonly string[],
  filePath: string
): string {
  const normalized = filePath.trim();
  if (!normalized) {
    throw new Error("Read requires non-empty 'file_path'");
  }

  return resolvePathFromInput(workspaceRoot, allowedRoots, normalized);
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
