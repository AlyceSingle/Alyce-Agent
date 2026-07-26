import { promises as fs } from "node:fs";
import path from "node:path";
import { TurnInterruptedError, getAbortReason } from "../../core/abort.js";
import { runNativeCommandWithTimeout } from "./nativeCommandRunner.js";
import { resolveAllowedPath, toWorkspaceRelative } from "./pathSandbox.js";
import { resolveRipgrepInvocation } from "./resolveRipgrep.js";

export interface RipgrepExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  durationMs: number;
}

const DEFAULT_RIPGREP_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export function resolveRipgrepMaxOutputBytes(env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = env.ALYCE_RIPGREP_MAX_OUTPUT_BYTES;
  if (!rawValue?.trim()) {
    return DEFAULT_RIPGREP_MAX_OUTPUT_BYTES;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_RIPGREP_MAX_OUTPUT_BYTES;
  }

  return parsed;
}

export async function runRipgrep(
  args: string[],
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<RipgrepExecutionResult> {
  const invocation = await resolveRipgrepInvocation();
  const result = await runNativeCommandWithTimeout([...invocation.argvPrefix, ...args], {
    cwd,
    env: process.env,
    timeoutMs,
    abortSignal,
    maxOutputBytes: resolveRipgrepMaxOutputBytes()
  });

  if (result.error === "aborted") {
    throw new TurnInterruptedError(
      getAbortReason(abortSignal) ?? "aborted",
      "ripgrep interrupted by user"
    );
  }

  if (result.error && !result.timedOut) {
    if (/ENOENT/i.test(result.error)) {
      throw new Error(
        "ripgrep executable 'rg' was not found. Install ripgrep, or reinstall Alyce to restore the bundled fallback."
      );
    }

    throw new Error(result.error);
  }

  return {
    exitCode: result.exitCode,
    signal: typeof result.signal === "string" ? result.signal : null,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stdoutTruncated: result.stdoutTruncated,
    stderr: result.stderr,
    durationMs: result.durationMs
  };
}

export function splitRipgrepLines(stdout: string): string[] {
  const normalized = stdout.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return normalized.length > 0 ? normalized.split("\n") : [];
}

export async function sortWorkspaceRelativePathsByModifiedTime(
  workspaceRoot: string,
  relativePaths: string[],
  allowedRoots: readonly string[] = [workspaceRoot],
  baseDirectory = workspaceRoot
): Promise<string[]> {
  const entries = relativePaths.map((entry) => {
    const absolutePath = path.isAbsolute(entry)
      ? path.resolve(entry)
      : resolveAllowedPath(allowedRoots, entry, baseDirectory);

    return {
      absolutePath,
      displayPath: toWorkspaceRelative(workspaceRoot, absolutePath)
    };
  });

  const stats = await Promise.allSettled(
    entries.map((entry) => fs.stat(entry.absolutePath))
  );

  return entries
    .map((entry, index) => {
      const statResult = stats[index];
      return [
        entry.displayPath,
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
