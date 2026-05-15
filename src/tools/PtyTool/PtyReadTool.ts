import { z } from "zod";
import type { ToolExecutionContext } from "../types.js";
import { PTY_READ_TOOL_DESCRIPTION, PTY_READ_TOOL_NAME } from "./prompt.js";
import { toPtySessionSummary, type PtySessionSummary } from "./PtyListTool.js";

export const PtyReadInputSchema = z
  .object({
    pty_id: z.string().trim().min(1).describe("The pty_id returned by PtyCreate or PtyList."),
    cursor: z.number().int().optional().describe("Cursor to read from. Use -1 for current end."),
    limit: z.number().int().positive().optional().describe("Maximum characters to read."),
    tail_lines: z.number().int().positive().optional().describe("Return only the last N lines.")
  })
  .strict();

export interface PtyReadResult {
  pty_id: string;
  content: string;
  cursor: number;
  next_cursor: number;
  buffer_cursor: number;
  bytes: number;
  eof: boolean;
  session: PtySessionSummary;
}

export { PTY_READ_TOOL_DESCRIPTION, PTY_READ_TOOL_NAME };

export async function executePtyReadTool(
  input: z.infer<typeof PtyReadInputSchema>,
  context: ToolExecutionContext
): Promise<PtyReadResult> {
  if (!context.ptyManager) {
    throw new Error("PtyRead is not available in this execution context.");
  }

  const result = context.ptyManager.readSession(input.pty_id, {
    cursor: input.cursor,
    limit: input.limit,
    tailLines: input.tail_lines
  });

  return {
    pty_id: result.ptyId,
    content: result.content,
    cursor: result.cursor,
    next_cursor: result.nextCursor,
    buffer_cursor: result.bufferCursor,
    bytes: result.bytes,
    eof: result.eof,
    session: toPtySessionSummary(result.info)
  };
}
