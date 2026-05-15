import { z } from "zod";
import type { ToolExecutionContext } from "../types.js";
import { PTY_RESIZE_TOOL_DESCRIPTION, PTY_RESIZE_TOOL_NAME } from "./prompt.js";
import { toPtySessionSummary, type PtySessionSummary } from "./PtyListTool.js";

export const PtyResizeInputSchema = z
  .object({
    pty_id: z.string().trim().min(1).describe("The pty_id returned by PtyCreate or PtyList."),
    cols: z.number().int().positive().describe("Terminal columns."),
    rows: z.number().int().positive().describe("Terminal rows.")
  })
  .strict();

export interface PtyResizeResult {
  pty_id: string;
  cols: number;
  rows: number;
  session: PtySessionSummary;
}

export { PTY_RESIZE_TOOL_DESCRIPTION, PTY_RESIZE_TOOL_NAME };

export async function executePtyResizeTool(
  input: z.infer<typeof PtyResizeInputSchema>,
  context: ToolExecutionContext
): Promise<PtyResizeResult> {
  if (!context.ptyManager) {
    throw new Error("PtyResize is not available in this execution context.");
  }

  if (context.planMode) {
    throw new Error("PtyResize is blocked by Plan Mode. Exit Plan Mode before resizing interactive PTY sessions.");
  }

  const result = context.ptyManager.resizeSession(input.pty_id, input.cols, input.rows);
  context.recordToolActivity?.(PTY_RESIZE_TOOL_NAME);
  return {
    pty_id: result.ptyId,
    cols: result.cols,
    rows: result.rows,
    session: toPtySessionSummary(result.info)
  };
}
