import { promises as fs } from "node:fs";
import path from "node:path";

export interface SnapshotCleanupTarget {
  path: string;
  kind: "git-tree" | "file-history";
  modifiedAt: string;
}

export interface SnapshotCleanupReport {
  retentionDays: number;
  cutoff: string;
  scanned: number;
  stale: SnapshotCleanupTarget[];
  removed: SnapshotCleanupTarget[];
}

export async function cleanupSnapshotStorage(options: {
  alyceDirectory: string;
  retentionDays: number;
  apply?: boolean;
  now?: Date;
  excludePaths?: readonly string[];
}): Promise<SnapshotCleanupReport> {
  const retentionDays = Math.max(1, Math.trunc(options.retentionDays));
  const cutoffTime = (options.now ?? new Date()).getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const cutoff = new Date(cutoffTime).toISOString();
  const excludedPaths = new Set((options.excludePaths ?? []).map(normalizeCleanupPath));
  const roots = [
    {
      kind: "git-tree" as const,
      root: path.join(options.alyceDirectory, "snapshots", "git")
    },
    {
      kind: "file-history" as const,
      root: path.join(options.alyceDirectory, "file-history")
    }
  ];
  const stale: SnapshotCleanupTarget[] = [];
  const removed: SnapshotCleanupTarget[] = [];
  let scanned = 0;

  for (const root of roots) {
    const entries = await readDirectoryEntries(root.root);
    for (const entry of entries) {
      const targetPath = path.join(root.root, entry.name);
      if (!isSafeChildPath(root.root, targetPath) || excludedPaths.has(normalizeCleanupPath(targetPath))) {
        continue;
      }

      const stats = await fs.stat(targetPath).catch(() => undefined);
      if (!stats || !stats.isDirectory()) {
        continue;
      }

      scanned += 1;
      if (stats.mtimeMs > cutoffTime) {
        continue;
      }

      const target = {
        path: targetPath,
        kind: root.kind,
        modifiedAt: stats.mtime.toISOString()
      };
      stale.push(target);
      if (options.apply) {
        await fs.rm(targetPath, { recursive: true, force: true });
        removed.push(target);
      }
    }
  }

  return {
    retentionDays,
    cutoff,
    scanned,
    stale,
    removed
  };
}

async function readDirectoryEntries(root: string) {
  try {
    return await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw error;
  }
}

function isSafeChildPath(root: string, targetPath: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizeCleanupPath(targetPath: string) {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isMissingFileError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
