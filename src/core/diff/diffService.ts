import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  FileHistoryManager,
  TrackedFileChangeKind,
  TurnFileSnapshot
} from "../file-history/fileHistoryManager.js";
import type { TurnSnapshotService } from "../snapshot/turnSnapshotService.js";
import type { TurnSnapshotFileSnapshot } from "../snapshot/snapshotTypes.js";
import { buildUnifiedDiffForFile, type UnifiedDiffStatus } from "./unifiedDiff.js";

const execFileAsync = promisify(execFile);

export interface DiffFileReport {
  path: string;
  absolutePath?: string;
  status: TrackedFileChangeKind;
  additions: number;
  deletions: number;
  beforeBytes: number;
  afterBytes: number;
  binary: boolean;
  truncated: boolean;
  unifiedDiff: string;
}

export interface DiffSummary {
  filesChanged: number;
  added: number;
  modified: number;
  deleted: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
  truncatedFiles: number;
}

export interface TurnDiffReport {
  kind: "turn";
  turnId: string;
  createdAt?: string;
  finalizedAt?: string;
  files: DiffFileReport[];
  summary: DiffSummary;
  unifiedDiff: string;
}

export interface WorkingTreeDiffReport {
  kind: "working-tree";
  workspaceRoot: string;
  available: boolean;
  unifiedDiff: string;
  summary: DiffSummary;
  error?: string;
}

export type DiffReport = TurnDiffReport | WorkingTreeDiffReport;

const POST_EDIT_FILE_SUMMARY_LIMIT = 30;

export class DiffService {
  constructor(
    private readonly options: {
      workspaceRoot: string;
      fileHistoryManager: FileHistoryManager;
      turnSnapshotService?: TurnSnapshotService;
    }
  ) {}

  async getTurnDiff(turnId: string): Promise<TurnDiffReport> {
    await Promise.all([
      this.options.fileHistoryManager.finalizeTurn(turnId),
      this.options.turnSnapshotService?.finalizeTurn(turnId) ?? Promise.resolve([])
    ]);
    const fileHistoryMetadata = this.options.fileHistoryManager.getSnapshot(turnId);
    const snapshotMetadata = this.options.turnSnapshotService?.getSnapshot(turnId);
    const files = mergeSnapshotFiles([
      ...(this.options.turnSnapshotService?.getFileSnapshotsForTurn(turnId) ?? []),
      ...this.options.fileHistoryManager.getFileSnapshotsForTurn(turnId)
    ], this.options.workspaceRoot)
      .sort((left, right) => left.path.localeCompare(right.path));
    const changedFiles = files.filter((file) => file.status !== "unchanged");

    return {
      kind: "turn",
      turnId,
      ...(snapshotMetadata?.createdAt || fileHistoryMetadata?.createdAt
        ? { createdAt: snapshotMetadata?.createdAt ?? fileHistoryMetadata?.createdAt }
        : {}),
      ...(snapshotMetadata?.finalizedAt || fileHistoryMetadata?.finalizedAt
        ? { finalizedAt: snapshotMetadata?.finalizedAt ?? fileHistoryMetadata?.finalizedAt }
        : {}),
      files: changedFiles,
      summary: summarizeFiles(changedFiles),
      unifiedDiff: joinUnifiedDiff(changedFiles.map((file) => file.unifiedDiff))
    };
  }

  async getLastAlyceTurnDiff(): Promise<TurnDiffReport | undefined> {
    const turnId = this.getLatestTurnIdWithTrackedFiles();
    return turnId ? this.getTurnDiff(turnId) : undefined;
  }

