import { runNativeCommandWithTimeout } from "../../../tools/internal/nativeCommandRunner.js";

type ExecFileOptions = {
  abortSignal?: AbortSignal;
  timeout?: number;
  preserveOutputOnError?: boolean;
  useCwd?: boolean;
  env?: NodeJS.ProcessEnv;
  stdin?: "ignore" | "inherit" | "pipe";
  input?: string;
};

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
};

export function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<ExecResult> {
  const {
    abortSignal,
    timeout = 10 * 60 * 1000,
    preserveOutputOnError = true,
    useCwd = true,
    env,
    stdin,
    input
  } = options;

  return runNativeCommandWithTimeout([file, ...args], {
    cwd: useCwd ? process.cwd() : undefined,
    env: env ? { ...process.env, ...env } : process.env,
    timeoutMs: timeout,
    abortSignal,
    stdin,
    input
  }).then((result) => {
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
    if (exitCode === 0) {
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    }

    if (result.timedOut) {
      return { stdout: "", stderr: "", code: 1, error: "timeout" };
    }

    if (preserveOutputOnError) {
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: exitCode,
        error: result.error ?? (result.signal ? `terminated by ${result.signal}` : String(exitCode))
      };
    }

    return { stdout: "", stderr: "", code: exitCode };
  });
}
