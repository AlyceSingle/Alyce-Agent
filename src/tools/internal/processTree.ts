import { spawn, type ChildProcess } from "node:child_process";

export function shouldSpawnDetachedProcessGroup(): boolean {
  return process.platform !== "win32";
}

export function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  if (!child.pid) {
    killChild(child, signal);
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => {
      killChild(child, signal);
    });
    killer.on("exit", (code) => {
      if (code !== 0) {
        killChild(child, signal);
      }
    });
    return;
  }

  try {
    process.kill(-child.pid, signal);
  } catch {
    killChild(child, signal);
  }
}

function killChild(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    child.kill(signal);
  } catch {
    // Process may already have exited.
  }
}
