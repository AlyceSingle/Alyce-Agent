import { promises as fs } from "node:fs";
import path from "node:path";
import type { SessionId } from "../session-history/types.js";
import { SubagentHistoryStore } from "./historyStore.js";
import { SubagentTaskStorage } from "./storagePaths.js";
import {
  LEGACY_SUBAGENT_TASK_FILE_VERSION,
  SUBAGENT_METADATA_VERSION,
  type LegacyPersistedSubagentTask,
  type LegacyPersistedSubagentTaskFile,
  type SubagentMetadataV1,
  type SubagentTranscriptEntry
} from "./types.js";
import type { SubagentTaskStatus } from "../../tools/types.js";

const LEGACY_TASK_MIGRATION_MARKER_VERSION = 1;

interface LegacyTaskMigrationMarker {
  version: number;
  migratedAt: string;
  sourcePath: string;
  archivedPath: string;
  migratedTaskCount: number;
  unresolvedTaskCount: number;
  skippedTaskCount: number;
  failedTaskCount: number;
}

interface LegacyTaskMigrationSummary {
  migratedTaskCount: number;
  unresolvedTaskCount: number;
  skippedTaskCount: number;
  failedTaskCount: number;
}

interface LegacyTaskMigrationOptions {
  storage: SubagentTaskStorage;
  historyStore: SubagentHistoryStore;
}

export async function migrateLegacySubagentTasks(
  options: LegacyTaskMigrationOptions
): Promise<void> {
  const markerPath = options.storage.getLegacyMigrationMarkerPath();
  if (await pathExists(markerPath)) {
    return;
  }

  const legacyTasksPath = options.storage.getLegacyTasksFilePath();
  const legacyArchivePath = options.storage.getLegacyTasksArchivePath();
  const legacyFallbackDirectory = options.storage.getLegacyFallbackDirectory();

  const parsed = await loadLegacyTaskFile(legacyTasksPath);
  if (!parsed) {
    return;
  }

  const summary: LegacyTaskMigrationSummary = {
    migratedTaskCount: 0,
    unresolvedTaskCount: 0,
    skippedTaskCount: 0,
    failedTaskCount: 0
  };

  for (const rawTask of parsed.tasks) {
    if (!isPersistedSubagentTask(rawTask)) {
      summary.skippedTaskCount += 1;
      continue;
    }

    const task = rawTask;
    const parentSessionId = inferParentSessionId(task);
    if (!parentSessionId) {
      await writeUnresolvedLegacyTask(legacyFallbackDirectory, task);
      summary.unresolvedTaskCount += 1;
      continue;
    }

    try {
      await migrateLegacyTask(task, parentSessionId, options);
      summary.migratedTaskCount += 1;
    } catch {
      summary.failedTaskCount += 1;
    }
  }

  await archiveLegacyTasksFile(legacyTasksPath, legacyArchivePath);
  await writeMigrationMarker(markerPath, legacyTasksPath, legacyArchivePath, summary);
}

async function loadLegacyTaskFile(
  legacyTasksPath: string
): Promise<LegacyPersistedSubagentTaskFile | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(legacyTasksPath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const record = parsed as Partial<LegacyPersistedSubagentTaskFile>;
  if (record.version !== LEGACY_SUBAGENT_TASK_FILE_VERSION || !Array.isArray(record.tasks)) {
    return undefined;
  }

  return {
    version: record.version,
    tasks: record.tasks
  } satisfies LegacyPersistedSubagentTaskFile;
}

async function migrateLegacyTask(
  task: LegacyPersistedSubagentTask,
  parentSessionId: SessionId,
  options: LegacyTaskMigrationOptions
): Promise<void> {
  const storageIdentity = options.storage.getStorageIdentity(task.taskId, parentSessionId);
  const normalizedStatus = normalizeLegacyTaskStatus(task.status);
  const metadata = buildMetadata(task, parentSessionId);
  const transcriptEntries = buildTranscriptEntries(task, parentSessionId, metadata, normalizedStatus);

  const existingMetadata = await options.historyStore.readMetadata(storageIdentity.metadataPath);
  if (!existingMetadata) {
    await options.historyStore.writeMetadata(storageIdentity.metadataPath, metadata);
  }

  const existingTranscriptEntries = await options.historyStore.readTranscriptEntries(storageIdentity.transcriptPath);
  if (existingTranscriptEntries.length === 0) {
    await options.historyStore.appendTranscriptEntries(storageIdentity.transcriptPath, transcriptEntries);
  }

  if (task.output !== undefined && !(await pathExists(storageIdentity.outputPath))) {
    await options.historyStore.writeOutput(storageIdentity.outputPath, task.output);
  }
}

function buildMetadata(
  task: LegacyPersistedSubagentTask,
  parentSessionId: SessionId
): SubagentMetadataV1 {
  return {
    version: SUBAGENT_METADATA_VERSION,
    agentId: task.taskId,
    parentSessionId,
    agentType: task.agentType,
    description: task.description,
    model: task.model,
    maxSteps: task.maxSteps,
    createdAt: task.createdAt,
    ...(task.worktreePath ? { worktreePath: task.worktreePath } : {}),
    ...(task.baseWorkspaceRoot ? { baseWorkspaceRoot: task.baseWorkspaceRoot } : {})
  };
}

