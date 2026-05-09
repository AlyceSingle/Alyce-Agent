import { promises as fs } from "node:fs";
import path from "node:path";
import { SubagentTaskStorage } from "./storagePaths.js";

export interface SubagentStorageCleanupOptions {
  storage: SubagentTaskStorage;
  apply: boolean;
}

export interface SubagentStorageCleanupReport {
  mode: "dry-run" | "apply";
  scannedSessionCount: number;
  orphanOutputFilesFound: number;
  orphanOutputFilesRemoved: number;
  emptyTranscriptsWithoutMetadataFound: number;
  emptyTranscriptsWithoutMetadataRemoved: number;
  migratedLegacyArchiveFound: boolean;
  migratedLegacyArchiveRemoved: boolean;
  migratedLegacyFallbackFilesFound: number;
  migratedLegacyFallbackFilesRemoved: number;
}

interface LegacyMigrationMarkerRecord {
  unresolvedTaskCount?: number;
  skippedTaskCount?: number;
  failedTaskCount?: number;
}

export async function cleanupSubagentStorageArtifacts(
  options: SubagentStorageCleanupOptions
): Promise<SubagentStorageCleanupReport> {
  const report: SubagentStorageCleanupReport = {
    mode: options.apply ? "apply" : "dry-run",
    scannedSessionCount: 0,
    orphanOutputFilesFound: 0,
    orphanOutputFilesRemoved: 0,
    emptyTranscriptsWithoutMetadataFound: 0,
    emptyTranscriptsWithoutMetadataRemoved: 0,
    migratedLegacyArchiveFound: false,
    migratedLegacyArchiveRemoved: false,
    migratedLegacyFallbackFilesFound: 0,
    migratedLegacyFallbackFilesRemoved: 0
  };

  const sessionsDirectory = options.storage.getSessionsDirectory();
  const sessionIds = await listSubdirectories(sessionsDirectory);
  report.scannedSessionCount = sessionIds.length;

  const metadataTaskIds = new Set<string>();
  for (const sessionId of sessionIds) {
    const subagentsDirectory = options.storage.getSubagentsDirectory(sessionId);
    const files = await listFiles(subagentsDirectory);
    for (const fileName of files) {
      if (fileName.endsWith(".meta.json")) {
        metadataTaskIds.add(fileName.slice(0, -".meta.json".length));
      }
    }
  }

  for (const sessionId of sessionIds) {
    await cleanupSessionArtifacts(sessionId, options, report);
  }

  await cleanupLegacyArtifacts(options, report, metadataTaskIds);
  return report;
}

async function cleanupSessionArtifacts(
  sessionId: string,
  options: SubagentStorageCleanupOptions,
  report: SubagentStorageCleanupReport
): Promise<void> {
  const subagentsDirectory = options.storage.getSubagentsDirectory(sessionId);
  const taskOutputsDirectory = options.storage.getTaskOutputsDirectory(sessionId);

  const subagentFiles = await listFiles(subagentsDirectory);
  for (const fileName of subagentFiles) {
    if (!fileName.endsWith(".jsonl")) {
      continue;
    }

    const taskId = fileName.slice(0, -".jsonl".length);
    const transcriptPath = path.join(subagentsDirectory, fileName);
    const metadataPath = path.join(subagentsDirectory, `${taskId}.meta.json`);
    if (await pathExists(metadataPath)) {
      continue;
    }

    if (!(await isWhitespaceFile(transcriptPath))) {
      continue;
    }

    report.emptyTranscriptsWithoutMetadataFound += 1;
    if (options.apply) {
      await fs.rm(transcriptPath, { force: true });
      report.emptyTranscriptsWithoutMetadataRemoved += 1;
    }
  }

  const outputFiles = await listFiles(taskOutputsDirectory);
  for (const fileName of outputFiles) {
    if (!fileName.endsWith(".output")) {
      continue;
    }

    const taskId = fileName.slice(0, -".output".length);
    const transcriptPath = path.join(subagentsDirectory, `${taskId}.jsonl`);
    const metadataPath = path.join(subagentsDirectory, `${taskId}.meta.json`);
    const hasTranscript = await pathExists(transcriptPath);
    const hasMetadata = await pathExists(metadataPath);
    if (hasTranscript || hasMetadata) {
      continue;
    }

    report.orphanOutputFilesFound += 1;
    if (options.apply) {
      await fs.rm(path.join(taskOutputsDirectory, fileName), { force: true });
      report.orphanOutputFilesRemoved += 1;
    }
  }
}

async function cleanupLegacyArtifacts(
  options: SubagentStorageCleanupOptions,
  report: SubagentStorageCleanupReport,
  metadataTaskIds: Set<string>
): Promise<void> {
  const markerPath = options.storage.getLegacyMigrationMarkerPath();
  const archivePath = options.storage.getLegacyTasksArchivePath();
  const fallbackDirectory = options.storage.getLegacyFallbackDirectory();

  const marker = await readLegacyMarker(markerPath);
  const hasArchive = await pathExists(archivePath);
  report.migratedLegacyArchiveFound = hasArchive;

  if (marker && hasArchive && isSafeToRemoveLegacyArchive(marker)) {
    if (options.apply) {
      await fs.rm(archivePath, { force: true });
      report.migratedLegacyArchiveRemoved = true;
    }
  }

  const fallbackFiles = await listFiles(fallbackDirectory);
  for (const fileName of fallbackFiles) {
    if (!fileName.endsWith(".json")) {
      continue;
    }

    const fallbackPath = path.join(fallbackDirectory, fileName);
    const taskId = (await readLegacyFallbackTaskId(fallbackPath)) ??
      fileName.slice(0, -".json".length);
    if (!metadataTaskIds.has(taskId)) {
      continue;
    }

    report.migratedLegacyFallbackFilesFound += 1;
    if (options.apply) {
      await fs.rm(fallbackPath, { force: true });
      report.migratedLegacyFallbackFilesRemoved += 1;
    }
  }
}

async function readLegacyMarker(
  markerPath: string
): Promise<LegacyMigrationMarkerRecord | undefined> {
  try {
    const raw = await fs.readFile(markerPath, "utf8");
    const parsed = JSON.parse(raw) as LegacyMigrationMarkerRecord;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    return undefined;
  }
}

function isSafeToRemoveLegacyArchive(marker: LegacyMigrationMarkerRecord): boolean {
  const unresolvedTaskCount = Number(marker.unresolvedTaskCount ?? 0);
  const skippedTaskCount = Number(marker.skippedTaskCount ?? 0);
  const failedTaskCount = Number(marker.failedTaskCount ?? 0);
  return unresolvedTaskCount === 0 &&
    skippedTaskCount === 0 &&
    failedTaskCount === 0;
}

async function readLegacyFallbackTaskId(filePath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { taskId?: unknown };
    return typeof parsed?.taskId === "string" ? parsed.taskId : undefined;
  } catch {
    return undefined;
  }
}

async function listSubdirectories(directoryPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

async function listFiles(directoryPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
}

async function isWhitespaceFile(filePath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.trim().length === 0;
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}
