import { spawn } from "child_process";

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
  return new Promise((resolve) => {
    const {
      abortSignal,
      timeout = 10 * 60 * 1000,
      preserveOutputOnError = true,
      useCwd = true,
      env,
      stdin,
      input
    } = options;

    const stdioStdin = stdin ?? (input !== undefined ? "pipe" : "ignore");

    const child = spawn(file, args, {
      cwd: useCwd ? process.cwd() : undefined,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: [stdioStdin, "pipe", "pipe"],
      signal: abortSignal,
      shell: false
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finalize = (result: ExecResult) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const timer =
      timeout > 0
        ? setTimeout(() => {
            try {
              child.kill("SIGTERM");
            } catch {
              // Ignore kill failures.
            }
            finalize({ stdout: "", stderr: "", code: 1, error: "timeout" });
          }, timeout)
        : null;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }

    child.on("error", (error) => {
      finalize({ stdout: "", stderr: "", code: 1, error: error.message });
    });

    child.on("close", (code, signal) => {
      const exitCode = typeof code === "number" ? code : 1;
      if (exitCode === 0) {
        finalize({ stdout, stderr, code: 0 });
        return;
      }

      if (preserveOutputOnError) {
        finalize({
          stdout,
          stderr,
          code: exitCode,
          error: signal ? `terminated by ${signal}` : String(exitCode)
        });
        return;
      }

      finalize({ stdout: "", stderr: "", code: exitCode });
    });
  });
}
