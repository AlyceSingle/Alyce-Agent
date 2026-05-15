import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  GitTreeSnapshotRef,
  TurnSnapshotFileSnapshot
} from "./snapshotTypes.js";
import {
  applyRestoreAction,
  buildRestorePlan,
  type RestoreConflict
} from "./snapshotRestore.js";

const SNAPSHOT_EXCLUDE_PATHS = [
  ":(exclude).git",
  ":(exclude).git/**",
  ":(exclude).alyce",
  ":(exclude).alyce/**",
  ":(exclude)node_modules",
  ":(exclude)node_modules/**"
];

type GitRunResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
};

export class GitTreeSnapshotStore {
  private initialized = false;

  constructor(
    private readonly options: {
      workspaceRoot: string;
      gitDirectory: string;
    }
  ) {}

  static async isGitAvailable(): Promise<boolean> {
    const result = await runProcess("git", ["--version"], process.cwd());
    return result.exitCode === 0;
  }

  static getWorkspaceSnapshotDirectory(snapshotRoot: string, workspaceRoot: string) {
    const hash = createHash("sha256")
      .update(path.resolve(workspaceRoot).toLowerCase())
      .digest("hex")
      .slice(0, 24);
    return path.join(snapshotRoot, hash);
  }

  async capture(): Promise<GitTreeSnapshotRef> {
    await this.initialize();
    await this.runGit(["read-tree", "--empty"]);
    await this.runGit([
      "add",
      "-A",
      "--",
      ".",
      ...SNAPSHOT_EXCLUDE_PATHS
    ]);
    const tree = (await this.runGitText(["write-tree"])).trim();
    return {
      engine: "git-tree",
      tree,
      createdAt: new Date().toISOString()
    };
  }

  async diffSnapshots(
    beforeRef: GitTreeSnapshotRef,
    afterRef: GitTreeSnapshotRef
  ): Promise<TurnSnapshotFileSnapshot[]> {
    if (beforeRef.tree === afterRef.tree) {
      return [];
    }

    const output = await this.runGitText([
      "diff",
      "--name-status",
      "--no-renames",
      beforeRef.tree,
      afterRef.tree,
      "--"
    ]);
    const changes = parseNameStatus(output);
    const files: TurnSnapshotFileSnapshot[] = [];

    for (const change of changes) {
      const absolutePath = this.resolveWorkspacePath(change.relativePath);
      const before = change.changeKind === "added"
        ? { existed: false, content: Buffer.alloc(0) }
        : { existed: true, content: await this.readTreeFile(beforeRef.tree, change.relativePath) };
      const after = change.changeKind === "deleted"
        ? { existed: false, content: Buffer.alloc(0) }
        : { existed: true, content: await this.readTreeFile(afterRef.tree, change.relativePath) };

      files.push({
        absolutePath,
        relativePath: change.relativePath,
        before,
        after,
        changeKind: change.changeKind
      });
    }

    return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  async restoreFiles(
    files: readonly TurnSnapshotFileSnapshot[]
  ): Promise<{ restored: string[]; removed: string[]; conflicts: RestoreConflict[] }> {
    const restored: string[] = [];
    const removed: string[] = [];

    const plan = await buildRestorePlan([...files].reverse().map((file) => ({
      absolutePath: this.resolveWorkspacePath(file.relativePath),
      before: file.before,
      after: file.after,
      changeKind: file.changeKind
    })));

    for (const action of plan.actions) {
      await applyRestoreAction(action);
      if (action.action === "remove") {
        removed.push(action.absolutePath);
      } else {
        restored.push(action.absolutePath);
      }
    }

    return { restored, removed, conflicts: plan.conflicts };
  }

  private async initialize() {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(this.options.gitDirectory, { recursive: true });
    await runGitPlain(["init", "--bare", this.options.gitDirectory], this.options.workspaceRoot);
    await this.runGit(["config", "core.autocrlf", "false"]);
    await this.runGit(["config", "core.longpaths", "true"]);
    await this.runGit(["config", "core.quotepath", "false"]);
    await this.runGit(["config", "core.fsmonitor", "false"]);
    this.initialized = true;
  }

  private async readTreeFile(tree: string, relativePath: string): Promise<Buffer> {
    return this.runGitBuffer(["show", `${tree}:${relativePath}`]);
  }

  private resolveWorkspacePath(relativePath: string): string {
    const absolutePath = path.resolve(this.options.workspaceRoot, relativePath);
    const root = path.resolve(this.options.workspaceRoot);
    const relative = path.relative(root, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Snapshot path escapes workspace: ${relativePath}`);
    }

    return absolutePath;
  }

  private async runGitText(args: string[]): Promise<string> {
    return (await this.runGitBuffer(args)).toString("utf8");
  }

  private async runGitBuffer(args: string[]): Promise<Buffer> {
    const result = await this.runGit(args);
    return result.stdout;
  }

  private async runGit(args: string[]): Promise<GitRunResult> {
    const result = await runProcess(
      "git",
      [
        "--git-dir",
        this.options.gitDirectory,
        "--work-tree",
        this.options.workspaceRoot,
        ...args
      ],
      this.options.workspaceRoot
    );
    if (result.exitCode !== 0) {
      throw new Error(formatGitFailure(args, result));
    }

    return result;
  }
}

async function runGitPlain(args: string[], cwd: string): Promise<GitRunResult> {
  const result = await runProcess("git", args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(formatGitFailure(args, result));
  }

  return result;
}

function parseNameStatus(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, relativePath] = line.split(/\t/);
      if (!status || !relativePath) {
        throw new Error(`Invalid git diff --name-status line: ${line}`);
      }

      return {
        relativePath: normalizeGitPath(relativePath),
        changeKind: statusToChangeKind(status)
      };
    });
}

function statusToChangeKind(status: string) {
  if (status.startsWith("A")) {
    return "added" as const;
  }

  if (status.startsWith("D")) {
    return "deleted" as const;
  }

  return "modified" as const;
}

function normalizeGitPath(relativePath: string) {
  return relativePath.replace(/\\/g, "/");
}

function formatGitFailure(args: readonly string[], result: GitRunResult) {
  const stderr = result.stderr.toString("utf8").trim();
  const stdout = result.stdout.toString("utf8").trim();
  return [
    `git ${args.join(" ")} failed with exit code ${result.exitCode ?? "unknown"}.`,
    stderr || stdout
  ].filter(Boolean).join("\n");
}

function runProcess(command: string, args: string[], cwd: string): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr)
      });
    });
  });
}
