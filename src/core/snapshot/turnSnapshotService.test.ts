import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiffService } from "../diff/diffService.js";
import { FileHistoryManager } from "../file-history/fileHistoryManager.js";
import { normalizeSnapshotSettings } from "../../config/runtime.js";
import { GitTreeSnapshotStore } from "./gitTreeSnapshotStore.js";
import { TurnSnapshotService } from "./turnSnapshotService.js";

async function runTests() {
  if (!await GitTreeSnapshotStore.isGitAvailable()) {
    console.log("turnSnapshotService tests skipped: git unavailable");
    return;
  }

  await testTurnSnapshotDiffAndRestoreWithoutFileHistory();
  await testTurnSnapshotRestoreKeepsExistingDirectories();
  await testTurnSnapshotRestoreKeepsDirectoriesWithUserFiles();
  await testTurnSnapshotRestoreRemovesEmptyDirectoryOnlyTurn();
  await testManifestScanDisabledSkipsEmptyDirectoryOnlyTurn();
  await testTurnSnapshotRestoreRenameAsAddedAndDeleted();
  await testTurnSnapshotRestoreSkipsConflicts();
  await testDiffServiceFallsBackToFileHistoryForIgnoredFiles();
  console.log("turnSnapshotService tests passed");
}

async function testTurnSnapshotDiffAndRestoreWithoutFileHistory() {
  await withTempWorkspace(async ({ workspaceRoot, snapshotRoot }) => {
    const service = new TurnSnapshotService({ workspaceRoot, snapshotRoot });
    const existingPath = path.join(workspaceRoot, "existing.txt");
    const createdDirectory = path.join(workspaceRoot, "created-dir");
    const createdPath = path.join(createdDirectory, "created.txt");
    const deletedPath = path.join(workspaceRoot, "deleted.txt");
    await fs.writeFile(existingPath, "before\n");
    await fs.writeFile(deletedPath, "delete me\n");

    await service.beginTurn("turn-1");
    await fs.writeFile(existingPath, "after\n");
    await fs.mkdir(createdDirectory, { recursive: true });
    await fs.writeFile(createdPath, "created\n");
    await fs.unlink(deletedPath);
    const changes = await service.finalizeTurn("turn-1");

    assert.equal(service.hasTrackedFiles("turn-1"), true);
    assert.equal(service.canRestoreTurn("turn-1"), true);
    assert.deepEqual(
      changes.map((file) => [path.basename(file.absolutePath), file.changeKind]),
      [
        ["created.txt", "added"],
        ["deleted.txt", "deleted"],
        ["existing.txt", "modified"]
      ]
    );

    const result = await service.restoreTurn("turn-1");
    assert.equal(result.missingSnapshot, false);
    assert.deepEqual(result.restored.sort(), [deletedPath, existingPath].sort());
    assert.deepEqual(result.removed, [createdPath]);
    assert.equal(await fs.readFile(existingPath, "utf8"), "before\n");
    assert.equal(await fs.readFile(deletedPath, "utf8"), "delete me\n");
    await assert.rejects(fs.stat(createdPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(createdDirectory), { code: "ENOENT" });
  });
}

async function testTurnSnapshotRestoreKeepsExistingDirectories() {
  await withTempWorkspace(async ({ workspaceRoot, snapshotRoot }) => {
    const service = new TurnSnapshotService({ workspaceRoot, snapshotRoot });
    const existingDirectory = path.join(workspaceRoot, "existing-dir");
    const createdPath = path.join(existingDirectory, "created.txt");
    await fs.mkdir(existingDirectory, { recursive: true });

    await service.beginTurn("turn-1");
    await fs.writeFile(createdPath, "created\n");
    await service.finalizeTurn("turn-1");

    const result = await service.restoreTurn("turn-1");
    assert.deepEqual(result.removed, [createdPath]);
    await assert.rejects(fs.stat(createdPath), { code: "ENOENT" });
    assert.equal((await fs.stat(existingDirectory)).isDirectory(), true);
  });
}

async function testTurnSnapshotRestoreKeepsDirectoriesWithUserFiles() {
  await withTempWorkspace(async ({ workspaceRoot, snapshotRoot }) => {
    const service = new TurnSnapshotService({ workspaceRoot, snapshotRoot });
    const createdDirectory = path.join(workspaceRoot, "kept-dir");
    const createdPath = path.join(createdDirectory, "created.txt");
    const userPath = path.join(createdDirectory, "user.txt");

    await service.beginTurn("turn-1");
    await fs.mkdir(createdDirectory, { recursive: true });
    await fs.writeFile(createdPath, "created\n");
    await service.finalizeTurn("turn-1");
    await fs.writeFile(userPath, "user\n");

    const result = await service.restoreTurn("turn-1");
    assert.deepEqual(result.removed, [createdPath]);
    await assert.rejects(fs.stat(createdPath), { code: "ENOENT" });
    assert.equal(await fs.readFile(userPath, "utf8"), "user\n");
    assert.equal((await fs.stat(createdDirectory)).isDirectory(), true);
  });
}

async function testTurnSnapshotRestoreRemovesEmptyDirectoryOnlyTurn() {
  await withTempWorkspace(async ({ workspaceRoot, snapshotRoot }) => {
    const service = new TurnSnapshotService({ workspaceRoot, snapshotRoot });
    const createdDirectory = path.join(workspaceRoot, "empty-created-dir");

    await service.beginTurn("turn-1");
    await fs.mkdir(createdDirectory, { recursive: true });
    await service.finalizeTurn("turn-1");

    assert.equal(service.hasTrackedFiles("turn-1"), false);
    assert.equal(service.hasRestorableChanges("turn-1"), true);
    assert.equal(service.canRestoreTurn("turn-1"), true);

    const result = await service.restoreTurn("turn-1");
    assert.equal(result.missingSnapshot, false);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, []);
    await assert.rejects(fs.stat(createdDirectory), { code: "ENOENT" });
  });
}

