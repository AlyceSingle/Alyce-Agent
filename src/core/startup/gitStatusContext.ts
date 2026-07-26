import { spawn } from "node:child_process";

export interface GitStatusPromptContext {
  branch: string;
  statusShort: string;
  recentCommits: string;
  truncatedStatusLines: number;
}

const GIT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_STATUS_LINES = 40;
const RECENT_COMMIT_COUNT = 5;

// 采集 git 快照用于注入 system prompt。任何失败（非 git 仓库、git 缺失、超时）都返回
// undefined，绝不阻塞启动。
export async function collectGitStatusContext(
  workspaceRoot: string
): Promise<GitStatusPromptContext | undefined> {
  try {
    const insideWorkTree = await runGit(["rev-parse", "--is-inside-work-tree"], workspaceRoot);
    if (insideWorkTree?.trim() !== "true") {
      return undefined;
    }

    const [branch, status, log] = await Promise.all([
      runGit(["branch", "--show-current"], workspaceRoot),
      runGit(["status", "--short"], workspaceRoot),
      runGit(["log", "--oneline", `-${RECENT_COMMIT_COUNT}`], workspaceRoot)
    ]);

    const statusLines = (status ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0);
    const truncatedStatusLines = Math.max(0, statusLines.length - MAX_STATUS_LINES);
    return {
      branch: branch?.trim() || "(detached HEAD)",
      statusShort: statusLines.slice(0, MAX_STATUS_LINES).join("\n"),
      recentCommits: (log ?? "").trim(),
      truncatedStatusLines
    };
  } catch {
    return undefined;
  }
}

function runGit(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, { cwd, windowsHide: true });
    } catch {
      finish(undefined);
      return;
    }

    const stdout: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, GIT_COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(undefined);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      finish(exitCode === 0 ? Buffer.concat(stdout).toString("utf8") : undefined);
    });
  });
}
