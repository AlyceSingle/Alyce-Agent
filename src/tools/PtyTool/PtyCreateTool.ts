import { z } from "zod";
import { throwIfAborted } from "../../core/abort.js";
import { getPreferredShell } from "../../core/pty/ptyManager.js";
import type { ToolExecutionContext } from "../types.js";
import {
  analyzeCommandSafety,
  formatCommandSafetyDetails
} from "../internal/commandSafety.js";
import { resolveCommandWorkingDirectory } from "../internal/commandWorkingDirectory.js";
import { toWorkspaceRelative } from "../internal/pathSandbox.js";
import { PTY_CREATE_TOOL_DESCRIPTION, PTY_CREATE_TOOL_NAME } from "./prompt.js";
import { toPtySessionSummary, type PtySessionSummary } from "./PtyListTool.js";

export const PtyCreateInputSchema = z
  .object({
    command: z.string().trim().min(1).optional().describe("Executable to launch. Defaults to the preferred interactive shell."),
    args: z.array(z.string()).optional().describe("Arguments passed to the executable."),
    cwd: z.string().optional().describe("Working directory for the PTY session."),
    title: z.string().trim().min(1).optional().describe("Optional display title."),
    env: z.record(z.string()).optional().describe("Additional environment variables."),
    cols: z.number().int().positive().optional().describe("Initial terminal columns."),
    rows: z.number().int().positive().optional().describe("Initial terminal rows.")
  })
  .strict();

export interface PtyCreateResult extends PtySessionSummary {
  note?: string;
}

export { PTY_CREATE_TOOL_DESCRIPTION, PTY_CREATE_TOOL_NAME };

export async function executePtyCreateTool(
  input: z.infer<typeof PtyCreateInputSchema>,
  context: ToolExecutionContext
): Promise<PtyCreateResult> {
  if (!context.ptyManager) {
    throw new Error("PtyCreate is not available in this execution context.");
  }

  if (context.planMode) {
    throw new Error("PtyCreate is blocked by Plan Mode. Exit Plan Mode before creating interactive PTY sessions.");
  }

  throwIfAborted(context.abortSignal);
  const command = input.command?.trim() || getPreferredShell();
  const commandLine = formatCommandLine(command, input.args ?? []);
  const safety = analyzeCommandSafety(process.platform === "win32" ? "powershell" : "shell", commandLine);
  if (safety.action === "deny") {
    throw new Error([
      "PTY command blocked by safety policy.",
      ...safety.reasons,
      `Command: ${safety.normalizedCommand}`
    ].join("\n"));
  }

  const workingDirectory = await resolveCommandWorkingDirectory(context, input.cwd, {
    toolName: PTY_CREATE_TOOL_NAME,
    title: "Create PTY session in external directory"
  });
  const approved = await context.requestApproval({
    kind: "command",
    toolName: PTY_CREATE_TOOL_NAME,
    title: "Create interactive PTY session",
    summary: summarizeCommand(commandLine),
    details: [
      "Mode: interactive PTY",
      `Working directory: ${toWorkspaceRelative(context.workspaceRoot, workingDirectory)}`,
      `Command: ${commandLine}`,
      `Size: ${input.cols ?? 80}x${input.rows ?? 24}`,
      input.title ? `Title: ${input.title}` : null,
      "Input written later with PtyWrite can execute commands inside this PTY.",
      ...formatCommandSafetyDetails(safety)
    ].filter((line): line is string => line !== null),
    permission: {
      permission: "shell",
      pattern: safety.permissionPattern
    },
    forceAsk: safety.forceAsk
  });

  if (!approved) {
    throw new Error("User rejected PtyCreate tool request");
  }

  context.recordToolActivity?.(PTY_CREATE_TOOL_NAME);
  const info = context.ptyManager.createSession({
    command,
    args: input.args,
    cwd: workingDirectory,
    title: input.title,
    env: input.env,
    cols: input.cols,
    rows: input.rows
  });

  return {
    ...toPtySessionSummary(info),
    note: info.status === "failed"
      ? "PTY backend failed to create a native terminal session."
      : "Use PtyRead to inspect output, PtyWrite to send input, PtyResize to resize, and PtyClose to terminate."
  };
}

function formatCommandLine(command: string, args: readonly string[]): string {
  if (args.length === 0) {
    return command;
  }

  return [command, ...args.map(quoteArg)].join(" ");
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) {
    return value;
  }

  return `"${value.replace(/(["\\])/gu, "\\$1")}"`;
}

function summarizeCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  const maxChars = 120;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}