async function testManifestScanDisabledSkipsEmptyDirectoryOnlyTurn() {
  await withTempWorkspace(async ({ workspaceRoot, snapshotRoot }) => {
    const service = new TurnSnapshotService({
      workspaceRoot,
      snapshotRoot,
      config: normalizeSnapshotSettings({ manifestScan: false })
    });
    const createdDirectory = path.join(workspaceRoot, "empty-created-dir");

    await service.beginTurn("turn-1");
    await fs.mkdir(createdDirectory, { recursive: true });
    await service.finalizeTurn("turn-1");

    assert.equal(service.hasTrackedFiles("turn-1"), false);
    assert.equal(service.hasRestorableChanges("turn-1"), false);
    assert.equal(service.canRestoreTurn("turn-1"), false);

    const result = await service.restoreTurn("turn-1");
    assert.equal(result.missingSnapshot, true);
    assert.equal((await fs.stat(createdDirectory)).isDirectory(), true);
  });
}

async function testTurnSnapshotRestoreRenameAsAddedAndDeleted() {
  await withTempWorkspace(async ({ workspaceRoot, snapshotRoot }) => {
    const service = new TurnSnapshotService({ workspaceRoot, snapshotRoot });
    const sourcePath = path.join(workspaceRoot, "rename-source.txt");
    const targetDirectory = path.join(workspaceRoot, "renamed");
    const targetPath = path.join(targetDirectory, "rename-target.txt");
    await fs.writeFile(sourcePath, "rename me\n");

    await service.beginTurn("turn-1");
    await fs.mkdir(targetDirectory, { recursive: true });
    await fs.rename(sourcePath, targetPath);
    await service.finalizeTurn("turn-1");

    assert.deepEqual(
      service.getFileSnapshotsForTurn("turn-1").map((file) => [file.relativePath, file.changeKind]),
      [
        ["rename-source.txt", "deleted"],
        ["renamed/rename-target.txt", "added"]
      ]
    );

    const result = await service.restoreTurn("turn-1");
    assert.deepEqual(result.restored, [sourcePath]);
    assert.deepEqual(result.removed, [targetPath]);
    assert.equal(await fs.readFile(sourcePath, "utf8"), "rename me\n");
    await assert.rejects(fs.stat(targetPath), { code: "ENOENT" });
    await assert.rejects(fs.stat(targetDirectory), { code: "ENOENT" });
  });
}

async function testTurnSnapshotRestoreSkipsConflicts() {
  await withTempWorkspace(async ({ workspaceRoot, snapshotRoot }) => {
    const service = new TurnSnapshotService({ workspaceRoot, snapshotRoot });
    const filePath = path.join(workspaceRoot, "conflict.txt");
    await fs.writeFile(filePath, "before\n");

    await service.beginTurn("turn-1");
    await fs.writeFile(filePath, "after\n");
    await service.finalizeTurn("turn-1");
    await fs.writeFile(filePath, "user change\n");

    const result = await service.restoreTurn("turn-1");
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.conflicts, [{
      absolutePath: filePath,
      changeKind: "modified",
      reason: "current-content-changed"
    }]);
    assert.equal(result.restoredAt, undefined);
    assert.equal(service.canRestoreTurn("turn-1"), true);
    assert.equal(await fs.readFile(filePath, "utf8"), "user change\n");
  });
}

async function testDiffServiceFallsBackToFileHistoryForIgnoredFiles() {
  await withTempWorkspace(async ({ workspaceRoot, snapshotRoot }) => {
    const snapshots = new TurnSnapshotService({ workspaceRoot, snapshotRoot });
    const fileHistory = new FileHistoryManager();
    const diffService = new DiffService({
      workspaceRoot,
      fileHistoryManager: fileHistory,
      turnSnapshotService: snapshots
    });
    const visiblePath = path.join(workspaceRoot, "visible.txt");
    const ignoredPath = path.join(workspaceRoot, "ignored.log");
    await fs.writeFile(path.join(workspaceRoot, ".gitignore"), "ignored.log\n");

    fileHistory.beginTurn("turn-1");
    await snapshots.beginTurn("turn-1");
    await fileHistory.captureBeforeWrite("turn-1", ignoredPath);
    await fs.writeFile(visiblePath, "visible\n");
    await fs.writeFile(ignoredPath, "ignored\n");
    await Promise.all([
      snapshots.finalizeTurn("turn-1"),
      fileHistory.finalizeTurn("turn-1")
    ]);

    const report = await diffService.getTurnDiff("turn-1");
    assert.deepEqual(
      report.files.map((file) => [file.path, file.status]),
      [
        ["ignored.log", "added"],
        ["visible.txt", "added"]
      ]
    );
  });
}

async function withTempWorkspace(callback: (paths: {
  workspaceRoot: string;
  snapshotRoot: string;
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alyce-turn-snapshot-"));
  const workspaceRoot = path.join(root, "workspace");
  const snapshotRoot = path.join(root, "snapshots");
  await fs.mkdir(workspaceRoot, { recursive: true });
  try {
    await callback({ workspaceRoot, snapshotRoot });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

void runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
