import path from "node:path";
import type { RuntimeConfig, SessionSettings } from "../../config/runtime.js";
import { FileHistoryManager, type FileHistoryRestoreResult } from "../../core/file-history/fileHistoryManager.js";
import {
  FileBackupStore,
  type PersistedFileHistorySnapshot
} from "../../core/file-history/fileBackupStore.js";
import {
  createTurnSnapshotService,
  type SnapshotDiagnostics
} from "../../core/snapshot/turnSnapshotService.js";
import type { SnapshotRestoreResult } from "../../core/snapshot/snapshotTypes.js";
import {
  DiffService,
  type DiffReport,
  type TurnDiffReport,
  type WorkingTreeDiffReport
} from "../../core/diff/diffService.js";
import type { SessionId } from "../../core/session-history/types.js";
import {
  isFileBackupSnapshotEnabled,
  mergeFileRestoreResults
} from "./helpers/index.js";

export interface TurnHistoryControllerDeps {
  config: RuntimeConfig;
  getSettings: () => SessionSettings;
  getCurrentSessionId: () => SessionId;
  recordFileSnapshot: (snapshot: PersistedFileHistorySnapshot) => Promise<void>;
  getLatestSnapshotCleanupError?: () => string | undefined;
}

export interface TurnHistoryController {
  beginTurn: (turnId: string) => Promise<void>;
  finalizeTurnFileChanges: (turnId: string) => Promise<void>;
  hasTrackedFileChanges: (turnId: string) => boolean;
  canRestoreFilesForTurn: (turnId: string) => boolean;
  isFilesAlreadyRestoredForTurn: (turnId: string) => boolean;
  restoreFilesForTurn: (turnId: string) => Promise<FileHistoryRestoreResult>;
  discardTurn: (turnId: string) => void;
  getTurnDiff: (turnId: string) => Promise<TurnDiffReport>;
  getLastAlyceTurnDiff: () => Promise<TurnDiffReport | undefined>;
  getWorkingTreeDiff: () => Promise<WorkingTreeDiffReport>;
  getSnapshotDiagnostics: () => Promise<SnapshotDiagnostics>;
  formatDiffSummary: (report: DiffReport) => string;
  captureFileBeforeWrite: (turnId: string, absolutePath: string) => Promise<void>;
  hydrateFileHistoryForSession: (
    sessionId: SessionId,
    snapshots: readonly PersistedFileHistorySnapshot[]
  ) => Promise<void>;
  clearAll: () => void;
  updateSnapshotConfig: (settings: SessionSettings) => void;
  getGitDirectory: () => string;
}

