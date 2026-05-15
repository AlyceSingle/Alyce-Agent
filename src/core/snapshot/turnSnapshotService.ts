import path from "node:path";
import type { SnapshotRuntimeConfig } from "../../config/runtime.js";
import {
  captureDirectoryManifest,
  getCreatedDirectoryPaths
} from "./directoryManifest.js";
import { GitTreeSnapshotStore } from "./gitTreeSnapshotStore.js";
import { cleanupCreatedDirectories } from "./snapshotRestore.js";
import type {
  SnapshotFileChangeSummary,
  SnapshotRestoreResult,
  TurnSnapshotRecord
} from "./snapshotTypes.js";

const MAX_TURN_SNAPSHOTS = 100;
const DEFAULT_SNAPSHOT_CONFIG: SnapshotRuntimeConfig = {
  enabled: true,
  engine: "hybrid",
  maxTextDiffBytes: 524_288,
  maxFileBytes: 2_097_152,
  retentionDays: 7,
  includeIgnoredExplicitPaths: true,
  manifestScan: true
};

export interface SnapshotDiagnostics {
  enabled: boolean;
  configuredEngine: SnapshotRuntimeConfig["engine"];
  activeEngine: "git-tree" | "file-backup" | "hybrid" | "disabled";
  gitTreeEnabled: boolean;
  gitAvailable: boolean;
  workspaceRoot: string;
  snapshotRoot: string;
  gitDirectory: string;
  retentionDays: number;
  maxTextDiffBytes: number;
  maxFileBytes: number;
  includeIgnoredExplicitPaths: boolean;
  manifestScan: boolean;
  records: number;
  latestError?: string;
  cleanupError?: string;
}

export class TurnSnapshotService {
  private readonly records = new Map<string, TurnSnapshotRecord>();
  private readonly order: string[] = [];
  private readonly store: GitTreeSnapshotStore;
  private config: SnapshotRuntimeConfig;
  private latestError?: string;

  constructor(
    private readonly options: {
      workspaceRoot: string;
      snapshotRoot: string;
      config?: SnapshotRuntimeConfig;
    }
  ) {
    this.config = options.config ?? DEFAULT_SNAPSHOT_CONFIG;
    this.store = new GitTreeSnapshotStore({
      workspaceRoot: options.workspaceRoot,
      gitDirectory: GitTreeSnapshotStore.getWorkspaceSnapshotDirectory(
        options.snapshotRoot,
        options.workspaceRoot
      )
    });
  }

  async beginTurn(turnId: string): Promise<void> {
    if (!this.isGitTreeEnabled()) {
      return;
    }

    if (this.records.has(turnId)) {
      return;
    }

    const record: TurnSnapshotRecord = {
      turnId,
      createdAt: new Date().toISOString(),
      files: []
    };
    this.records.set(turnId, record);
    this.order.push(turnId);
    this.trimRecords();

    try {
      const [beforeRef, beforeDirectories] = await Promise.all([
        this.store.capture(),
        this.captureDirectoryManifest()
      ]);
      record.beforeRef = beforeRef;
      record.beforeDirectories = beforeDirectories;
      record.unavailableReason = undefined;
      this.latestError = undefined;
    } catch (error) {
      record.unavailableReason = formatError(error);
      this.latestError = record.unavailableReason;
    }
  }

  async finalizeTurn(turnId: string): Promise<SnapshotFileChangeSummary[]> {
    if (!this.isGitTreeEnabled()) {
      return [];
    }

    const record = this.records.get(turnId);
    if (!record || !record.beforeRef) {
      return [];
    }

    if (!record.finalizedAt) {
      try {
        const [afterRef, afterDirectories] = await Promise.all([
          this.store.capture(),
          this.captureDirectoryManifest()
        ]);
        record.afterRef = afterRef;
        record.afterDirectories = afterDirectories;
        record.files = await this.store.diffSnapshots(record.beforeRef, record.afterRef);
        record.finalizedAt = new Date().toISOString();
        record.unavailableReason = undefined;
        this.latestError = undefined;
      } catch (error) {
        record.unavailableReason = formatError(error);
        this.latestError = record.unavailableReason;
        return [];
      }
    }

    return this.getChangedFilesForTurn(turnId);
  }

  hasTurn(turnId: string) {
    return this.isGitTreeEnabled() && this.records.has(turnId);
  }

  hasTrackedFiles(turnId: string) {
    return this.getFileSnapshotsForTurn(turnId).some((file) => file.changeKind !== "unchanged");
  }

  hasRestorableChanges(turnId: string) {
    const record = this.records.get(turnId);
    return Boolean(
      record &&
      (this.hasTrackedFiles(turnId) || this.getCreatedDirectories(record).length > 0)
    );
  }

  canRestoreTurn(turnId: string) {
    const record = this.records.get(turnId);
    return Boolean(
      record &&
      record.beforeRef &&
      !record.restoredAt &&
      (record.files.some((file) => file.changeKind !== "unchanged") ||
        this.getCreatedDirectories(record).length > 0)
    );
  }

  isTurnRestored(turnId: string) {
    return Boolean(this.records.get(turnId)?.restoredAt);
  }

  getSnapshot(turnId: string): TurnSnapshotRecord | undefined {
    return this.records.get(turnId);
  }