  async getWorkingTreeDiff(): Promise<WorkingTreeDiffReport> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--no-ext-diff", "--"],
        {
          cwd: this.options.workspaceRoot,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true
        }
      );
      const unifiedDiff = typeof stdout === "string" ? stdout.trimEnd() : String(stdout).trimEnd();
      return {
        kind: "working-tree",
        workspaceRoot: this.options.workspaceRoot,
        available: true,
        unifiedDiff,
        summary: summarizeGitDiff(unifiedDiff)
      };
    } catch (error) {
      return {
        kind: "working-tree",
        workspaceRoot: this.options.workspaceRoot,
        available: false,
        unifiedDiff: "",
        summary: createEmptySummary(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  formatDiffSummary(report: DiffReport): string {
    return formatDiffSummary(report);
  }

  private getLatestTurnIdWithTrackedFiles(): string | undefined {
    const fileHistoryTurnId = this.options.fileHistoryManager.getLatestTurnIdWithTrackedFiles();
    const snapshotTurnId = this.options.turnSnapshotService?.getLatestTurnIdWithTrackedFiles();
    if (!fileHistoryTurnId) {
      return snapshotTurnId;
    }
    if (!snapshotTurnId) {
      return fileHistoryTurnId;
    }

    const fileHistoryCreatedAt = this.options.fileHistoryManager.getSnapshot(fileHistoryTurnId)?.createdAt ?? "";
    const snapshotCreatedAt = this.options.turnSnapshotService?.getSnapshot(snapshotTurnId)?.createdAt ?? "";
    return snapshotCreatedAt >= fileHistoryCreatedAt ? snapshotTurnId : fileHistoryTurnId;
  }
}

export function formatDiffSummary(report: DiffReport): string {
  if (report.kind === "working-tree" && !report.available) {
    return `Working tree diff unavailable: ${report.error ?? "git diff failed"}`;
  }

  const summary = report.summary;
  if (summary.filesChanged === 0) {
    return report.kind === "turn"
      ? `Turn ${report.turnId}: no tracked file changes.`
      : "Working tree: no git-tracked file changes.";
  }

  const prefix = report.kind === "turn" ? `Turn ${report.turnId}` : "Working tree";
  const flags = [
    summary.binaryFiles > 0 ? `${summary.binaryFiles} binary` : null,
    summary.truncatedFiles > 0 ? `${summary.truncatedFiles} truncated` : null
  ].filter((value): value is string => value !== null);

  return [
    `${prefix}: ${summary.filesChanged} file(s) changed`,
    `${summary.additions} addition(s)`,
    `${summary.deletions} deletion(s)`,
    `${summary.added} added`,
    `${summary.modified} modified`,
    `${summary.deleted} deleted`,
    ...flags
  ].join(", ");
}

export function formatDiffOverview(options: {
  lastTurn?: TurnDiffReport;
  workingTree: WorkingTreeDiffReport;
}): string {
  const lines = ["Diff Overview", ""];

  lines.push("Last Alyce turn:");
  if (options.lastTurn) {
    lines.push(formatDiffSummary(options.lastTurn));
    lines.push(
      options.lastTurn.summary.filesChanged > 0
        ? "Run /diff last for the full turn patch."
        : "No tracked file changes were captured for that turn."
    );
  } else {
    lines.push("No Alyce turn file changes tracked yet.");
  }

  lines.push("");
  lines.push("Current working tree:");
  lines.push(formatDiffSummary(options.workingTree));
  if (options.workingTree.available && options.workingTree.summary.filesChanged > 0) {
    lines.push("Run /diff current for the full working tree patch.");
  }

  return lines.join("\n");
}

export function formatDiffDetails(report: DiffReport): string {
  const lines = [
    report.kind === "turn"
      ? `Alyce Turn Diff: ${report.turnId}`
      : `Working Tree Diff: ${report.workspaceRoot}`,
    "",
    "Summary:",
    formatDiffSummary(report)
  ];

  if (report.kind === "working-tree" && !report.available) {
    return lines.join("\n");
  }

  if (report.kind === "turn") {
    lines.push("");
    lines.push("Files:");
    if (report.files.length === 0) {
      lines.push("(no tracked file changes)");
    } else {
      lines.push(...report.files.map(formatDiffFileLine));
    }
  }

  lines.push("");
  lines.push("Unified diff:");
  lines.push(report.unifiedDiff.trim() ? report.unifiedDiff : "(no diff)");
  return lines.join("\n");
}

export function formatPostEditSummary(report: TurnDiffReport): string {
  if (report.summary.filesChanged === 0) {
    return "";
  }

  const visibleFiles = report.files.slice(0, POST_EDIT_FILE_SUMMARY_LIMIT);
  const hiddenFileCount = Math.max(0, report.files.length - visibleFiles.length);
  const lines = [
    "File changes captured for this turn.",
    formatDiffSummary(report),
    "",
    "Files:",
    ...visibleFiles.map(formatDiffFileLine)
  ];

  if (hiddenFileCount > 0) {
    lines.push(`... ${hiddenFileCount} more file(s).`);
  }

  lines.push("");
  lines.push("Run /diff last for the full patch.");
  return lines.join("\n");
}

function formatDiffFileLine(file: DiffFileReport): string {
  const flags = [
    file.binary ? "binary" : null,
    file.truncated ? "truncated" : null
  ].filter((value): value is string => value !== null);
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";

  return `- ${file.path}: ${file.status}, +${file.additions} -${file.deletions}${suffix}`;
}

function mergeSnapshotFiles(
  snapshots: Array<TurnSnapshotFileSnapshot | TurnFileSnapshot>,
  workspaceRoot: string
): DiffFileReport[] {
  const filesByPath = new Map<string, DiffFileReport>();
  for (const snapshot of snapshots) {
    const relativePath = "relativePath" in snapshot
      ? snapshot.relativePath
      : formatDiffPath(workspaceRoot, snapshot.absolutePath);
    const displayPath = relativePath.replace(/\\/g, "/");
    if (filesByPath.has(displayPath)) {
      continue;
    }

    const diff = buildUnifiedDiffForFile({
      path: displayPath,
      status: snapshot.changeKind as UnifiedDiffStatus,
      before: snapshot.before,
      after: snapshot.after
    });
    filesByPath.set(displayPath, {
      path: displayPath,
      absolutePath: snapshot.absolutePath,
      status: snapshot.changeKind,
      additions: diff.additions,
      deletions: diff.deletions,
      beforeBytes: diff.beforeBytes,
      afterBytes: diff.afterBytes,
      binary: diff.binary,
      truncated: diff.truncated,
      unifiedDiff: diff.text
    });
  }

  return [...filesByPath.values()];
}

function summarizeFiles(files: DiffFileReport[]): DiffSummary {
  return files.reduce((summary, file) => {
    summary.filesChanged += 1;
    summary.additions += file.additions;
    summary.deletions += file.deletions;
    if (file.status === "added") {
      summary.added += 1;
    } else if (file.status === "modified") {
      summary.modified += 1;
    } else if (file.status === "deleted") {
      summary.deleted += 1;
    }
    if (file.binary) {
      summary.binaryFiles += 1;
    }
    if (file.truncated) {
      summary.truncatedFiles += 1;
    }

    return summary;
  }, createEmptySummary());
}

function summarizeGitDiff(unifiedDiff: string): DiffSummary {
  if (!unifiedDiff.trim()) {
    return createEmptySummary();
  }

  const summary = createEmptySummary();
  const files = new Set<string>();
  let currentFile: string | null = null;
  let currentStatus: "added" | "modified" | "deleted" = "modified";

  for (const line of unifiedDiff.split(/\r?\n/)) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      currentFile = fileMatch[2] ?? fileMatch[1] ?? null;
      currentStatus = "modified";
      if (currentFile) {
        files.add(currentFile);
        summary.modified += 1;
      }
      continue;
    }

    if (line.startsWith("new file mode ")) {
      if (currentStatus === "modified") {
        summary.modified = Math.max(0, summary.modified - 1);
      }
      currentStatus = "added";
      summary.added += 1;
      continue;
    }

    if (line.startsWith("deleted file mode ")) {
      if (currentStatus === "modified") {
        summary.modified = Math.max(0, summary.modified - 1);
      }
      currentStatus = "deleted";
      summary.deleted += 1;
      continue;
    }

    if (line.startsWith("Binary files ")) {
      summary.binaryFiles += 1;
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      summary.additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      summary.deletions += 1;
    }
  }

  summary.filesChanged = files.size;
  return summary;
}

function createEmptySummary(): DiffSummary {
  return {
    filesChanged: 0,
    added: 0,
    modified: 0,
    deleted: 0,
    additions: 0,
    deletions: 0,
    binaryFiles: 0,
    truncatedFiles: 0
  };
}

function joinUnifiedDiff(chunks: string[]): string {
  return chunks.filter((chunk) => chunk.trim().length > 0).join("\n\n");
}

function formatDiffPath(workspaceRoot: string, absolutePath: string): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  const displayPath =
    relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? relative
      : absolutePath;

  return displayPath.replace(/\\/g, "/");
}
