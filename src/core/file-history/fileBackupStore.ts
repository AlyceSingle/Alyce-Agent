import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DirectorySnapshotEntry,
  FileContentSnapshot,
  PathSnapshotKind,
  TrackedFileSnapshot,
  TurnFileHistorySnapshot
} from "./fileHistoryManager.js";

export interface PersistedDirectorySnapshotEntry {
  relativePath: string;
  kind: "file" | "directory" | "symlink";
  backupPath?: string;
  mode?: number;
}

export interface PersistedFileHistoryFile {
  absolutePath: string;
  existed: boolean;
  kind?: PathSnapshotKind;
  originalBackupPath?: string;
  originalMode?: number;
  originalEntries?: PersistedDirectorySnapshotEntry[];
  afterExisted?: boolean;
  afterKind?: PathSnapshotKind;
  afterBackupPath?: string;
  afterMode?: number;
  afterEntries?: PersistedDirectorySnapshotEntry[];
}

export interface PersistedFileHistorySnapshot {
  version: 1 | 2;
  sessionId: string;
  turnId: string;
  createdAt: string;
  finalizedAt?: string;
  restoredAt?: string;
  files: PersistedFileHistoryFile[];
}

export class FileBackupStore {
  constructor(
    private readonly options: {
      rootDirectory: string;
      sessionId: string;
    }
  ) {}

  async writeSnapshot(snapshot: TurnFileHistorySnapshot): Promise<PersistedFileHistorySnapshot> {
    const turnDirectory = this.getTurnDirectory(snapshot.turnId);
    const filesDirectory = path.join(turnDirectory, "files");
    await fs.mkdir(filesDirectory, { recursive: true });

    const files: PersistedFileHistoryFile[] = [];
    for (const entry of snapshot.trackedFiles.values()) {
      files.push(await this.writeFileEntry(snapshot.turnId, entry));
    }

    const persisted: PersistedFileHistorySnapshot = {
      version: 2,
      sessionId: this.options.sessionId,
      turnId: snapshot.turnId,
      createdAt: snapshot.createdAt,
      ...(snapshot.finalizedAt ? { finalizedAt: snapshot.finalizedAt } : {}),
      ...(snapshot.restoredAt ? { restoredAt: snapshot.restoredAt } : {}),
      files
    };
    await fs.writeFile(
      this.getTurnIndexPath(snapshot.turnId),
      JSON.stringify(persisted, null, 2),
      "utf8"
    );
    return persisted;
  }

