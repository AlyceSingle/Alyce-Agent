import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DirectorySnapshotEntry,
  FileContentSnapshot,
  TrackedFileChangeKind
} from "../file-history/fileHistoryManager.js";

export type RestoreConflictReason =
  | "current-content-changed"
  | "current-file-missing"
  | "current-file-recreated";

export interface RestoreConflict {
  absolutePath: string;
  changeKind: TrackedFileChangeKind;
  reason: RestoreConflictReason;
}

export interface RestorePlanFile {
  absolutePath: string;
  before: FileContentSnapshot;
  after: FileContentSnapshot;
  changeKind: TrackedFileChangeKind;
}

export interface RestoreFileAction extends RestorePlanFile {
  action: "restore" | "remove";
}

export interface RestorePlan {
  actions: RestoreFileAction[];
  conflicts: RestoreConflict[];
}

export async function buildRestorePlan(
  files: readonly RestorePlanFile[],
  options: { excludePaths?: readonly string[] } = {}
): Promise<RestorePlan> {
  const excluded = new Set((options.excludePaths ?? []).map(normalizeRestorePath));
  const actions: RestoreFileAction[] = [];
  const conflicts: RestoreConflict[] = [];

  for (const file of files) {
    if (file.changeKind === "unchanged" || excluded.has(normalizeRestorePath(file.absolutePath))) {
      continue;
    }

    const current = await readCurrentPathSnapshot(file.absolutePath);
    if (contentSnapshotsEqual(current, file.after)) {
      actions.push({
        ...file,
        action: file.before.existed ? "restore" : "remove"
      });
      continue;
    }

    if (contentSnapshotsEqual(current, file.before)) {
      continue;
    }

    conflicts.push({
      absolutePath: file.absolutePath,
      changeKind: file.changeKind,
      reason: getRestoreConflictReason(file, current)
    });
  }

  return { actions, conflicts };
}

export async function applyRestoreAction(action: RestoreFileAction): Promise<void> {
  if (action.action === "remove") {
    await removePath(action.absolutePath, getSnapshotKind(action.after));
    return;
  }

  await restoreSnapshot(action.absolutePath, action.before);
}

export async function readCurrentPathSnapshot(absolutePath: string): Promise<FileContentSnapshot> {
  try {
    const stats = await fs.lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      return readResolvedSymlinkSnapshot(absolutePath);
    }

    if (stats.isDirectory()) {
      return readDirectorySnapshot(absolutePath, stats.mode);
    }

    if (!stats.isFile()) {
      return createMissingSnapshot();
    }

    return {
      existed: true,
      kind: "file",
      content: await fs.readFile(absolutePath),
      mode: stats.mode
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return createMissingSnapshot();
    }

    throw error;
  }
}

export function contentSnapshotsEqual(left: FileContentSnapshot, right: FileContentSnapshot) {
  const leftKind = getSnapshotKind(left);
  const rightKind = getSnapshotKind(right);
  if (leftKind !== rightKind) {
    return false;
  }

  if (leftKind === "missing") {
    return true;
  }

  if (!left.content.equals(right.content)) {
    return false;
  }

  if (leftKind !== "directory") {
    return true;
  }

  return directoryEntriesEqual(left.entries ?? [], right.entries ?? []);
}

async function restoreSnapshot(absolutePath: string, snapshot: FileContentSnapshot) {
  const kind = getSnapshotKind(snapshot);
  if (kind === "missing") {
    await removePath(absolutePath, kind);
    return;
  }

  if (kind === "file") {
    await removeDirectoryIfPresent(absolutePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, snapshot.content);
    if (snapshot.mode !== undefined) {
      await fs.chmod(absolutePath, snapshot.mode);
    }
    return;
  }

  await removePath(absolutePath, kind);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.mkdir(absolutePath, { recursive: true });
  if (snapshot.mode !== undefined) {
    await fs.chmod(absolutePath, snapshot.mode);
  }

  const entries = [...(snapshot.entries ?? [])].sort(compareDirectoryRestoreEntries);
  for (const entry of entries) {
    const entryPath = resolveDirectoryEntryPath(absolutePath, entry.relativePath);
    if (entry.kind === "directory") {
      await fs.mkdir(entryPath, { recursive: true });
      if (entry.mode !== undefined) {
        await fs.chmod(entryPath, entry.mode);
      }
      continue;
    }

    await fs.mkdir(path.dirname(entryPath), { recursive: true });
    if (entry.kind === "symlink") {
      await fs.symlink(entry.content.toString("utf8"), entryPath);
      continue;
    }

    await fs.writeFile(entryPath, entry.content);
    if (entry.mode !== undefined) {
      await fs.chmod(entryPath, entry.mode);
    }
  }
}

export async function cleanupCreatedDirectories(
  directories: readonly string[]
): Promise<string[]> {
  const removed: string[] = [];
  const seen = new Set<string>();

  for (const directory of directories) {
    const normalized = normalizeRestorePath(directory);
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    try {
      await fs.rmdir(directory);
      removed.push(directory);
    } catch (error) {
      if (
        isMissingFileError(error) ||
        isDirectoryNotEmptyError(error) ||
        isAccessDeniedError(error)
      ) {
        continue;
      }

      throw error;
    }
  }

  return removed;
}

