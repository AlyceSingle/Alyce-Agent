import process from "node:process";
import path from "node:path";
import type { FileHistoryRestoreResult } from "../../../core/file-history/fileHistoryManager.js";
import type { SnapshotRestoreResult } from "../../../core/snapshot/snapshotTypes.js";

export function mergeFileRestoreResults(results: readonly SnapshotRestoreResult[]): FileHistoryRestoreResult {
  const available = results.filter((result) => !result.missingSnapshot);
  if (available.length === 0) {
    return {
      restored: [],
      removed: [],
      conflicts: [],
      alreadyRestored: false,
      missingSnapshot: true
    };
  }

  const restored = uniquePaths(available.flatMap((result) => result.restored));
  const removed = uniquePaths(available.flatMap((result) => result.removed));
  const conflicts = uniqueRestoreConflicts(available.flatMap((result) => result.conflicts));
  const restoredAt = [...available]
    .reverse()
    .find((result) => result.restoredAt)?.restoredAt;
  return {
    restored,
    removed,
    conflicts,
    alreadyRestored: available.every((result) => result.alreadyRestored),
    missingSnapshot: false,
    ...(restoredAt ? { restoredAt } : {})
  };
}

function uniqueRestoreConflicts(
  values: readonly FileHistoryRestoreResult["conflicts"][number][]
) {
  const seen = new Set<string>();
  const unique: FileHistoryRestoreResult["conflicts"] = [];
  for (const value of values) {
    const key = [
      process.platform === "win32"
        ? path.resolve(value.absolutePath).toLowerCase()
        : path.resolve(value.absolutePath),
      value.changeKind,
      value.reason
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(value);
  }

  return unique;
}

function uniquePaths(values: readonly string[]) {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    unique.push(value);
  }

  return unique;
}
