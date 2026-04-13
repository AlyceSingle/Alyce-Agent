import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath, toWorkspaceRelative } from "../internal/pathSandbox.js";
import { truncate } from "../internal/values.js";
import type { ToolExecutionContext } from "../types.js";
import { BASH_TOOL_DESCRIPTION, DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS } from "./prompt.js";
import { BASH_TOOL_NAME } from "./toolName.js";

export const BashInputSchema = z
  .object({
    command: z.string().min(1).describe("Shell command to execute"),
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

export { BASH_TOOL_NAME };
export { BASH_TOOL_DESCRIPTION };

export interface BashResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface ShellCommand {
  executable: string;
  args: string[];
}

export async function executeBashTool(
  input: z.infer<typeof BashInputSchema>,
  context: ToolExecutionContext
): Promise<BashResult> {
  if (input.run_in_background) {
    throw new Error("run_in_background is not supported in this runtime");
  }

  const workingDirectory = resolveWorkingDirectory(context.workspaceRoot, input.cwd);
  const timeoutMs = normalizeTimeout(input.timeout_ms, context.commandTimeoutMs);

  // 命令执行属于高风险动作，统一在运行前请求用户确认。
  const approved = await context.requestApproval(
    `run shell command in ${toWorkspaceRelative(context.workspaceRoot, workingDirectory)}: ${summarizeCommand(input.command)}`
  );

  if (!approved) {
    throw new Error("User rejected Bash tool request");
  }

  const startedAt = Date.now();
  const outcome = await runShellCommand(input.command, workingDirectory, timeoutMs);

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
  const base = requestedTimeout ?? fallback ?? DEFAULT_BASH_TIMEOUT_MS;
  return Math.min(Math.max(1, Math.trunc(base)), MAX_BASH_TIMEOUT_MS);
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

function getShellCommand(command: string): ShellCommand {
  if (process.platform === "win32") {
    return {
      executable: "powershell.exe",
      args: ["-NoProfile", "-Command", command]
    };
  }

  return {
    executable: process.env.SHELL || "/bin/bash",
    args: ["-lc", command]
  };
}

function summarizeCommand(command: string): string {
  const normalized = command.replace(/\s+/g, " ").trim();
  const maxChars = 120;
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars)}...`;
}

function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<{
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const shell = getShellCommand(command);

    const child = spawn(shell.executable, shell.args, {
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
