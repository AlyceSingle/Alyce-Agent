import { promises as fs } from "node:fs";
import type { FileReadState, ToolExecutionContext } from "../types.js";

export async function ensureFreshFileRead(
  absolutePath: string,
  context: ToolExecutionContext,
  toolName: string
): Promise<FileReadState> {
  const readState = context.getFileReadState(absolutePath);
  if (!readState) {
    throw new Error(`${toolName} requires a full text Read on the current file before modifying it.`);
  }

  if (readState.kind !== "text") {
    throw new Error(
      `${toolName} requires a full text Read before modifying ${readState.displayPath}. Directory reads, notebook summaries, and binary metadata reads are not sufficient.`
    );
  }

  if (readState.isPartial) {
    throw new Error(
      `${toolName} requires a full text Read before modifying ${readState.displayPath}. Read the entire file without offset/limit first.`
    );
  }

  const stats = await fs.stat(absolutePath);
  if (readState.mtimeMs !== undefined && !isSameMtime(readState.mtimeMs, stats.mtimeMs)) {
    throw new Error(
      `File changed since the last Read. Use Read again before modifying ${readState.displayPath}.`
    );
  }

  return readState;
}

export async function recordWrittenTextFile(
  absolutePath: string,
  displayPath: string,
  lineCount: number,
  context: ToolExecutionContext
): Promise<void> {
  const stats = await fs.stat(absolutePath);
  context.recordFileRead(absolutePath, {
    kind: "text",
    source: "write",
    displayPath,
    readAt: new Date().toISOString(),
    mtimeMs: stats.mtimeMs,
    sizeBytes: stats.size,
    offset: 1,
    totalCount: lineCount,
    returnedCount: lineCount,
    isPartial: false
  });
}

function isSameMtime(left: number, right: number) {
  return Math.abs(left - right) < 0.001;
}