export function createTurnHistoryController(
  deps: TurnHistoryControllerDeps
): TurnHistoryController {
  const {
    config,
    getSettings,
    getCurrentSessionId,
    recordFileSnapshot,
    getLatestSnapshotCleanupError
  } = deps;

  const fileHistoryManager = new FileHistoryManager();
  const turnSnapshotService = createTurnSnapshotService({
    workspaceRoot: config.paths.workspaceRoot,
    alyceDirectory: config.paths.alyceDirectory,
    config: getSettings().snapshot
  });
  const diffService = new DiffService({
    workspaceRoot: config.paths.workspaceRoot,
    fileHistoryManager,
    turnSnapshotService
  });

  const getFileBackupStore = (sessionId = getCurrentSessionId()) =>
    new FileBackupStore({
      rootDirectory: path.join(config.paths.alyceDirectory, "file-history"),
      sessionId
    });

  async function persistFileHistorySnapshot(
    turnId: string,
    options: { recordSessionHistory?: boolean } = {}
  ): Promise<PersistedFileHistorySnapshot | undefined> {
    if (!isFileBackupSnapshotEnabled(getSettings())) {
      return undefined;
    }

    const snapshot = fileHistoryManager.getSnapshot(turnId);
    if (!snapshot || snapshot.trackedFiles.size === 0) {
      return undefined;
    }

    const persisted = await getFileBackupStore().writeSnapshot(snapshot);
    if (options.recordSessionHistory) {
      await recordFileSnapshot(persisted);
    }

    return persisted;
  }

  async function captureFileBeforeWrite(turnId: string, absolutePath: string) {
    if (!isFileBackupSnapshotEnabled(getSettings())) {
      return;
    }

    await fileHistoryManager.captureBeforeWrite(turnId, absolutePath);
    await persistFileHistorySnapshot(turnId);
  }

  async function hydrateFileHistoryForSession(
    sessionId: SessionId,
    snapshots: readonly PersistedFileHistorySnapshot[]
  ) {
    const hydrated = await getFileBackupStore(sessionId).loadSessionSnapshots(snapshots);
    fileHistoryManager.hydrateSnapshots(hydrated);
  }

  async function restoreFilesForTurn(turnId: string): Promise<FileHistoryRestoreResult> {
    const results: SnapshotRestoreResult[] = [];
    let snapshotCoveredPaths: string[] = [];
    if (turnSnapshotService.hasTurn(turnId)) {
      const result = await turnSnapshotService.restoreTurn(turnId);
      results.push(result);
      if (!result.missingSnapshot) {
        snapshotCoveredPaths = turnSnapshotService
          .getFileSnapshotsForTurn(turnId)
          .filter((file) => file.changeKind !== "unchanged")
          .map((file) => file.absolutePath);
      }
    }
    if (fileHistoryManager.getSnapshot(turnId)) {
      results.push(await fileHistoryManager.restoreTurn(turnId, {
        excludePaths: snapshotCoveredPaths
      }));
      await persistFileHistorySnapshot(turnId, { recordSessionHistory: true });
    }

    return mergeFileRestoreResults(results);
  }

  function isFilesAlreadyRestoredForTurn(turnId: string) {
    const restoreStates: boolean[] = [];
    if (turnSnapshotService.hasTurn(turnId)) {
      restoreStates.push(turnSnapshotService.isTurnRestored(turnId));
    }
    if (fileHistoryManager.getSnapshot(turnId)) {
      restoreStates.push(fileHistoryManager.isTurnRestored(turnId));
    }
    return restoreStates.length > 0 && restoreStates.every(Boolean);
  }

  return {
    beginTurn: async (turnId) => {
      if (isFileBackupSnapshotEnabled(getSettings())) {
        fileHistoryManager.beginTurn(turnId);
      }
      await turnSnapshotService.beginTurn(turnId);
    },
    finalizeTurnFileChanges: async (turnId) => {
      await Promise.all([
        isFileBackupSnapshotEnabled(getSettings())
          ? fileHistoryManager.finalizeTurn(turnId)
          : Promise.resolve([]),
        turnSnapshotService.finalizeTurn(turnId)
      ]);
      await persistFileHistorySnapshot(turnId, { recordSessionHistory: true });
    },
    hasTrackedFileChanges: (turnId) =>
      (isFileBackupSnapshotEnabled(getSettings()) && fileHistoryManager.hasTrackedFiles(turnId)) ||
      turnSnapshotService.hasRestorableChanges(turnId),
    canRestoreFilesForTurn: (turnId) =>
      (isFileBackupSnapshotEnabled(getSettings()) && fileHistoryManager.canRestoreTurn(turnId)) ||
      turnSnapshotService.canRestoreTurn(turnId),
    isFilesAlreadyRestoredForTurn,
    restoreFilesForTurn,
    discardTurn: (turnId) => {
      fileHistoryManager.removeTurn(turnId);
      turnSnapshotService.removeTurn(turnId);
    },
    getTurnDiff: (turnId) => diffService.getTurnDiff(turnId),
    getLastAlyceTurnDiff: () => diffService.getLastAlyceTurnDiff(),
    getWorkingTreeDiff: () => diffService.getWorkingTreeDiff(),
    getSnapshotDiagnostics: () =>
      turnSnapshotService.getDiagnostics({
        cleanupError: getLatestSnapshotCleanupError?.()
      }),
    formatDiffSummary: (report) => diffService.formatDiffSummary(report),
    captureFileBeforeWrite,
    hydrateFileHistoryForSession,
    clearAll: () => {
      fileHistoryManager.clearAll();
      turnSnapshotService.clearAll();
    },
    updateSnapshotConfig: (settings) => {
      turnSnapshotService.updateConfig(settings.snapshot);
    },
    getGitDirectory: () => turnSnapshotService.getGitDirectory()
  };
}
