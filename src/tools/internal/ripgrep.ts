import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { TurnInterruptedError, getAbortReason } from "../../core/abort.js";
import { resolveWorkspacePath } from "./pathSandbox.js";

export interface RipgrepExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runRipgrep(
  args: string[],
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<RipgrepExecutionResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("rg", args, {
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

    const finishResolve = (value: Omit<RipgrepExecutionResult, "durationMs">) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve({
        ...value,
        durationMs: Date.now() - startedAt
      });
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
          "ripgrep interrupted by user"
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        finishReject(new Error("ripgrep executable 'rg' was not found in PATH"));
        return;
      }

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

export function splitRipgrepLines(stdout: string): string[] {
  const normalized = stdout.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return normalized.length > 0 ? normalized.split("\n") : [];
}

export async function sortWorkspaceRelativePathsByModifiedTime(
  workspaceRoot: string,
  relativePaths: string[]
): Promise<string[]> {
  const stats = await Promise.allSettled(
    relativePaths.map((relativePath) => fs.stat(resolveWorkspacePath(workspaceRoot, relativePath)))
  );

  return relativePaths
    .map((relativePath, index) => {
      const statResult = stats[index];
      return [
        relativePath,
        statResult?.status === "fulfilled" ? statResult.value.mtimeMs ?? 0 : 0
      ] as const;
    })
    .sort((left, right) => {
      const timeComparison = right[1] - left[1];
      if (timeComparison !== 0) {
        return timeComparison;
      }

      return left[0].localeCompare(right[0]);
    })
    .map(([relativePath]) => relativePath);
}
