import {
  applyRestoreAction,
  buildRestorePlan,
  contentSnapshotsEqual,
  readCurrentPathSnapshot,
  type RestoreConflict
} from "../snapshot/snapshotRestore.js";

const MAX_FILE_HISTORY_SNAPSHOTS = 100;

// 记录每轮工具写文件前的原始内容，用于用户中断后把工作区回滚到执行前状态。
export interface TrackedFileSnapshot {
  absolutePath: string;
  existed: boolean;
  originalContent: Buffer;
  originalMode?: number;
  originalKind?: PathSnapshotKind;
  originalEntries?: DirectorySnapshotEntry[];
  afterExisted?: boolean;
  afterContent?: Buffer;
  afterMode?: number;
  afterKind?: PathSnapshotKind;
  afterEntries?: DirectorySnapshotEntry[];
}

export interface TurnFileHistorySnapshot {
  turnId: string;
  createdAt: string;
  finalizedAt?: string;
  restoredAt?: string;
  trackedFiles: Map<string, TrackedFileSnapshot>;
}

export interface FileHistoryRestoreResult {
  restored: string[];
  removed: string[];
  conflicts: RestoreConflict[];
  alreadyRestored: boolean;
  missingSnapshot: boolean;
  restoredAt?: string;
}

export interface FileHistoryRestoreOptions {
  excludePaths?: readonly string[];
}

export type TrackedFileChangeKind = "added" | "modified" | "deleted" | "unchanged";
export type PathSnapshotKind = "missing" | "file" | "directory";

export interface DirectorySnapshotEntry {
  relativePath: string;
  kind: "file" | "directory" | "symlink";
  content: Buffer;
  mode?: number;
}

export interface FileContentSnapshot {
  existed: boolean;
  content: Buffer;
  mode?: number;
  kind?: PathSnapshotKind;
  entries?: DirectorySnapshotEntry[];
}

export interface TurnFileSnapshot {
  absolutePath: string;
  before: FileContentSnapshot;
  after: FileContentSnapshot;
  changeKind: TrackedFileChangeKind;
}

export interface TurnFileChangeSummary {
  absolutePath: string;
  changeKind: TrackedFileChangeKind;
  beforeBytes: number;
  afterBytes: number;
}

export class FileHistoryManager {
  private readonly snapshots = new Map<string, TurnFileHistorySnapshot>();
  private snapshotOrder: string[] = [];

  beginTurn(turnId: string) {
    if (this.snapshots.has(turnId)) {
      return;
    }

    this.snapshots.set(turnId, {
      turnId,
      createdAt: new Date().toISOString(),
      trackedFiles: new Map()
    });
    this.snapshotOrder.push(turnId);
    this.trimSnapshots();
  }

  async captureBeforeWrite(turnId: string, absolutePath: string) {
    const snapshot = this.getOrCreateSnapshot(turnId);
    if (snapshot.trackedFiles.has(absolutePath)) {
      return;
    }

    // 同一轮里每个文件只抓一次写前内容，后续重复写入直接复用首份快照。
    try {
      const original = await readCurrentPathSnapshot(absolutePath);
      snapshot.trackedFiles.set(absolutePath, {
        absolutePath,
        existed: original.existed,
        originalContent: original.content,
        originalMode: original.mode,
        originalKind: original.kind,
        originalEntries: cloneDirectoryEntries(original.entries)
      });
    } catch (error) {
      if (isMissingFileError(error)) {
        snapshot.trackedFiles.set(absolutePath, {
          absolutePath,
          existed: false,
          originalContent: Buffer.alloc(0),
          originalKind: "missing"
        });
        return;
      }

      throw error;
    }
  }

  hasTrackedFiles(turnId: string) {
    return this.getFileSnapshotsForTurn(turnId).some((file) => file.changeKind !== "unchanged");
  }

  canRestoreTurn(turnId: string) {
    const snapshot = this.snapshots.get(turnId);
    return Boolean(
      snapshot &&
      snapshot.trackedFiles.size > 0 &&
      !snapshot.restoredAt &&
      this.getFileSnapshotsForTurn(turnId).some((file) => file.changeKind !== "unchanged")
    );
  }

