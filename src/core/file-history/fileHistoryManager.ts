import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_FILE_HISTORY_SNAPSHOTS = 100;

// 记录每轮工具写文件前的原始内容，用于用户中断后把工作区回滚到执行前状态。
export interface TrackedFileSnapshot {
  absolutePath: string;
  existed: boolean;
  originalContent: string;
}

export interface TurnFileHistorySnapshot {
  turnId: string;
  createdAt: string;
  trackedFiles: Map<string, TrackedFileSnapshot>;
}

export interface FileHistoryRestoreResult {
  restored: string[];
  removed: string[];
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
      const originalContent = await fs.readFile(absolutePath, "utf8");
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
          originalContent: ""
        });
        return;
      }

      throw error;
    }
  }

  hasTrackedFiles(turnId: string) {
    return (this.snapshots.get(turnId)?.trackedFiles.size ?? 0) > 0;
  }

  getSnapshot(turnId: string): TurnFileHistorySnapshot | undefined {
    return this.snapshots.get(turnId);
  }

  async restoreTurn(turnId: string): Promise<FileHistoryRestoreResult> {
    const snapshot = this.snapshots.get(turnId);
    if (!snapshot || snapshot.trackedFiles.size === 0) {
      return {
        restored: [],
        removed: []
      };
    }

    const restored: string[] = [];
    const removed: string[] = [];
    // 逆序恢复更接近“撤销”语义，避免目录和文件状态互相覆盖。
    const entries = Array.from(snapshot.trackedFiles.values()).reverse();

    for (const entry of entries) {
      if (entry.existed) {
        await fs.mkdir(path.dirname(entry.absolutePath), { recursive: true });
        await fs.writeFile(entry.absolutePath, entry.originalContent, "utf8");
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

    return {
      restored,
      removed
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