  async loadSessionSnapshots(
    sessionHistorySnapshots: readonly PersistedFileHistorySnapshot[] = []
  ): Promise<TurnFileHistorySnapshot[]> {
    const snapshots = new Map<string, PersistedFileHistorySnapshot>();
    for (const snapshot of await this.loadIndexSnapshots()) {
      snapshots.set(snapshot.turnId, snapshot);
    }
    for (const snapshot of sessionHistorySnapshots) {
      snapshots.set(snapshot.turnId, snapshot);
    }

    const hydrated: TurnFileHistorySnapshot[] = [];
    for (const snapshot of snapshots.values()) {
      try {
        hydrated.push(await this.hydrateSnapshot(snapshot));
      } catch {
        // Missing or pruned backup objects should not block session resume.
      }
    }

    return hydrated.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async hydrateSnapshot(snapshot: PersistedFileHistorySnapshot): Promise<TurnFileHistorySnapshot> {
    const trackedFiles = new Map<string, TrackedFileSnapshot>();
    for (const file of snapshot.files) {
      const before = await this.hydrateContentSnapshot({
        existed: file.existed,
        kind: file.kind,
        backupPath: file.originalBackupPath,
        mode: file.originalMode,
        entries: file.originalEntries
      });
      const after = file.afterExisted === undefined
        ? undefined
        : await this.hydrateContentSnapshot({
            existed: file.afterExisted,
            kind: file.afterKind,
            backupPath: file.afterBackupPath,
            mode: file.afterMode,
            entries: file.afterEntries
          });

      trackedFiles.set(file.absolutePath, {
        absolutePath: file.absolutePath,
        existed: before.existed,
        originalContent: before.content,
        ...(before.mode !== undefined ? { originalMode: before.mode } : {}),
        ...(before.kind ? { originalKind: before.kind } : {}),
        ...(before.entries ? { originalEntries: before.entries } : {}),
        ...(after ? { afterExisted: after.existed } : {}),
        ...(after ? { afterContent: after.content } : {}),
        ...(after?.mode !== undefined ? { afterMode: after.mode } : {}),
        ...(after?.kind ? { afterKind: after.kind } : {}),
        ...(after?.entries ? { afterEntries: after.entries } : {})
      });
    }

    return {
      turnId: snapshot.turnId,
      createdAt: snapshot.createdAt,
      ...(snapshot.finalizedAt ? { finalizedAt: snapshot.finalizedAt } : {}),
      ...(snapshot.restoredAt ? { restoredAt: snapshot.restoredAt } : {}),
      trackedFiles
    };
  }

  private async writeFileEntry(
    turnId: string,
    entry: TrackedFileSnapshot
  ): Promise<PersistedFileHistoryFile> {
    const before = buildOriginalSnapshot(entry);
    const after = entry.afterExisted === undefined ? undefined : buildAfterSnapshot(entry);
    const originalBackupPath = await this.writeSnapshotContent(
      turnId,
      entry.absolutePath,
      "before",
      before
    );
    const afterBackupPath = after
      ? await this.writeSnapshotContent(turnId, entry.absolutePath, "after", after)
      : undefined;

    return {
      absolutePath: entry.absolutePath,
      existed: entry.existed,
      ...(before.kind ? { kind: before.kind } : {}),
      ...(originalBackupPath ? { originalBackupPath } : {}),
      ...(before.mode !== undefined ? { originalMode: before.mode } : {}),
      ...(before.entries
        ? { originalEntries: await this.writeDirectoryEntries(turnId, entry.absolutePath, "before", before.entries) }
        : {}),
      ...(entry.afterExisted !== undefined ? { afterExisted: entry.afterExisted } : {}),
      ...(after?.kind ? { afterKind: after.kind } : {}),
      ...(afterBackupPath ? { afterBackupPath } : {}),
      ...(after?.mode !== undefined ? { afterMode: after.mode } : {}),
      ...(after?.entries
        ? { afterEntries: await this.writeDirectoryEntries(turnId, entry.absolutePath, "after", after.entries) }
        : {})
    };
  }

  private async writeSnapshotContent(
    turnId: string,
    absolutePath: string,
    label: "before" | "after",
    snapshot: FileContentSnapshot
  ): Promise<string | undefined> {
    if (!snapshot.existed) {
      return undefined;
    }

    return this.writeBackupFile(turnId, absolutePath, label, snapshot.content);
  }

  private async writeDirectoryEntries(
    turnId: string,
    absolutePath: string,
    label: "before" | "after",
    entries: readonly DirectorySnapshotEntry[]
  ): Promise<PersistedDirectorySnapshotEntry[]> {
    const persisted: PersistedDirectorySnapshotEntry[] = [];
    for (const entry of entries) {
      const backupPath = entry.kind !== "directory"
        ? await this.writeBackupFile(
            turnId,
            path.join(absolutePath, entry.relativePath),
            `${label}-entry`,
            entry.content
          )
        : undefined;
      persisted.push({
        relativePath: entry.relativePath,
        kind: entry.kind,
        ...(backupPath ? { backupPath } : {}),
        ...(entry.mode !== undefined ? { mode: entry.mode } : {})
      });
    }

    return persisted;
  }

  private async hydrateContentSnapshot(options: {
    existed: boolean;
    kind?: PathSnapshotKind;
    backupPath?: string;
    mode?: number;
    entries?: readonly PersistedDirectorySnapshotEntry[];
  }): Promise<FileContentSnapshot> {
    const kind = inferPersistedKind(options.existed, options.kind);
    if (kind === "missing") {
      return {
        existed: false,
        kind,
        content: Buffer.alloc(0)
      };
    }

    return {
      existed: true,
      kind,
      content: options.backupPath
        ? await fs.readFile(this.resolveBackupPath(options.backupPath))
        : Buffer.alloc(0),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(options.entries
        ? { entries: await this.hydrateDirectoryEntries(options.entries) }
        : {})
    };
  }

  private async hydrateDirectoryEntries(
    entries: readonly PersistedDirectorySnapshotEntry[]
  ): Promise<DirectorySnapshotEntry[]> {
    const hydrated: DirectorySnapshotEntry[] = [];
    for (const entry of entries) {
      hydrated.push({
        relativePath: entry.relativePath,
        kind: entry.kind,
        content: entry.backupPath
          ? await fs.readFile(this.resolveBackupPath(entry.backupPath))
          : Buffer.alloc(0),
        ...(entry.mode !== undefined ? { mode: entry.mode } : {})
      });
    }

    return hydrated;
  }

  private async writeBackupFile(
    turnId: string,
    absolutePath: string,
    label: string,
    content: Buffer
  ): Promise<string> {
    const relativePath = path.join(
      this.options.sessionId,
      turnId,
      "files",
      `${hashBackupObject(absolutePath, label)}-${label}.bin`
    );
    const backupPath = this.resolveBackupPath(relativePath);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, content);
    return normalizePath(relativePath);
  }

