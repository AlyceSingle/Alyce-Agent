import { spawn } from "node:child_process";

function getShellInvocation(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      executable: "pwsh",
      args: ["-NoLogo", "-NoProfile", "-Command", command]
    };
  }

  return {
    executable: "bash",
    args: ["-lc", command]
  };
}

export async function runShellCommand(command: string, cwd: string, timeoutMs: number) {
  const shell = getShellInvocation(command);

  return new Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(shell.executable, shell.args, {
        cwd,
        env: process.env
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });

      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve({ exitCode, timedOut, stdout, stderr });
      });
    }
  );
}