function buildTranscriptEntries(
  task: LegacyPersistedSubagentTask,
  parentSessionId: SessionId,
  metadata: SubagentMetadataV1,
  normalizedStatus: SubagentTaskStatus
): SubagentTranscriptEntry[] {
  const entries: SubagentTranscriptEntry[] = [];
  entries.push({
    type: "subagent-meta",
    timestamp: task.createdAt,
    agentId: task.taskId,
    parentSessionId,
    metadata
  });

  for (const message of task.messages) {
    entries.push({
      type: "api-message",
      timestamp: task.createdAt,
      agentId: task.taskId,
      parentSessionId,
      message
    });
  }

  const statusMessage = task.status === "running"
    ? "Legacy running task marked failed during migration."
    : undefined;
  entries.push({
    type: "status",
    timestamp: task.updatedAt,
    agentId: task.taskId,
    parentSessionId,
    status: normalizedStatus,
    ...(statusMessage ? { message: statusMessage } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(task.output !== undefined ? { output: task.output } : {}),
    ...(task.startedAt ? { startedAt: task.startedAt } : {}),
    ...(task.completedAt ? { completedAt: task.completedAt } : {})
  });

  return entries;
}

function inferParentSessionId(task: LegacyPersistedSubagentTask): SessionId | undefined {
  if (typeof task.parentSessionId === "string" && task.parentSessionId.trim()) {
    return task.parentSessionId.trim();
  }

  const candidates = [task.transcriptPath, task.metadataPath, task.outputPath];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) {
      continue;
    }

    const parsed = parseSessionIdFromStoragePath(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function parseSessionIdFromStoragePath(filePath: string): SessionId | undefined {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const match = normalizedPath.match(/(?:^|\/)sessions\/([^/]+)/);
  const sessionId = match?.[1];
  if (!sessionId || sessionId === "." || sessionId === "..") {
    return undefined;
  }
  return sessionId;
}

async function writeUnresolvedLegacyTask(
  fallbackDirectory: string,
  task: LegacyPersistedSubagentTask
): Promise<void> {
  await fs.mkdir(fallbackDirectory, { recursive: true });
  const baseName = sanitizeTaskIdForFileName(task.taskId);
  const preferredPath = path.join(fallbackDirectory, `${baseName}.json`);
  const targetPath = await getUniqueFilePath(preferredPath);
  await fs.writeFile(targetPath, JSON.stringify(task, null, 2), "utf8");
}

async function getUniqueFilePath(preferredPath: string): Promise<string> {
  if (!(await pathExists(preferredPath))) {
    return preferredPath;
  }

  const extension = path.extname(preferredPath);
  const basePath = preferredPath.slice(0, preferredPath.length - extension.length);
  let counter = 1;
  while (true) {
    const candidate = `${basePath}-${counter}${extension}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
    counter += 1;
  }
}

function sanitizeTaskIdForFileName(taskId: string): string {
  const sanitized = taskId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.trim() || "unknown-task";
}

function normalizeLegacyTaskStatus(status: SubagentTaskStatus): SubagentTaskStatus {
  if (status === "running") {
    return "failed";
  }

  return status;
}

async function archiveLegacyTasksFile(
  sourcePath: string,
  archivePath: string
): Promise<void> {
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  if (await pathExists(archivePath)) {
    await fs.rm(archivePath, { force: true });
  }
  await fs.rename(sourcePath, archivePath);
}

async function writeMigrationMarker(
  markerPath: string,
  sourcePath: string,
  archivedPath: string,
  summary: LegacyTaskMigrationSummary
): Promise<void> {
  const marker: LegacyTaskMigrationMarker = {
    version: LEGACY_TASK_MIGRATION_MARKER_VERSION,
    migratedAt: new Date().toISOString(),
    sourcePath,
    archivedPath,
    migratedTaskCount: summary.migratedTaskCount,
    unresolvedTaskCount: summary.unresolvedTaskCount,
    skippedTaskCount: summary.skippedTaskCount,
    failedTaskCount: summary.failedTaskCount
  };

  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify(marker, null, 2), "utf8");
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
  );
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isPersistedSubagentTask(value: unknown): value is LegacyPersistedSubagentTask {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Partial<LegacyPersistedSubagentTask>;
  return typeof record.taskId === "string" &&
    typeof record.agentType === "string" &&
    typeof record.description === "string" &&
    typeof record.model === "string" &&
    typeof record.maxSteps === "number" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    isPersistedSubagentStatus(record.status) &&
    (record.parentSessionId === undefined || typeof record.parentSessionId === "string") &&
    (record.transcriptPath === undefined || typeof record.transcriptPath === "string") &&
    (record.metadataPath === undefined || typeof record.metadataPath === "string") &&
    (record.outputPath === undefined || typeof record.outputPath === "string") &&
    Array.isArray(record.messages);
}

function isPersistedSubagentStatus(value: unknown): value is SubagentTaskStatus {
  return value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "stopped";
}
