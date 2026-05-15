import type {
  FileContentSnapshot,
  TrackedFileChangeKind,
  TurnFileChangeSummary
} from "../file-history/fileHistoryManager.js";
import type { DirectoryManifest } from "./directoryManifest.js";
import type { RestoreConflict } from "./snapshotRestore.js";

export interface GitTreeSnapshotRef {
  engine: "git-tree";
  tree: string;
  createdAt: string;
}

export interface TurnSnapshotFileSnapshot {
  absolutePath: string;
  relativePath: string;
  before: FileContentSnapshot;
  after: FileContentSnapshot;
  changeKind: TrackedFileChangeKind;
}

export interface TurnSnapshotRecord {
  turnId: string;
  createdAt: string;
  finalizedAt?: string;
  restoredAt?: string;
  beforeRef?: GitTreeSnapshotRef;
  afterRef?: GitTreeSnapshotRef;
  beforeDirectories?: DirectoryManifest;
  afterDirectories?: DirectoryManifest;
  files: TurnSnapshotFileSnapshot[];
  unavailableReason?: string;
}

export interface SnapshotRestoreResult {
  restored: string[];
  removed: string[];
  conflicts: RestoreConflict[];
  alreadyRestored: boolean;
  missingSnapshot: boolean;
  restoredAt?: string;
}

export type SnapshotFileChangeSummary = TurnFileChangeSummary;