  private async loadIndexSnapshots(): Promise<PersistedFileHistorySnapshot[]> {
    const sessionDirectory = this.getSessionDirectory();
    let entries: string[];
    try {
      entries = await fs.readdir(sessionDirectory);
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }

      throw error;
    }

    const snapshots: PersistedFileHistorySnapshot[] = [];
    for (const entry of entries) {
      const indexPath = path.join(sessionDirectory, entry, "snapshot.json");
      try {
        const parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as unknown;
        if (isPersistedFileHistorySnapshot(parsed, this.options.sessionId)) {
          snapshots.push(parsed);
        }
      } catch {
        // Ignore corrupt snapshot indexes.
      }
    }

    return snapshots;
  }

  private getSessionDirectory() {
    return path.join(this.options.rootDirectory, this.options.sessionId);
  }

  private getTurnDirectory(turnId: string) {
    return path.join(this.getSessionDirectory(), turnId);
  }

  private getTurnIndexPath(turnId: string) {
    return path.join(this.getTurnDirectory(turnId), "snapshot.json");
  }

  private resolveBackupPath(relativePath: string) {
    const absolutePath = path.resolve(this.options.rootDirectory, relativePath);
    const root = path.resolve(this.options.rootDirectory);
    const relative = path.relative(root, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`File history backup path escapes root: ${relativePath}`);
    }

    return absolutePath;
  }
}

export function isPersistedFileHistorySnapshot(
  value: unknown,
  sessionId?: string
): value is PersistedFileHistorySnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<PersistedFileHistorySnapshot>;
  return (record.version === 1 || record.version === 2) &&
    typeof record.sessionId === "string" &&
    (!sessionId || record.sessionId === sessionId) &&
    typeof record.turnId === "string" &&
    typeof record.createdAt === "string" &&
    Array.isArray(record.files);
}

function buildOriginalSnapshot(entry: TrackedFileSnapshot): FileContentSnapshot {
  const kind = entry.originalKind ?? (entry.existed ? "file" : "missing");
  return {
    existed: entry.existed,
    content: entry.originalContent,
    ...(entry.originalMode !== undefined ? { mode: entry.originalMode } : {}),
    kind,
    ...(kind === "directory" && entry.originalEntries ? { entries: entry.originalEntries } : {})
  };
}

function buildAfterSnapshot(entry: TrackedFileSnapshot): FileContentSnapshot {
  const existed = entry.afterExisted ?? entry.existed;
  const kind = entry.afterKind ?? entry.originalKind ?? (existed ? "file" : "missing");
  return {
    existed,
    content: entry.afterContent ?? entry.originalContent,
    ...(entry.afterMode !== undefined
      ? { mode: entry.afterMode }
      : entry.originalMode !== undefined
        ? { mode: entry.originalMode }
        : {}),
    kind,
    ...(kind === "directory" && entry.afterEntries
      ? { entries: entry.afterEntries }
      : kind === "directory" && entry.originalEntries
        ? { entries: entry.originalEntries }
        : {})
  };
}

function inferPersistedKind(existed: boolean, kind: PathSnapshotKind | undefined): PathSnapshotKind {
  if (!existed) {
    return "missing";
  }

  return kind ?? "file";
}

function hashBackupObject(absolutePath: string, label: string) {
  const resolvedPath = path.resolve(absolutePath);
  const pathKey = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  return createHash("sha256")
    .update(pathKey)
    .update("\0")
    .update(label)
    .digest("hex")
    .slice(0, 32);
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/");
}

function isMissingFileError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
