import { z } from "zod";
import type { BackgroundProcessLogStream } from "../../core/background-process/backgroundProcessTypes.js";
import type { ToolExecutionContext } from "../types.js";
import { PROCESS_READ_TOOL_DESCRIPTION, PROCESS_READ_TOOL_NAME } from "./prompt.js";

export const ProcessReadInputSchema = z
  .object({
    process_id: z
      .string()
      .trim()
      .min(1)
      .describe("The process_id returned by ProcessStart or ProcessList."),
    stream: z
      .enum(["stdout", "stderr", "combined"])
      .optional()
      .describe("Which log stream to read. Defaults to combined."),
    tail_lines: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Return only the last N lines."),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Byte offset to start reading from. Ignored when tail_lines is set."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum bytes to read. Ignored when tail_lines is set.")
  })
  .strict();

export interface ProcessReadResult {
  process_id: string;
  stream: BackgroundProcessLogStream;
  log_path: string;
  content: string;
  offset: number;
  bytes: number;
  eof: boolean;
}

export { PROCESS_READ_TOOL_DESCRIPTION, PROCESS_READ_TOOL_NAME };

export async function executeProcessReadTool(
  input: z.infer<typeof ProcessReadInputSchema>,
  context: ToolExecutionContext
): Promise<ProcessReadResult> {
  if (!context.backgroundProcessManager) {
    throw new Error("ProcessRead is not available in this execution context.");
  }

  const result = await context.backgroundProcessManager.readProcessLog(input.process_id, {
    stream: input.stream,
    tailLines: input.tail_lines,
    offset: input.offset,
    limit: input.limit
  });

  return {
    process_id: result.processId,
    stream: result.stream,
    log_path: result.logPath,
    content: result.content,
    offset: result.offset,
    bytes: result.bytes,
    eof: result.eof
  };
}
