import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import type { DirectoryReadResult } from "./results.js";

export async function listDirectoryEntries(absolutePath: string): Promise<string[]> {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const normalizedEntries = await Promise.all(
    entries.map((entry) => normalizeDirectoryEntry(absolutePath, entry))
  );

  return normalizedEntries
    .sort((left, right) => {
      if (left.rank !== right.rank) {
        return left.rank - right.rank;
      }

      return left.label.localeCompare(right.label, undefined, {
        numeric: true,
        sensitivity: "base"
      });
    })
    .map((entry) => entry.label);
}

async function normalizeDirectoryEntry(absolutePath: string, entry: Dirent) {
  if (entry.isDirectory()) {
    return {
      label: `${entry.name}/`,
      rank: 0
    };
  }

  if (entry.isSymbolicLink()) {
    try {
      const stats = await fs.stat(path.join(absolutePath, entry.name));
      if (stats.isDirectory()) {
        return {
          label: `${entry.name}/`,
          rank: 0
        };
      }
    } catch {
      return {
        label: `${entry.name}@`,
        rank: 2
      };
    }
  }

  return {
    label: entry.name,
    rank: 1
  };
}

export function createDirectoryResult(
  directoryPath: string,
  entries: string[],
  startEntry: number,
  limit: number
): DirectoryReadResult {
  const startIndex = startEntry - 1;
  const selectedEntries = entries.slice(startIndex, startIndex + limit);
  const truncated = startIndex + selectedEntries.length < entries.length;

  return {
    type: "directory",
    directory: {
      directoryPath,
      entries: selectedEntries,
      startEntry,
      numEntries: selectedEntries.length,
      totalEntries: entries.length,
      truncated,
      nextOffset: truncated ? startEntry + selectedEntries.length : undefined,
      notice: buildDirectoryNotice(entries.length, startEntry, selectedEntries.length)
    }
  };
}

function buildDirectoryNotice(totalEntries: number, startEntry: number, numEntries: number) {
  if (totalEntries === 0) {
    return "Directory is empty.";
  }

  if (numEntries === 0) {
    return `offset ${startEntry} is beyond directory length (${totalEntries} entries).`;
  }

  return undefined;
}
