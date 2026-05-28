import path from "node:path";
import { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import type { BackgroundProcessRecord } from "../../core/background-process/backgroundProcessTypes.js";
import { capturePossibleCommandWritePaths } from "../internal/commandFileCapture.js";
import { resolveCommandWorkingDirectory } from "../internal/commandWorkingDirectory.js";
import {
  analyzeCommandSafety,
  formatCommandSafetyDetails,
  type CommandDialect
} from "../internal/commandSafety.js";
import { toWorkspaceRelative } from "../internal/pathSandbox.js";
import type { ToolExecutionContext } from "../types.js";
import { PROCESS_START_TOOL_DESCRIPTION, PROCESS_START_TOOL_NAME } from "./prompt.js";

export const ProcessStartInputSchema = z
  .object({
    command: z.string().trim().min(1).describe("Command to start as a background process."),
    cwd: z
      .string()
      .optional()
      .describe(
        "Optional working directory. Absolute path preferred; supports ~ and ~/..., plus workspace-relative paths on the local filesystem."
      ),
    startup_timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Startup observation window in milliseconds. The process is not killed when this window elapses."),
    wait_for: z
      .array(z.string().min(1))
      .optional()
      .describe("Output substrings that indicate startup readiness, such as Local:, localhost, ready, compiled, or started."),
    env: z
      .record(z.string())
      .optional()
      .describe("Additional environment variables for the process."),
    label: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Optional short label for display and process listing.")
  })
  .strict();

export interface ProcessStartResult {
  status: BackgroundProcessRecord["status"];
  process_id: string;
  pid: number | null;
  command: string;
  cwd: string;
  label?: string;
  started_at: string;
  updated_at: string;
  exited_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  stdout_log_path: string;
  stderr_log_path: string;
  combined_log_path: string;
  record_path: string;
  stdout_preview: string;
  stderr_preview: string;
  detected_urls: string[];
  detected_ports: number[];
  warnings: string[];
  startup_matched?: string;
  startup_timed_out?: boolean;
  last_error?: string;
}

export { PROCESS_START_TOOL_DESCRIPTION, PROCESS_START_TOOL_NAME };

export async function executeProcessStartTool(
  input: z.infer<typeof ProcessStartInputSchema>,
  context: ToolExecutionContext
): Promise<ProcessStartResult> {
  if (!context.backgroundProcessManager) {
    throw new Error("ProcessStart is not available in this execution context.");
  }

  if (context.planMode) {
    throw new Error("ProcessStart is blocked by Plan Mode. Exit Plan Mode before starting background processes.");
  }

  throwIfAborted(context.abortSignal);

  const dialect = getCommandDialect();
  const safety = analyzeCommandSafety(dialect, input.command);
  if (safety.action === "deny") {
    throw new Error([
      "Background process command blocked by safety policy.",
      ...safety.reasons,
      `Command: ${safety.normalizedCommand}`
    ].join("\n"));
  }

  const startupTimeoutMs = normalizeStartupTimeout(input.startup_timeout_ms, context.commandTimeoutMs);
  const workingDirectory = await resolveCommandWorkingDirectory(context, input.cwd, {
    toolName: PROCESS_START_TOOL_NAME,
    title: "Start background process in external directory"
  });
  const approved = await context.requestApproval({
    kind: "command",
    toolName: PROCESS_START_TOOL_NAME,
    title: "Start background process",
    summary: summarizeCommand(input.command),
    details: [
      "Mode: background process",
      `Working directory: ${toWorkspaceRelative(context.workspaceRoot, workingDirectory)}`,
      `Startup observation window: ${startupTimeoutMs} ms`,
      "This command may open a local server port.",
      `Command: ${input.command}`,
      `Logs: runtime background-process storage for process <process_id>`,
      "Stop command: ProcessStop with the returned process_id",
      ...formatCommandSafetyDetails(safety)
    ],
    permission: {
      permission: dialect === "powershell" ? "powershell" : "shell",
      pattern: safety.permissionPattern
    },
    forceAsk: safety.forceAsk
  });

  if (!approved) {
    throw new Error("User rejected ProcessStart tool request");
  }

  throwIfAborted(context.abortSignal);
  await capturePossibleCommandWritePaths({
    analysis: safety,
    context,
    workingDirectory
  });
  context.recordToolActivity?.(PROCESS_START_TOOL_NAME);

  const record = await context.backgroundProcessManager.startProcess({
    command: input.command,
    cwd: workingDirectory,
    startupTimeoutMs,
    waitFor: input.wait_for,
    env: input.env,
    label: input.label
  });

  return toProcessStartResult(record);
}

export function toProcessStartResult(record: BackgroundProcessRecord): ProcessStartResult {
  return {
    status: record.status,
    process_id: record.id,
    pid: record.pid,
    command: record.command,
    cwd: record.cwd,
    ...(record.label ? { label: record.label } : {}),
    started_at: record.startedAt,
    updated_at: record.updatedAt,
    ...(record.exitedAt ? { exited_at: record.exitedAt } : {}),
    ...(record.exitCode !== undefined ? { exit_code: record.exitCode } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {}),
    stdout_log_path: record.stdoutLogPath,
    stderr_log_path: record.stderrLogPath,
    combined_log_path: record.combinedLogPath,
    record_path: record.recordPath,
    stdout_preview: record.stdoutPreview,
    stderr_preview: record.stderrPreview,
    detected_urls: [...record.detectedUrls],
    detected_ports: [...record.detectedPorts],
    warnings: [...record.warnings],
    ...(record.startupMatched ? { startup_matched: record.startupMatched } : {}),
    ...(record.startupTimedOut !== undefined ? { startup_timed_out: record.startupTimedOut } : {}),
    ...(record.lastError ? { last_error: record.lastError } : {})
  };
}

function getCommandDialect(): CommandDialect {
  return process.platform === "win32" ? "powershell" : "shell";
}

function normalizeStartupTimeout(requested: number | undefined, fallback: number): number {
  const base = requested ?? Math.min(fallback || 30_000, 30_000);
  return Math.min(Math.max(1, Math.trunc(base)), 120_000);
}

function summarizeCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  const maxChars = 120;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}
