import { spawn } from "node:child_process";
import { z } from "zod";
import { TurnInterruptedError, getAbortReason, throwIfAborted } from "../../core/abort.js";
import { resolvePathFromInput, toWorkspaceRelative } from "../internal/pathSandbox.js";
import { truncate } from "../internal/values.js";
import type { ToolExecutionContext } from "../types.js";
import {
  DEFAULT_POWERSHELL_TIMEOUT_MS,
  MAX_POWERSHELL_TIMEOUT_MS,
  POWERSHELL_TOOL_DESCRIPTION
} from "./prompt.js";
import { POWERSHELL_TOOL_NAME } from "./toolName.js";

export const PowerShellInputSchema = z
  .object({
    command: z.string().min(1).describe("PowerShell command to execute"),
    timeout_ms: z.number().int().positive().optional().describe("Execution timeout in milliseconds"),
    cwd: z
      .string()
      .optional()
      .describe(
        "Optional working directory. Absolute path preferred; supports ~ and ~/..., plus workspace-relative paths on the local filesystem"
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe("Reserved for compatibility. Background execution is not supported in this runtime"),
    dangerouslyDisableSandbox: z
      .boolean()
      .optional()
      .describe("Compatibility field. This runtime does not provide shell sandbox toggling")
  })
  .strict();

export { POWERSHELL_TOOL_NAME };
export { POWERSHELL_TOOL_DESCRIPTION };

export interface PowerShellResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function executePowerShellTool(
  input: z.infer<typeof PowerShellInputSchema>,
  context: ToolExecutionContext
): Promise<PowerShellResult> {
  if (input.run_in_background) {
    throw new Error("run_in_background is not supported in this runtime");
  }

  throwIfAborted(context.abortSignal);

  const workingDirectory = resolveWorkingDirectory(
    context.workspaceRoot,
    context.allowedRoots,
    input.cwd
  );
  const timeoutMs = normalizeTimeout(input.timeout_ms, context.commandTimeoutMs);

  const approved = await context.requestApproval({
    kind: "command",
    toolName: POWERSHELL_TOOL_NAME,
    title: "Run PowerShell command",
    summary: summarizeCommand(input.command),
    details: [
      `Working directory: ${toWorkspaceRelative(context.workspaceRoot, workingDirectory)}`,
      `Timeout: ${timeoutMs} ms`
    ]
  });

  if (!approved) {
    throw new Error("User rejected PowerShell tool request");
  }

  throwIfAborted(context.abortSignal);

  const startedAt = Date.now();
  const outcome = await runPowerShellCommand(
    input.command,
    workingDirectory,
    timeoutMs,
    context.abortSignal
  );

  return {
    command: input.command,
    cwd: toWorkspaceRelative(context.workspaceRoot, workingDirectory),
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    stdout: truncate(outcome.stdout),
    stderr: truncate(outcome.stderr),
    durationMs: Date.now() - startedAt
  };
}

function resolveWorkingDirectory(
  workspaceRoot: string,
  allowedRoots: readonly string[],
  cwd: string | undefined
): string {
  if (!cwd || cwd.trim().length === 0) {
    return workspaceRoot;
  }

  return resolvePathFromInput(workspaceRoot, allowedRoots, cwd.trim());
}

function normalizeTimeout(requestedTimeout: number | undefined, fallback: number): number {
  const base = requestedTimeout ?? fallback ?? DEFAULT_POWERSHELL_TIMEOUT_MS;
  return Math.min(Math.max(1, Math.trunc(base)), MAX_POWERSHELL_TIMEOUT_MS);
}

function summarizeCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  const maxChars = 120;
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars)}...`;
}

function runPowerShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<{
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const executable = resolvePowerShellExecutable();

    const child = spawn(executable, ["-NoProfile", "-Command", command], {
      cwd,
      env: process.env,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      abortSignal?.removeEventListener("abort", handleAbort);
    };

    const finishResolve = (value: {
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    }) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(value);
    };

    const finishReject = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    };

    const handleAbort = () => {
      child.kill();
      finishReject(
        new TurnInterruptedError(
          getAbortReason(abortSignal) ?? "aborted",
          "PowerShell command interrupted by user"
        )
      );
    };

    if (abortSignal?.aborted) {
      handleAbort();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finishReject(error);
    });

    child.on("close", (exitCode, signal) => {
      finishResolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr
      });
    });
  });
}

function resolvePowerShellExecutable(): string {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}
