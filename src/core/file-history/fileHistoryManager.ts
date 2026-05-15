import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_FILE_HISTORY_SNAPSHOTS = 100;

// 记录每轮工具写文件前的原始内容，用于用户中断后把工作区回滚到执行前状态。
export interface TrackedFileSnapshot {
  absolutePath: string;
  existed: boolean;
  originalContent: Buffer;
  afterExisted?: boolean;
  afterContent?: Buffer;
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
  alreadyRestored: boolean;
  missingSnapshot: boolean;
  restoredAt?: string;
}

export type TrackedFileChangeKind = "added" | "modified" | "deleted" | "unchanged";

export interface FileContentSnapshot {
  existed: boolean;
  content: Buffer;
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
      const originalContent = await fs.readFile(absolutePath);
      snapshot.trackedFiles.set(absolutePath, {
        absolutePath,
        existed: true,
        originalContent
      });
    } catch (error) {
      if (isMissingFileError(error)) {
        snapshot.trackedFiles.set(absolutePath, {
          absolutePath,
          existed: false,
          originalContent: Buffer.alloc(0)
        });
        return;
      }

      throw error;
    }
  }

  hasTrackedFiles(turnId: string) {
    return (this.snapshots.get(turnId)?.trackedFiles.size ?? 0) > 0;
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
        const after = await readFileContentSnapshot(entry.absolutePath);
        entry.afterExisted = after.existed;
        entry.afterContent = after.content;
      }
      snapshot.finalizedAt = new Date().toISOString();
    }

    return this.getChangedFilesForTurn(turnId);
  }

  getChangedFilesForTurn(turnId: string): TurnFileChangeSummary[] {
    return this.getFileSnapshotsForTurn(turnId).map((snapshot) => ({
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
        content: Buffer.from(entry.originalContent)
      };
      const after = {
        existed: entry.afterExisted ?? entry.existed,
        content: Buffer.from(entry.afterContent ?? entry.originalContent)
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

  async restoreTurn(turnId: string): Promise<FileHistoryRestoreResult> {
    const snapshot = this.snapshots.get(turnId);
    if (!snapshot || snapshot.trackedFiles.size === 0) {
      return {
        restored: [],
        removed: [],
        alreadyRestored: false,
        missingSnapshot: true
      };
    }

    if (snapshot.restoredAt) {
      return {
        restored: [],
        removed: [],
        alreadyRestored: true,
        missingSnapshot: false,
        restoredAt: snapshot.restoredAt
      };
    }

    await this.finalizeTurn(turnId);

    const restored: string[] = [];
    const removed: string[] = [];
    // 逆序恢复更接近“撤销”语义，避免目录和文件状态互相覆盖。
    const entries = Array.from(snapshot.trackedFiles.values()).reverse();

    for (const entry of entries) {
      const before = {
        existed: entry.existed,
        content: entry.originalContent
      };
      const after = {
        existed: entry.afterExisted ?? entry.existed,
        content: entry.afterContent ?? entry.originalContent
      };
      if (getChangeKind(before, after) === "unchanged") {
        continue;
      }

      if (entry.existed) {
        await fs.mkdir(path.dirname(entry.absolutePath), { recursive: true });
        await fs.writeFile(entry.absolutePath, entry.originalContent);
        restored.push(entry.absolutePath);
        continue;
      }

      try {
        await fs.unlink(entry.absolutePath);
        removed.push(entry.absolutePath);
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
    }

    snapshot.restoredAt = new Date().toISOString();
    return {
      restored,
      removed,
      alreadyRestored: false,
      missingSnapshot: false,
      restoredAt: snapshot.restoredAt
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

async function readFileContentSnapshot(absolutePath: string): Promise<FileContentSnapshot> {
  try {
    return {
      existed: true,
      content: await fs.readFile(absolutePath)
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        existed: false,
        content: Buffer.alloc(0)
      };
    }

    throw error;
  }
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

  if (before.existed && after.existed && !before.content.equals(after.content)) {
    return "modified";
  }

  return "unchanged";
}
