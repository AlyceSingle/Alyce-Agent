import { spawn } from "node:child_process";
import { decodeCapturedOutput, toOutputBuffer } from "./commandOutput.js";
import { shouldSpawnDetachedProcessGroup, terminateProcessTree } from "./processTree.js";
import { resolveWindowsNativeCommandInvocation } from "./windowsNativeCommand.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const FORCE_SETTLE_AFTER_KILL_MS = 1_000;

export interface NativeCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  error?: string;
}

export interface NativeCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  input?: string;
  stdin?: "ignore" | "inherit" | "pipe";
  maxOutputBytes?: number;
}

export async function runNativeCommandWithTimeout(
  argv: readonly string[],
  options: NativeCommandOptions
): Promise<NativeCommandResult> {
  const startedAt = Date.now();
  const maxOutputBytes = Math.max(1, Math.trunc(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES));

  let invocation: ReturnType<typeof resolveWindowsNativeCommandInvocation>;
  try {
    invocation = resolveWindowsNativeCommandInvocation(argv);
  } catch (error) {
    return createFailedResult(startedAt, formatError(error));
  }

  return new Promise((resolve) => {
    const stdin = options.stdin ?? (options.input !== undefined ? "pipe" : "ignore");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: [stdin, "pipe", "pipe"],
        detached: shouldSpawnDetachedProcessGroup(),
        windowsHide: invocation.windowsHide,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        shell: false
      });
    } catch (error) {
      resolve(createFailedResult(startedAt, formatError(error)));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutByteLength = 0;
    let stderrByteLength = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let killedByAbort = false;
    let timer: NodeJS.Timeout | null = null;
    let forceSettleTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (forceSettleTimer) {
        clearTimeout(forceSettleTimer);
      }
      options.abortSignal?.removeEventListener("abort", abort);
    };

    const finish = (
      result: Omit<
        NativeCommandResult,
        "durationMs" | "stdout" | "stderr" | "stdoutTruncated" | "stderrTruncated"
      >
    ) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve({
        ...result,
        stdout: decodeCapturedOutput(stdoutChunks),
        stderr: decodeCapturedOutput(stderrChunks),
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - startedAt
      });
    };

    const terminate = () => {
      if (forceSettleTimer) {
        return;
      }

      terminateProcessTree(child, "SIGTERM");
      forceSettleTimer = setTimeout(() => {
        terminateProcessTree(child, "SIGKILL");
        finish({
          exitCode: null,
          signal: "SIGTERM",
          timedOut,
          error: timedOut ? "timeout" : killedByAbort ? "aborted" : undefined
        });
      }, FORCE_SETTLE_AFTER_KILL_MS);
    };

    const abort = () => {
      if (killedByAbort) {
        return;
      }

      killedByAbort = true;
      terminate();
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const appended = appendOutputChunk(stdoutChunks, stdoutByteLength, chunk, maxOutputBytes);
      stdoutByteLength = appended.byteLength;
      stdoutTruncated = stdoutTruncated || appended.truncated;
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const appended = appendOutputChunk(stderrChunks, stderrByteLength, chunk, maxOutputBytes);
      stderrByteLength = appended.byteLength;
      stderrTruncated = stderrTruncated || appended.truncated;
    });

    child.on("error", (error) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        error: formatError(error)
      });
    });

    child.on("close", (exitCode, signal) => {
      const cleanShimExit =
        invocation.usesWindowsExitCodeShim &&
        exitCode === null &&
        signal === null &&
        !timedOut &&
        !killedByAbort;

      finish({
        exitCode: cleanShimExit ? 0 : exitCode,
        signal,
        timedOut,
        error: timedOut ? "timeout" : killedByAbort ? "aborted" : undefined
      });
    });

    options.abortSignal?.addEventListener("abort", abort, { once: true });
    if (options.abortSignal?.aborted) {
      abort();
      return;
    }

    const timeoutMs = Math.trunc(options.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
    }

    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

function appendOutputChunk(
  chunks: Buffer[],
  currentLength: number,
  chunk: Buffer | string,
  maxOutputBytes: number
): { byteLength: number; truncated: boolean } {
  const buffer = toOutputBuffer(chunk);
  if (currentLength >= maxOutputBytes) {
    return { byteLength: currentLength, truncated: buffer.length > 0 };
  }

  const remaining = maxOutputBytes - currentLength;
  const next = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
  chunks.push(next);
  return {
    byteLength: currentLength + next.length,
    truncated: next.length < buffer.length
  };
}

function createFailedResult(startedAt: number, error: string): NativeCommandResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: Date.now() - startedAt,
    error
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
