import { spawn } from "node:child_process";
import { z } from "zod";
import { TurnInterruptedError, getAbortReason, throwIfAborted } from "../../core/abort.js";
import { resolveCommandWorkingDirectory } from "../internal/commandWorkingDirectory.js";
import { toWorkspaceRelative } from "../internal/pathSandbox.js";
import {
  decodeCapturedOutput,
  sanitizePowerShellErrorOutput,
  toOutputBuffer,
  wrapPowerShellCommand
} from "../internal/commandOutput.js";
import {
  analyzeCommandSafety,
  formatCommandSafetyDetails
} from "../internal/commandSafety.js";
import {
  WINDOWS_NATIVE_PACKAGE_MANAGER_FAST_PATH_NOTICE,
  resolveSimplePackageManagerFastPath,
  runSimplePackageManagerFastPath
} from "../internal/packageManagerFastPath.js";
import { shouldSpawnDetachedProcessGroup, terminateProcessTree } from "../internal/processTree.js";
import { truncate } from "../internal/values.js";
import { getWindowsPackageManagerShimNotice } from "../internal/windowsPackageManagerShim.js";
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

const FORCE_SETTLE_AFTER_KILL_MS = 1_000;

export async function executePowerShellTool(
  input: z.infer<typeof PowerShellInputSchema>,
  context: ToolExecutionContext
): Promise<PowerShellResult> {
  if (input.run_in_background) {
    throw new Error("run_in_background is not supported in this runtime");
  }

  throwIfAborted(context.abortSignal);

  const timeoutMs = normalizeTimeout(input.timeout_ms, context.commandTimeoutMs);
  const safety = analyzeCommandSafety("powershell", input.command);

  if (context.planMode && safety.category !== "safe-read-only") {
    throw new Error([
      "PowerShell command blocked by Plan Mode.",
      `Risk: ${safety.category} (${safety.level})`,
      ...safety.reasons,
      "Plan Mode only allows read-only PowerShell inspection commands.",
      `Command: ${safety.normalizedCommand}`
    ].join("\n"));
  }

  if (safety.action === "deny") {
    throw new Error([
      "PowerShell command blocked by safety policy.",
      ...safety.reasons,
      `Command: ${safety.normalizedCommand}`
    ].join("\n"));
  }

  const workingDirectory = await resolveCommandWorkingDirectory(context, input.cwd, {
    toolName: POWERSHELL_TOOL_NAME,
    title: "Run command in external directory"
  });
  const fastPathArgv = resolveSimplePackageManagerFastPath(input.command);
  const windowsCompatibilityNotice = fastPathArgv
    ? null
    : getWindowsPackageManagerShimNotice(input.command);
  const approved = await context.requestApproval({
    kind: "command",
    toolName: POWERSHELL_TOOL_NAME,
    title: "Run PowerShell command",
    summary: summarizeCommand(input.command),
    details: [
      `Working directory: ${toWorkspaceRelative(context.workspaceRoot, workingDirectory)}`,
      `Timeout: ${timeoutMs} ms`,
      ...(windowsCompatibilityNotice ? [windowsCompatibilityNotice] : []),
      ...(fastPathArgv ? [WINDOWS_NATIVE_PACKAGE_MANAGER_FAST_PATH_NOTICE] : []),
      ...formatCommandSafetyDetails(safety)
    ],
    permission: {
      permission: "powershell",
      pattern: safety.permissionPattern
    },
    forceAsk: context.planMode || safety.forceAsk
  });

  if (!approved) {
    throw new Error("User rejected PowerShell tool request");
  }

  throwIfAborted(context.abortSignal);
  context.recordToolActivity?.(POWERSHELL_TOOL_NAME);

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
  const fastPath = runSimplePackageManagerFastPath({
    command,
    cwd,
    timeoutMs,
    abortSignal,
    interruptedMessage: "PowerShell command interrupted by user"
  });
  return fastPath.then((result) => {
    if (result) {
      return result;
    }

    return runPowerShellCommandViaPowerShell(command, cwd, timeoutMs, abortSignal);
  });
}

function runPowerShellCommandViaPowerShell(
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
    const wrappedCommand = wrapPowerShellCommand(command);

    const child = spawn(executable, ["-NoProfile", "-Command", wrappedCommand], {
      cwd,
      env: process.env,
      detached: shouldSpawnDetachedProcessGroup(),
      windowsHide: true
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let forceSettleTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (forceSettleTimer) {
        clearTimeout(forceSettleTimer);
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
      terminateProcessTree(child);
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
      terminateProcessTree(child, "SIGTERM");
      forceSettleTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL");
        finishResolve({
          exitCode: null,
          signal: "SIGTERM",
          timedOut,
          stdout: decodeCapturedOutput(stdoutChunks),
          stderr: sanitizePowerShellErrorOutput(decodeCapturedOutput(stderrChunks))
        });
      }, FORCE_SETTLE_AFTER_KILL_MS);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(toOutputBuffer(chunk));
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(toOutputBuffer(chunk));
    });

    child.on("error", (error) => {
      finishReject(error);
    });

    child.on("close", (exitCode, signal) => {
      finishResolve({
        exitCode,
        signal,
        timedOut,
        stdout: decodeCapturedOutput(stdoutChunks),
        stderr: sanitizePowerShellErrorOutput(decodeCapturedOutput(stderrChunks))
      });
    });
  });
}

function resolvePowerShellExecutable(): string {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}