  isTurnRestored(turnId: string) {
    return Boolean(this.snapshots.get(turnId)?.restoredAt);
  }

  getSnapshot(turnId: string): TurnFileHistorySnapshot | undefined {
    return this.snapshots.get(turnId);
  }

  async finalizeTurn(turnId: string): Promise<TurnFileChangeSummary[]> {
    const snapshot = this.snapshots.get(turnId);
    if (!snapshot || snapshot.trackedFiles.size === 0) {
      return [];
    }

    if (!snapshot.finalizedAt) {
      for (const entry of snapshot.trackedFiles.values()) {
        const after = await readCurrentPathSnapshot(entry.absolutePath);
        entry.afterExisted = after.existed;
        entry.afterContent = after.content;
        entry.afterMode = after.mode;
        entry.afterKind = after.kind;
        entry.afterEntries = cloneDirectoryEntries(after.entries);
      }
      snapshot.finalizedAt = new Date().toISOString();
    }

    return this.getChangedFilesForTurn(turnId);
  }

  getChangedFilesForTurn(turnId: string): TurnFileChangeSummary[] {
    return this.getFileSnapshotsForTurn(turnId)
      .filter((snapshot) => snapshot.changeKind !== "unchanged")
      .map((snapshot) => ({
        absolutePath: snapshot.absolutePath,
        changeKind: snapshot.changeKind,
        beforeBytes: snapshot.before.existed ? snapshot.before.content.byteLength : 0,
        afterBytes: snapshot.after.existed ? snapshot.after.content.byteLength : 0
      }));
  }

  getFileSnapshotsForTurn(turnId: string): TurnFileSnapshot[] {
    const snapshot = this.snapshots.get(turnId);
    if (!snapshot) {
      return [];
    }

    return Array.from(snapshot.trackedFiles.values()).map((entry) => {
      const before = {
        existed: entry.existed,
        content: Buffer.from(entry.originalContent),
        mode: entry.originalMode,
        kind: entry.originalKind,
        entries: cloneDirectoryEntries(entry.originalEntries)
      };
      const after = {
        existed: entry.afterExisted ?? entry.existed,
        content: Buffer.from(entry.afterContent ?? entry.originalContent),
        mode: entry.afterMode ?? entry.originalMode,
        kind: entry.afterKind ?? entry.originalKind,
        entries: cloneDirectoryEntries(entry.afterEntries ?? entry.originalEntries)
      };

      return {
        absolutePath: entry.absolutePath,
        before,
        after,
        changeKind: getChangeKind(before, after)
      };
    });
  }

  getLatestTurnIdWithTrackedFiles(): string | undefined {
    for (let index = this.snapshotOrder.length - 1; index >= 0; index -= 1) {
      const turnId = this.snapshotOrder[index];
      if (turnId && this.hasTrackedFiles(turnId)) {
        return turnId;
      }
    }

    return undefined;
  }

  async restoreTurn(
    turnId: string,
    options: FileHistoryRestoreOptions = {}
  ): Promise<FileHistoryRestoreResult> {
    const snapshot = this.snapshots.get(turnId);
    if (!snapshot || snapshot.trackedFiles.size === 0) {
      return {
        restored: [],
        removed: [],
        conflicts: [],
        alreadyRestored: false,
        missingSnapshot: true
      };
    }

    if (snapshot.restoredAt) {
      return {
        restored: [],
        removed: [],
        conflicts: [],
        alreadyRestored: true,
        missingSnapshot: false,
        restoredAt: snapshot.restoredAt
      };
    }

    await this.finalizeTurn(turnId);

    const restored: string[] = [];
    const removed: string[] = [];
    // 逆序恢复更接近“撤销”语义，避免目录和文件状态互相覆盖。
    const plan = await buildRestorePlan(
      this.getFileSnapshotsForTurn(turnId).reverse(),
      { excludePaths: options.excludePaths }
    );

    for (const action of plan.actions) {
      await applyRestoreAction(action);
      if (action.action === "remove") {
        removed.push(action.absolutePath);
      } else {
        restored.push(action.absolutePath);
      }
    }

    if (plan.conflicts.length === 0) {
      snapshot.restoredAt = new Date().toISOString();
    }

    return {
      restored,
      removed,
      conflicts: plan.conflicts,
      alreadyRestored: false,
      missingSnapshot: false,
      ...(snapshot.restoredAt ? { restoredAt: snapshot.restoredAt } : {})
    };
  }

