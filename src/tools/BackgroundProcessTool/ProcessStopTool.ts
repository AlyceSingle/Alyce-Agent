import { z } from "zod";
import type { BackgroundProcessRecord } from "../../core/background-process/backgroundProcessTypes.js";
import type { ToolExecutionContext } from "../types.js";
import { PROCESS_STOP_TOOL_DESCRIPTION, PROCESS_STOP_TOOL_NAME } from "./prompt.js";
import { toProcessSummary, type ProcessSummary } from "./ProcessListTool.js";

export const ProcessStopInputSchema = z
  .object({
    process_id: z
      .string()
      .trim()
      .min(1)
      .describe("The process_id returned by ProcessStart or ProcessList."),
    force: z
      .boolean()
      .optional()
      .describe("When true, request forceful termination immediately.")
  })
  .strict();

export interface ProcessStopResult {
  process_id: string;
  status: BackgroundProcessRecord["status"] | "not_found";
  message: string;
  exit_code?: number | null;
  signal?: string | null;
  process?: ProcessSummary;
}

export { PROCESS_STOP_TOOL_DESCRIPTION, PROCESS_STOP_TOOL_NAME };

export async function executeProcessStopTool(
  input: z.infer<typeof ProcessStopInputSchema>,
  context: ToolExecutionContext
): Promise<ProcessStopResult> {
  if (!context.backgroundProcessManager) {
    throw new Error("ProcessStop is not available in this execution context.");
  }

  if (context.planMode) {
    throw new Error("ProcessStop is blocked by Plan Mode. Exit Plan Mode before stopping background processes.");
  }

  const record = context.backgroundProcessManager.getProcess(input.process_id);
  const approved = await context.requestApproval({
    kind: "command",
    toolName: PROCESS_STOP_TOOL_NAME,
    title: "Stop background process",
    summary: input.process_id,
    details: [
      `Process id: ${input.process_id}`,
      `Mode: ${input.force ? "force stop" : "graceful stop"}`,
      ...(record
        ? [
            `PID: ${record.pid ?? "(unknown)"}`,
            `Status: ${record.status}`,
            `Working directory: ${record.cwd}`,
            `Command: ${record.command}`
          ]
        : ["Process is not currently known in memory."])
    ],
    permission: {
      permission: "shell",
      pattern: `ProcessStop ${input.process_id}`
    }
  });

  if (!approved) {
    throw new Error("User rejected ProcessStop tool request");
  }

  const result = await context.backgroundProcessManager.stopProcess(input.process_id, {
    force: input.force
  });
  if (result.status !== "not_found") {
    context.recordToolActivity?.(PROCESS_STOP_TOOL_NAME);
  }

  return {
    process_id: result.processId,
    status: result.status,
    message: result.message,
    ...(result.exitCode !== undefined ? { exit_code: result.exitCode } : {}),
    ...(result.signal !== undefined ? { signal: result.signal } : {}),
    ...(result.record ? { process: toProcessSummary(result.record) } : {})
  };
}
