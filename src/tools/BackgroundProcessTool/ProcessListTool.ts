import { z } from "zod";
import type { BackgroundProcessRecord } from "../../core/background-process/backgroundProcessTypes.js";
import type { ToolExecutionContext } from "../types.js";
import { PROCESS_LIST_TOOL_DESCRIPTION, PROCESS_LIST_TOOL_NAME } from "./prompt.js";

export const ProcessListInputSchema = z
  .object({
    include_exited: z
      .boolean()
      .optional()
      .describe("When true, include exited, failed, and stopped processes. Defaults to false.")
  })
  .strict();

export interface ProcessListResult {
  processes: ProcessSummary[];
}

export interface ProcessSummary {
  process_id: string;
  status: BackgroundProcessRecord["status"];
  pid: number | null;
  command: string;
  cwd: string;
  label?: string;
  started_at: string;
  updated_at: string;
  exited_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  detected_urls: string[];
  detected_ports: number[];
  warnings: string[];
  startup_matched?: string;
  startup_timed_out?: boolean;
  last_error?: string;
}

export { PROCESS_LIST_TOOL_DESCRIPTION, PROCESS_LIST_TOOL_NAME };

export async function executeProcessListTool(
  input: z.infer<typeof ProcessListInputSchema>,
  context: ToolExecutionContext
): Promise<ProcessListResult> {
  if (!context.backgroundProcessManager) {
    throw new Error("ProcessList is not available in this execution context.");
  }

  return {
    processes: context.backgroundProcessManager
      .listProcesses({ includeExited: input.include_exited })
      .map(toProcessSummary)
  };
}

export function toProcessSummary(record: BackgroundProcessRecord): ProcessSummary {
  return {
    process_id: record.id,
    status: record.status,
    pid: record.pid,
    command: record.command,
    cwd: record.cwd,
    ...(record.label ? { label: record.label } : {}),
    started_at: record.startedAt,
    updated_at: record.updatedAt,
    ...(record.exitedAt ? { exited_at: record.exitedAt } : {}),
    ...(record.exitCode !== undefined ? { exit_code: record.exitCode } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {}),
    detected_urls: [...record.detectedUrls],
    detected_ports: [...record.detectedPorts],
    warnings: [...record.warnings],
    ...(record.startupMatched ? { startup_matched: record.startupMatched } : {}),
    ...(record.startupTimedOut !== undefined ? { startup_timed_out: record.startupTimedOut } : {}),
    ...(record.lastError ? { last_error: record.lastError } : {})
  };
}
