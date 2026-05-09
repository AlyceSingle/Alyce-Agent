import path from "node:path";
import type { SessionId } from "../session-history/types.js";
import type { SubagentId, SubagentStorageIdentity, SubagentTaskStoragePaths } from "./types.js";

export class SubagentTaskStorage {
  private static readonly LEGACY_TASKS_ARCHIVE_FILE = "tasks.legacy.json";
  private static readonly LEGACY_MIGRATION_MARKER_FILE = "tasks.migration.v1.json";
  private readonly sessionsDirectory: string;
  private readonly legacyTasksDirectory: string;

  constructor(
    private readonly options: {
      alyceDirectory: string;
      getCurrentSessionId: () => SessionId;
    }
  ) {
    this.sessionsDirectory = path.join(options.alyceDirectory, "sessions");
    this.legacyTasksDirectory = path.join(options.alyceDirectory, "tasks");
  }

  getLegacyTasksDirectory(): string {
    return this.legacyTasksDirectory;
  }

  getLegacyTasksFilePath(): string {
    return path.join(this.legacyTasksDirectory, "tasks.json");
  }

  getLegacyTasksArchivePath(): string {
    return path.join(
      this.legacyTasksDirectory,
      SubagentTaskStorage.LEGACY_TASKS_ARCHIVE_FILE
    );
  }

  getLegacyMigrationMarkerPath(): string {
    return path.join(
      this.legacyTasksDirectory,
      SubagentTaskStorage.LEGACY_MIGRATION_MARKER_FILE
    );
  }

  getLegacyFallbackDirectory(): string {
    return path.join(this.legacyTasksDirectory, "legacy");
  }

  getSessionsDirectory(): string {
    return this.sessionsDirectory;
  }

  getSessionDirectory(sessionId = this.options.getCurrentSessionId()): string {
    return path.join(this.sessionsDirectory, sessionId);
  }

  getSubagentsDirectory(sessionId = this.options.getCurrentSessionId()): string {
    return path.join(this.getSessionDirectory(sessionId), "subagents");
  }

  getTaskOutputsDirectory(sessionId = this.options.getCurrentSessionId()): string {
    return path.join(this.getSessionDirectory(sessionId), "tasks");
  }

  getTaskStoragePaths(
    taskId: SubagentId,
    sessionId = this.options.getCurrentSessionId()
  ): SubagentTaskStoragePaths {
    const subagentsDirectory = this.getSubagentsDirectory(sessionId);
    const taskOutputsDirectory = this.getTaskOutputsDirectory(sessionId);
    return {
      sessionId,
      sessionDirectory: this.getSessionDirectory(sessionId),
      subagentsDirectory,
      taskOutputsDirectory,
      parentSessionId: sessionId,
      transcriptPath: path.join(subagentsDirectory, `${taskId}.jsonl`),
      metadataPath: path.join(subagentsDirectory, `${taskId}.meta.json`),
      outputPath: path.join(taskOutputsDirectory, `${taskId}.output`)
    };
  }

  getStorageIdentity(
    taskId: SubagentId,
    sessionId = this.options.getCurrentSessionId()
  ): SubagentStorageIdentity {
    const paths = this.getTaskStoragePaths(taskId, sessionId);
    return {
      parentSessionId: paths.parentSessionId,
      transcriptPath: paths.transcriptPath,
      metadataPath: paths.metadataPath,
      outputPath: paths.outputPath
    };
  }
}