  getFileSnapshotsForTurn(turnId: string) {
    return [...(this.records.get(turnId)?.files ?? [])];
  }

  getChangedFilesForTurn(turnId: string): SnapshotFileChangeSummary[] {
    return this.getFileSnapshotsForTurn(turnId)
      .filter((snapshot) => snapshot.changeKind !== "unchanged")
      .map((snapshot) => ({
        absolutePath: snapshot.absolutePath,
        changeKind: snapshot.changeKind,
        beforeBytes: snapshot.before.existed ? snapshot.before.content.byteLength : 0,
        afterBytes: snapshot.after.existed ? snapshot.after.content.byteLength : 0
      }));
  }

  getLatestTurnIdWithTrackedFiles(): string | undefined {
    if (!this.isGitTreeEnabled()) {
      return undefined;
    }

    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const turnId = this.order[index];
      if (turnId && this.hasTrackedFiles(turnId)) {
        return turnId;
      }
    }

    return undefined;
  }

  async restoreTurn(turnId: string): Promise<SnapshotRestoreResult> {
    if (!this.isGitTreeEnabled()) {
      return createMissingSnapshotResult();
    }

    const record = this.records.get(turnId);
    if (!record || !record.beforeRef) {
      return createMissingSnapshotResult();
    }

    if (record.restoredAt) {
      return {
        restored: [],
        removed: [],
        conflicts: [],
        alreadyRestored: true,
        missingSnapshot: false,
        restoredAt: record.restoredAt
      };
    }

    await this.finalizeTurn(turnId);
    const files = record.files.filter((file) => file.changeKind !== "unchanged");
    const createdDirectories = this.getCreatedDirectories(record);
    if (files.length === 0 && createdDirectories.length === 0) {
      return createMissingSnapshotResult();
    }

    const result = await this.store.restoreFiles(files);
    await cleanupCreatedDirectories(createdDirectories);
    if (result.conflicts.length === 0) {
      record.restoredAt = new Date().toISOString();
    }

    return {
      ...result,
      alreadyRestored: false,
      missingSnapshot: false,
      ...(record.restoredAt ? { restoredAt: record.restoredAt } : {})
    };
  }

  removeTurn(turnId: string) {
    if (!this.records.delete(turnId)) {
      return;
    }

    const index = this.order.indexOf(turnId);
    if (index !== -1) {
      this.order.splice(index, 1);
    }
  }

  clearAll() {
    this.records.clear();
    this.order.splice(0, this.order.length);
  }

  updateConfig(config: SnapshotRuntimeConfig) {
    this.config = config;
  }

  getGitDirectory() {
    return GitTreeSnapshotStore.getWorkspaceSnapshotDirectory(
      this.options.snapshotRoot,
      this.options.workspaceRoot
    );
  }

  async getDiagnostics(options: { cleanupError?: string } = {}): Promise<SnapshotDiagnostics> {
    return {
      enabled: this.config.enabled,
      configuredEngine: this.config.engine,
      activeEngine: this.getActiveEngine(),
      gitTreeEnabled: this.isGitTreeEnabled(),
      gitAvailable: await GitTreeSnapshotStore.isGitAvailable(),
      workspaceRoot: this.options.workspaceRoot,
      snapshotRoot: this.options.snapshotRoot,
      gitDirectory: this.getGitDirectory(),
      retentionDays: this.config.retentionDays,
      maxTextDiffBytes: this.config.maxTextDiffBytes,
      maxFileBytes: this.config.maxFileBytes,
      includeIgnoredExplicitPaths: this.config.includeIgnoredExplicitPaths,
      manifestScan: this.config.manifestScan,
      records: this.records.size,
      ...(this.latestError ? { latestError: this.latestError } : {}),
      ...(options.cleanupError ? { cleanupError: options.cleanupError } : {})
    };
  }

  private trimRecords() {
    while (this.order.length > MAX_TURN_SNAPSHOTS) {
      const oldest = this.order.shift();
      if (oldest) {
        this.records.delete(oldest);
      }
    }
  }

  private getCreatedDirectories(record: TurnSnapshotRecord) {
    return getCreatedDirectoryPaths(
      this.options.workspaceRoot,
      record.beforeDirectories,
      record.afterDirectories
    );
  }

  private async captureDirectoryManifest() {
    return this.config.manifestScan
      ? captureDirectoryManifest(this.options.workspaceRoot)
      : undefined;
  }

  private isGitTreeEnabled() {
    return this.config.enabled &&
      (this.config.engine === "hybrid" || this.config.engine === "git-tree");
  }

  private getActiveEngine(): SnapshotDiagnostics["activeEngine"] {
    if (!this.config.enabled) {
      return "disabled";
    }

    return this.config.engine;
  }
}

export function createTurnSnapshotService(options: {
  workspaceRoot: string;
  alyceDirectory: string;
  config: SnapshotRuntimeConfig;
}) {
  return new TurnSnapshotService({
    workspaceRoot: options.workspaceRoot,
    snapshotRoot: path.join(options.alyceDirectory, "snapshots", "git"),
    config: options.config
  });
}

function createMissingSnapshotResult(): SnapshotRestoreResult {
  return {
    restored: [],
    removed: [],
    conflicts: [],
    alreadyRestored: false,
    missingSnapshot: true
  };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