function getRestoreConflictReason(
  file: RestorePlanFile,
  current: FileContentSnapshot
): RestoreConflictReason {
  if (file.after.existed && !current.existed) {
    return "current-file-missing";
  }

  if (!file.after.existed && current.existed) {
    return "current-file-recreated";
  }

  return "current-content-changed";
}

function normalizeRestorePath(absolutePath: string) {
  const resolved = path.resolve(absolutePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function readDirectorySnapshot(
  absolutePath: string,
  mode: number | undefined
): Promise<FileContentSnapshot> {
  const entries: DirectorySnapshotEntry[] = [];
  await walkDirectorySnapshot(absolutePath, "", entries);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return {
    existed: true,
    kind: "directory",
    content: Buffer.from(formatDirectoryManifest(entries), "utf8"),
    mode,
    entries
  };
}

async function readResolvedSymlinkSnapshot(absolutePath: string): Promise<FileContentSnapshot> {
  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      return readDirectorySnapshot(absolutePath, stats.mode);
    }

    if (!stats.isFile()) {
      return createMissingSnapshot();
    }

    return {
      existed: true,
      kind: "file",
      content: await fs.readFile(absolutePath),
      mode: stats.mode
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return createMissingSnapshot();
    }

    throw error;
  }
}

async function walkDirectorySnapshot(
  rootDirectory: string,
  relativeDirectory: string,
  entries: DirectorySnapshotEntry[]
) {
  const absoluteDirectory = path.join(rootDirectory, relativeDirectory);
  const children = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  for (const child of children) {
    const relativePath = normalizeDirectoryEntryPath(path.join(relativeDirectory, child.name));
    const absolutePath = path.join(rootDirectory, relativePath);
    const stats = await fs.lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      entries.push({
        relativePath,
        kind: "symlink",
        content: Buffer.from(await fs.readlink(absolutePath), "utf8"),
        mode: stats.mode
      });
      continue;
    }

    if (stats.isDirectory()) {
      entries.push({
        relativePath,
        kind: "directory",
        content: Buffer.alloc(0),
        mode: stats.mode
      });
      await walkDirectorySnapshot(rootDirectory, relativePath, entries);
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    entries.push({
      relativePath,
      kind: "file",
      content: await fs.readFile(absolutePath),
      mode: stats.mode
    });
  }
}

function formatDirectoryManifest(entries: readonly DirectorySnapshotEntry[]) {
  const manifest = entries.map((entry) => ({
    path: entry.relativePath,
    kind: entry.kind,
    mode: entry.mode,
    size: entry.kind === "directory" ? 0 : entry.content.byteLength,
    sha256: entry.kind === "directory" ? undefined : hashContent(entry.content)
  }));
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function hashContent(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function getSnapshotKind(snapshot: FileContentSnapshot) {
  if (!snapshot.existed) {
    return "missing";
  }

  return snapshot.kind ?? "file";
}

function createMissingSnapshot(): FileContentSnapshot {
  return {
    existed: false,
    kind: "missing",
    content: Buffer.alloc(0)
  };
}

function directoryEntriesEqual(
  left: readonly DirectorySnapshotEntry[],
  right: readonly DirectorySnapshotEntry[]
) {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftEntry = left[index];
    const rightEntry = right[index];
    if (
      !leftEntry ||
      !rightEntry ||
      leftEntry.relativePath !== rightEntry.relativePath ||
      leftEntry.kind !== rightEntry.kind ||
      !leftEntry.content.equals(rightEntry.content)
    ) {
      return false;
    }
  }

  return true;
}

function compareDirectoryRestoreEntries(
  left: DirectorySnapshotEntry,
  right: DirectorySnapshotEntry
) {
  const depthDiff = getRelativePathDepth(left.relativePath) - getRelativePathDepth(right.relativePath);
  if (depthDiff !== 0) {
    return depthDiff;
  }

  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }

  return left.relativePath.localeCompare(right.relativePath);
}

function getRelativePathDepth(relativePath: string) {
  return normalizeDirectoryEntryPath(relativePath).split("/").filter(Boolean).length;
}

function resolveDirectoryEntryPath(rootDirectory: string, relativePath: string) {
  const absolutePath = path.resolve(rootDirectory, relativePath);
  const relative = path.relative(path.resolve(rootDirectory), absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Directory snapshot entry escapes root: ${relativePath}`);
  }

  return absolutePath;
}

function normalizeDirectoryEntryPath(value: string) {
  return value.replace(/\\/g, "/");
}

async function removePath(absolutePath: string, kind: ReturnType<typeof getSnapshotKind>) {
  try {
    if (kind === "directory") {
      await fs.rm(absolutePath, { recursive: true, force: true });
      return;
    }

    await fs.unlink(absolutePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    if (isDirectoryError(error)) {
      await fs.rm(absolutePath, { recursive: true, force: true });
      return;
    }

    throw error;
  }
}

async function removeDirectoryIfPresent(absolutePath: string) {
  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      await fs.rm(absolutePath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
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

function isDirectoryNotEmptyError(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    ["ENOTEMPTY", "EEXIST"].includes((error as { code?: string }).code ?? "")
  );
}

function isDirectoryError(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    ["EISDIR", "EPERM"].includes((error as { code?: string }).code ?? "")
  );
}

function isAccessDeniedError(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    ["EACCES", "EPERM"].includes((error as { code?: string }).code ?? "")
  );
}
