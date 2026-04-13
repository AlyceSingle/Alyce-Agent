import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath, toWorkspaceRelative } from "../internal/pathSandbox.js";
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
      .describe("Optional working directory. Absolute path or workspace-relative path"),
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

  const workingDirectory = resolveWorkingDirectory(context.workspaceRoot, input.cwd);
  const timeoutMs = normalizeTimeout(input.timeout_ms, context.commandTimeoutMs);

  // PowerShell 命令执行同样走审批，保证危险操作可被显式拦截。
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

  const startedAt = Date.now();
  const outcome = await runPowerShellCommand(input.command, workingDirectory, timeoutMs);

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

function resolveWorkingDirectory(workspaceRoot: string, cwd: string | undefined): string {
  if (!cwd || cwd.trim().length === 0) {
    return workspaceRoot;
  }

  const normalized = cwd.trim();
  if (!path.isAbsolute(normalized)) {
    return resolveWorkspacePath(workspaceRoot, normalized);
  }

  const absolute = path.resolve(normalized);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("cwd escapes workspace root");
  }

  return absolute;
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

function runPowerShellCommand(command: string, cwd: string, timeoutMs: number): Promise<{
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

    const timer = setTimeout(() => {
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
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
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
  // Windows 优先 powershell.exe；其他平台尝试 pwsh 以兼容 PowerShell Core。
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}