  removeTurn(turnId: string) {
    if (!this.snapshots.delete(turnId)) {
      return;
    }

    this.snapshotOrder = this.snapshotOrder.filter((value) => value !== turnId);
  }

  clearAll() {
    this.snapshots.clear();
    this.snapshotOrder = [];
  }

  hydrateSnapshots(snapshots: TurnFileHistorySnapshot[]) {
    for (const snapshot of snapshots) {
      const trackedFiles = new Map<string, TrackedFileSnapshot>();
      for (const [absolutePath, entry] of snapshot.trackedFiles.entries()) {
        trackedFiles.set(absolutePath, {
          absolutePath: entry.absolutePath,
          existed: entry.existed,
          originalContent: Buffer.from(entry.originalContent),
          ...(entry.originalMode !== undefined ? { originalMode: entry.originalMode } : {}),
          ...(entry.originalKind ? { originalKind: entry.originalKind } : {}),
          ...(entry.originalEntries ? { originalEntries: cloneDirectoryEntries(entry.originalEntries) } : {}),
          ...(entry.afterExisted !== undefined ? { afterExisted: entry.afterExisted } : {}),
          ...(entry.afterContent !== undefined ? { afterContent: Buffer.from(entry.afterContent) } : {}),
          ...(entry.afterMode !== undefined ? { afterMode: entry.afterMode } : {}),
          ...(entry.afterKind ? { afterKind: entry.afterKind } : {}),
          ...(entry.afterEntries ? { afterEntries: cloneDirectoryEntries(entry.afterEntries) } : {})
        });
      }

      this.snapshots.set(snapshot.turnId, {
        turnId: snapshot.turnId,
        createdAt: snapshot.createdAt,
        ...(snapshot.finalizedAt ? { finalizedAt: snapshot.finalizedAt } : {}),
        ...(snapshot.restoredAt ? { restoredAt: snapshot.restoredAt } : {}),
        trackedFiles
      });
      this.snapshotOrder = this.snapshotOrder.filter((turnId) => turnId !== snapshot.turnId);
      this.snapshotOrder.push(snapshot.turnId);
    }

    this.trimSnapshots();
  }

  private getOrCreateSnapshot(turnId: string) {
    const existing = this.snapshots.get(turnId);
    if (existing) {
      return existing;
    }

    // beginTurn 是正常入口，这里再兜底一次，避免工具层漏调后完全失去回滚快照。
    const created: TurnFileHistorySnapshot = {
      turnId,
      createdAt: new Date().toISOString(),
      trackedFiles: new Map()
    };

    this.snapshots.set(turnId, created);
    this.snapshotOrder.push(turnId);
    this.trimSnapshots();
    return created;
  }

  private trimSnapshots() {
    // 仅保留有限历史，避免长会话把所有旧轮次的文件快照都常驻内存。
    while (this.snapshotOrder.length > MAX_FILE_HISTORY_SNAPSHOTS) {
      const oldest = this.snapshotOrder.shift();
      if (oldest) {
        this.snapshots.delete(oldest);
      }
    }
  }
}

function isMissingFileError(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function getChangeKind(
  before: FileContentSnapshot,
  after: FileContentSnapshot
): TrackedFileChangeKind {
  if (!before.existed && after.existed) {
    return "added";
  }

  if (before.existed && !after.existed) {
    return "deleted";
  }

  if (before.existed && after.existed && !contentSnapshotsEqual(before, after)) {
    return "modified";
  }

  return "unchanged";
}

function cloneDirectoryEntries(
  entries: readonly DirectorySnapshotEntry[] | undefined
): DirectorySnapshotEntry[] | undefined {
  return entries?.map((entry) => ({
    relativePath: entry.relativePath,
    kind: entry.kind,
    content: Buffer.from(entry.content),
    ...(entry.mode !== undefined ? { mode: entry.mode } : {})
  }));
}
